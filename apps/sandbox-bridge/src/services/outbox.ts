import { createHmac, timingSafeEqual } from "crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "fs";
import path from "path";

import type { BridgeEvent as SandboxEvent } from "../../../../shared/events/bridge.js";
import { OUTBOX_DIR } from "../constants/bridge.js";
import type { BridgeLogger } from "../logger.js";

/**
 * Durable, append-only, sandbox-local outbox so the bridge can redeliver
 * ACK-required critical events after a *process* restart within a live sandbox
 * (see docs plan ARC-1043).
 *
 * The file lives under `/tmp/cycloid-outbox/` and is treated as UNTRUSTED: the
 * sandbox runs the agent's shell commands as the same OS user as the bridge, so
 * the agent can read/write this file. File permissions therefore are not a trust
 * boundary. Authenticity is enforced with an HMAC over every record, keyed by a
 * per-session signing key the control plane issues over the authenticated
 * WebSocket frame (never written to disk or the agent-readable environment, and
 * stable across reconnects so a restarted bridge can still verify records it
 * wrote in a prior life). On scan, any record with a missing or invalid MAC is
 * dropped, so an agent that plants forged records cannot launder them into
 * authenticated control-plane events. Records are also size-bounded and
 * schema-checked, and the file is opened with `O_NOFOLLOW` so a planted symlink
 * cannot redirect reads/writes.
 *
 * The outbox is inert until `setSigningKey` is called (on WS activation): with
 * no key it cannot sign or verify, so it neither persists nor recovers anything.
 *
 * Never rewrite in place. Acks are recorded as append-only `event_acked`
 * tombstones; the live pending set is `event_queued` minus `event_acked`.
 */

/** Event types persisted durably. `question` is intentionally excluded: a
 * redelivered question cannot be answered after a restart (the in-memory Codex
 * resolver is gone) and the control plane already holds the original, so
 * persisting it adds no recovery value. */
const DURABLE_EVENT_TYPES = new Set<string>([
  "execution_complete",
  "final_answer",
  "patch",
  "post_execution",
  "push_complete",
  "push_error",
  "tool_call",
  "tool_result",
  "tool_update",
  "usage",
]);

function isDurableEventType(type: string): boolean {
  return DURABLE_EVENT_TYPES.has(type);
}

/** Records that the branch physically landed on the remote, even if the bridge
 * died before the `push_complete` / `post_execution` events were ever built.
 * This is the only checkpoint that synthesizes a PR-creating recovery. */
type PushResultRecord = { kind: "push_result"; messageId: string; branch?: string; commitSha?: string };
/** Records that a push was ATTEMPTED, written immediately before the blocking
 * git push call. A `push_attempt` with no later `push_result` and no
 * durably queued push outcome means the bridge died mid-push: recovery must
 * verify the remote before treating the branch as pushed, and otherwise
 * surface a failure (never synthesize success from an attempt alone). */
type PushAttemptRecord = { kind: "push_attempt"; messageId: string; branch?: string; commitSha?: string };
/** Marks a push_attempt as deliberately concluded so recovery must not
 * synthesize a second outcome for it. Some reasons suppress push_error entirely
 * (session_not_active); others already emitted a live terminal push_error that
 * should not be duplicated after restart. */
type PushAttemptResolvedRecord = { kind: "push_attempt_resolved"; messageId: string; branch?: string; reason?: string };
type EventQueuedRecord = { kind: "event_queued"; ackId: string; messageId: string; event: SandboxEvent };
type EventAckedRecord = { kind: "event_acked"; ackId: string; messageId: string };
type OutboxRecord =
  PushResultRecord | PushAttemptRecord | PushAttemptResolvedRecord | EventQueuedRecord | EventAckedRecord;

export type PendingOutboxEvent = { ackId: string; messageId: string; event: SandboxEvent };

export type OutboxScanResult = {
  /** Events that were queued but never acked, to be re-injected into pendingAckEvents. */
  pendingEvents: PendingOutboxEvent[];
  /** Per-messageId max ACK sequence seen, to restore the sequence counter so new
   * post-restart events do not collide with reloaded ackIds. */
  maxAckSequenceByMessageId: Map<string, number>;
  /** messageIds with a recorded `push_result` (branch landed on remote). */
  pushResultByMessageId: Map<string, { branch?: string; commitSha?: string }>;
  /** messageIds with a recorded `push_attempt` (push flow entered; outcome unknown). */
  pushAttemptByMessageId: Map<string, { branch?: string; commitSha?: string }>;
  /** messageIds that ever had a `post_execution` event_queued record (pending or acked). */
  queuedPostExecutionMessageIds: Set<string>;
  /** messageIds that ever had a `push_error` event_queued record (pending or
   * acked): the failure already has a durable, redeliverable surface, so
   * recovery must not synthesize a second one from the push_attempt. */
  queuedPushErrorMessageIds: Set<string>;
  /** messageIds whose push_attempt was deliberately concluded by the live path:
   * either no outcome should exist, or a live terminal event already exists and
   * must not be duplicated by recovery. */
  resolvedPushAttemptMessageIds: Set<string>;
  /** Branch-specific push_attempt conclusions for retryable probes. */
  resolvedPushAttemptBranchKeys: Set<string>;
};

// Generous guardrails against a runaway/forged file. A real post_execution can
// carry a sizeable diff summary, so these are backstops, not tight limits.
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

const VALID_SESSION_ID = /^[A-Za-z0-9._-]+$/;

export interface DurableOutboxDeps {
  sessionId: string;
  log: BridgeLogger;
  /** Override the outbox directory (tests). Defaults to OUTBOX_DIR. */
  dir?: string;
}

export class DurableOutbox {
  private readonly dir: string;
  private readonly filePath: string;
  private readonly log: BridgeLogger;
  /** When the sessionId is unsafe, durability is disabled (all ops no-op). The
   * live in-memory ACK path still works; only crash-recovery is forfeited. */
  private readonly disabled: boolean;
  private readonly liveAckIds = new Set<string>();
  private hasQueuedAny = false;
  /** Per-session HMAC key from the control plane; set on WS activation. Until it
   * is set the outbox is inert (no signing key means no authenticity), so it
   * neither persists nor recovers records. */
  private signingKey: string | null = null;

  constructor(deps: DurableOutboxDeps) {
    this.log = deps.log;
    // Read the env override live (not via the import-frozen constant) so tests
    // can isolate the outbox directory per run.
    this.dir = deps.dir ?? process.env.ARCANIST_OUTBOX_DIR ?? OUTBOX_DIR;
    if (!VALID_SESSION_ID.test(deps.sessionId)) {
      this.disabled = true;
      this.filePath = "";
      this.log.warn(
        { event: "outbox_disabled", reason: "invalid_session_id" },
        "Durable outbox disabled: sessionId is not a safe filename",
      );
      return;
    }
    this.disabled = false;
    this.filePath = path.join(this.dir, `${deps.sessionId}.ndjson`);
  }

  /** Install the per-session signing key (from the authenticated sandbox_session
   * frame), enabling durable persistence and recovery. */
  setSigningKey(key: string): void {
    if (this.disabled) return;
    if (typeof key !== "string" || key.length === 0) {
      this.log.warn({ event: "outbox_disabled", reason: "missing_signing_key" }, "Durable outbox has no signing key");
      return;
    }
    this.signingKey = key;
  }

  private isActive(): boolean {
    return !this.disabled && this.signingKey !== null;
  }

  /** Whether the outbox can persist and recover yet (enabled and a signing key
   * has been installed). Recovery waits for this before consuming its one-shot,
   * so a key that only arrives on a later reconnect still triggers recovery. */
  isReady(): boolean {
    return this.isActive();
  }

  /** HMAC-SHA256 of a record's canonical payload, hex-encoded. */
  private mac(payloadJson: string): string {
    return createHmac("sha256", this.signingKey as string)
      .update(payloadJson)
      .digest("hex");
  }

  /** Append an `event_queued` record before the event reaches the WebSocket. */
  appendEventQueued(ackId: string, messageId: string, event: SandboxEvent): void {
    if (!isDurableEventType(event.type)) return;
    const ok = this.appendLine({ kind: "event_queued", ackId, messageId, event });
    if (ok) {
      this.liveAckIds.add(ackId);
      this.hasQueuedAny = true;
    }
  }

  /** Append an `event_acked` tombstone and clean up the file once drained. Only
   * writes a tombstone for an event we actually durably queued: ACKs arrive for
   * every ACK-required event (including non-durable ones like `question`, which
   * are never queued), and writing tombstones for those would create the file
   * and accumulate orphan records that `cleanupIfDrained` could never reclaim. */
  appendEventAcked(ackId: string, messageId: string): void {
    if (!this.liveAckIds.has(ackId)) return;
    this.appendLine({ kind: "event_acked", ackId, messageId });
    this.liveAckIds.delete(ackId);
    this.cleanupIfDrained();
  }

  /** Record that the branch physically landed on the remote. Written inside the
   * push helper immediately after `git push` returns, before `push_complete`. */
  appendPushResult(messageId: string, info: { branch: string; commitSha?: string }): void {
    this.appendLine({ kind: "push_result", messageId, branch: info.branch, commitSha: info.commitSha });
  }

  /** Record that git push is about to run, after clone-token refresh has chosen
   * the branch and before the blocking push call can strand a landed branch. */
  appendPushAttempt(messageId: string, info: { branch: string; commitSha?: string }): void {
    this.appendLine({ kind: "push_attempt", messageId, branch: info.branch, commitSha: info.commitSha });
  }

  /** Mark a push_attempt as deliberately concluded (see
   * PushAttemptResolvedRecord), suppressing recovery synthesis. */
  appendPushAttemptResolved(messageId: string, reason?: string, branch?: string): void {
    this.appendLine({ kind: "push_attempt_resolved", messageId, reason, branch });
  }

  /**
   * Read and validate the outbox. Tolerates a corrupt/partial trailing line
   * (truncated mid-append on crash), oversized records, and a planted symlink.
   * Seeds the live-ack set so subsequent acks can drain and clean up.
   */
  scan(): OutboxScanResult {
    const empty: OutboxScanResult = {
      pendingEvents: [],
      maxAckSequenceByMessageId: new Map(),
      pushResultByMessageId: new Map(),
      pushAttemptByMessageId: new Map(),
      queuedPostExecutionMessageIds: new Set(),
      queuedPushErrorMessageIds: new Set(),
      resolvedPushAttemptMessageIds: new Set(),
      resolvedPushAttemptBranchKeys: new Set(),
    };
    if (!this.isActive()) return empty;

    // Open with O_NOFOLLOW and read from the fd (not a path) so a symlink swap
    // between a stat and a read cannot redirect us to an attacker-controlled
    // file: O_NOFOLLOW fails the open if the final path component is a symlink,
    // and fstat/read then operate on that same fd. Closes the TOCTOU window the
    // earlier lstat+readFileSync(path) approach left open.
    let raw: string;
    let fd: number;
    try {
      fd = openSync(this.filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return empty;
      if (code === "ELOOP") {
        this.log.warn(
          { event: "outbox_record_quarantined", reason: "symlink", path: this.filePath },
          "Outbox path is a symlink; refusing to read",
        );
        return empty;
      }
      this.log.warn({ event: "outbox_scan_failed", error: String(err) }, "Failed to open durable outbox; skipping");
      return empty;
    }
    try {
      if (fstatSync(fd).size > MAX_FILE_BYTES) {
        this.log.warn(
          { event: "outbox_record_quarantined", reason: "file_too_large" },
          "Outbox file exceeds size cap; skipping recovery",
        );
        return empty;
      }
      raw = readFileSync(fd, "utf8");
    } catch (err) {
      this.log.warn({ event: "outbox_scan_failed", error: String(err) }, "Failed to read durable outbox; skipping");
      return empty;
    } finally {
      closeSync(fd);
    }

    const queuedByAckId = new Map<string, { messageId: string; event: SandboxEvent }>();
    const ackedAckIds = new Set<string>();
    const maxSeq = new Map<string, number>();
    const pushResults = new Map<string, { branch?: string; commitSha?: string }>();
    const pushAttempts = new Map<string, { branch?: string; commitSha?: string }>();
    const queuedPostExec = new Set<string>();
    const queuedPushError = new Set<string>();
    const resolvedPushAttempts = new Set<string>();
    const resolvedPushAttemptBranchKeys = new Set<string>();
    let quarantined = 0;

    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
        quarantined++;
        continue;
      }
      const payload = this.verifyAndUnwrap(line);
      if (payload === null) {
        // Corrupt/partial line, or a missing/forged MAC (e.g. an agent-planted
        // record): skip. Authenticity is required before schema validation.
        quarantined++;
        continue;
      }
      const record = this.validateRecord(payload);
      if (!record) {
        quarantined++;
        continue;
      }
      if (record.kind === "event_queued") {
        queuedByAckId.set(record.ackId, { messageId: record.messageId, event: record.event });
        const seq = this.parseSequence(record.ackId, record.messageId, record.event.type);
        if (seq !== null) maxSeq.set(record.messageId, Math.max(maxSeq.get(record.messageId) ?? 0, seq));
        if (record.event.type === "post_execution") queuedPostExec.add(record.messageId);
        if (record.event.type === "push_error") queuedPushError.add(record.messageId);
        // A queued `push_complete` also proves the branch landed on the remote
        // (it carries branch + SHA and is emitted only after a successful push).
        // Treat it as a synthesis trigger so recovery still opens a PR even if the
        // dedicated `push_result` checkpoint fail-opened. A real `push_result`
        // record takes precedence (it sets unconditionally below).
        if (record.event.type === "push_complete" && !pushResults.has(record.messageId)) {
          const pushEvent = record.event as { branchName?: string; commitSha?: string };
          pushResults.set(record.messageId, { branch: pushEvent.branchName, commitSha: pushEvent.commitSha });
        }
      } else if (record.kind === "event_acked") {
        ackedAckIds.add(record.ackId);
      } else if (record.kind === "push_result") {
        pushResults.set(record.messageId, { branch: record.branch, commitSha: record.commitSha });
      } else if (record.kind === "push_attempt") {
        pushAttempts.set(record.messageId, { branch: record.branch, commitSha: record.commitSha });
      } else if (record.kind === "push_attempt_resolved") {
        if (record.branch) {
          resolvedPushAttemptBranchKeys.add(pushAttemptBranchKey(record.messageId, record.branch));
        } else {
          resolvedPushAttempts.add(record.messageId);
        }
      }
    }

    if (quarantined > 0) {
      this.log.warn(
        { event: "outbox_record_quarantined", count: quarantined },
        "Skipped malformed/oversized outbox records during scan",
      );
    }

    const pendingEvents: PendingOutboxEvent[] = [];
    for (const [ackId, entry] of queuedByAckId) {
      if (ackedAckIds.has(ackId)) continue;
      pendingEvents.push({ ackId, messageId: entry.messageId, event: entry.event });
      this.liveAckIds.add(ackId);
    }
    if (queuedByAckId.size > 0) this.hasQueuedAny = true;

    return {
      pendingEvents,
      maxAckSequenceByMessageId: maxSeq,
      pushResultByMessageId: pushResults,
      pushAttemptByMessageId: pushAttempts,
      queuedPostExecutionMessageIds: queuedPostExec,
      queuedPushErrorMessageIds: queuedPushError,
      resolvedPushAttemptMessageIds: resolvedPushAttempts,
      resolvedPushAttemptBranchKeys,
    };
  }

  /** Verify a line's HMAC and return the inner record payload, or null if the
   * line is corrupt, unsigned, or its MAC does not match (forged/tampered).
   * Treats any error as "invalid" rather than throwing: the file is untrusted,
   * so a single bad line must never abort recovery of the rest. */
  private verifyAndUnwrap(line: string): unknown {
    try {
      const outer = JSON.parse(line);
      if (typeof outer !== "object" || outer === null) return null;
      const { mac, payload } = outer as { mac?: unknown; payload?: unknown };
      if (typeof mac !== "string" || payload === undefined) return null;
      // Compare BYTE lengths (not JS string lengths) before timingSafeEqual,
      // which throws on unequal-length buffers. A forged 64-char multi-byte mac
      // has a 64-char JS length but a longer UTF-8 byte length; a JS-length
      // guard would let it through and make timingSafeEqual throw.
      const macBuf = Buffer.from(mac);
      const expectedBuf = Buffer.from(this.mac(JSON.stringify(payload)));
      if (macBuf.length !== expectedBuf.length) return null;
      if (!timingSafeEqual(macBuf, expectedBuf)) return null;
      return payload;
    } catch {
      return null;
    }
  }

  /** Delete the outbox file once every queued event has been acked. */
  private cleanupIfDrained(): void {
    if (!this.isActive()) return;
    if (!this.hasQueuedAny || this.liveAckIds.size > 0) return;
    try {
      rmSync(this.filePath, { force: true });
      this.hasQueuedAny = false;
    } catch (err) {
      this.log.warn({ event: "outbox_cleanup_failed", error: String(err) }, "Failed to delete drained outbox file");
    }
  }

  private appendLine(record: OutboxRecord): boolean {
    if (!this.isActive()) return false;
    let line: string;
    try {
      const payloadJson = JSON.stringify(record);
      line = JSON.stringify({ mac: this.mac(payloadJson), payload: record }) + "\n";
    } catch (err) {
      this.log.warn({ event: "outbox_append_failed", error: String(err) }, "Failed to serialize outbox record");
      return false;
    }
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > MAX_RECORD_BYTES) {
      this.log.warn(
        { event: "outbox_record_quarantined", reason: "record_too_large", kind: record.kind, bytes },
        "Outbox record exceeds size cap; not persisting",
      );
      return false;
    }
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      try {
        const st = statSync(this.filePath);
        if (st.size + bytes > MAX_FILE_BYTES) {
          this.log.warn(
            { event: "outbox_append_failed", reason: "file_cap", size: st.size },
            "Outbox file at size cap; skipping append (durability degraded)",
          );
          return false;
        }
      } catch {
        // File does not exist yet; nothing to cap.
      }
      const fd = openSync(
        this.filePath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeSync(fd, line);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      // Fail-open: durability is degraded but the live in-memory ACK path still
      // delivers the event, so never let an fs error propagate out of sendEvent.
      this.log.warn(
        { event: "outbox_append_failed", error: String(err), kind: record.kind },
        "Durable outbox append failed; continuing with in-memory delivery only",
      );
      return false;
    }
  }

  /** Light schema validation. We only need enough to keep arbitrary on-disk JSON
   * from becoming a transport event: known kind, string ids, and a durable event
   * type whose messageId matches the record. */
  private validateRecord(value: unknown): OutboxRecord | null {
    if (typeof value !== "object" || value === null) return null;
    const v = value as Record<string, unknown>;
    if (v.kind === "event_queued") {
      if (typeof v.ackId !== "string" || typeof v.messageId !== "string") return null;
      const event = v.event;
      if (typeof event !== "object" || event === null) return null;
      const e = event as Record<string, unknown>;
      if (typeof e.type !== "string" || !isDurableEventType(e.type)) return null;
      if (typeof e.messageId !== "string" || e.messageId !== v.messageId) return null;
      return { kind: "event_queued", ackId: v.ackId, messageId: v.messageId, event: event as SandboxEvent };
    }
    if (v.kind === "event_acked") {
      if (typeof v.ackId !== "string" || typeof v.messageId !== "string") return null;
      return { kind: "event_acked", ackId: v.ackId, messageId: v.messageId };
    }
    if (v.kind === "push_attempt_resolved") {
      if (typeof v.messageId !== "string") return null;
      return {
        kind: "push_attempt_resolved",
        messageId: v.messageId,
        branch: typeof v.branch === "string" ? v.branch : undefined,
        reason: typeof v.reason === "string" ? v.reason : undefined,
      };
    }
    if (v.kind === "push_result" || v.kind === "push_attempt") {
      if (typeof v.messageId !== "string") return null;
      return {
        kind: v.kind,
        messageId: v.messageId,
        branch: typeof v.branch === "string" ? v.branch : undefined,
        commitSha: typeof v.commitSha === "string" ? v.commitSha : undefined,
      };
    }
    return null;
  }

  /** Extract the ACK sequence from `{messageId}:{type}:{seq}[:{hash}]` using the
   * known messageId+type prefix, so a messageId containing ':' cannot mislead us. */
  private parseSequence(ackId: string, messageId: string, type: string): number | null {
    const prefix = `${messageId}:${type}:`;
    if (!ackId.startsWith(prefix)) return null;
    const rest = ackId.slice(prefix.length);
    const seqToken = rest.split(":")[0];
    const seq = Number.parseInt(seqToken, 10);
    return Number.isSafeInteger(seq) ? seq : null;
  }
}

export function pushAttemptBranchKey(messageId: string, branch: string): string {
  return `${messageId}\0${branch}`;
}
