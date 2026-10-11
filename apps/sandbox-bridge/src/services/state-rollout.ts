import { spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join } from "path";

import type { BridgeLogger } from "../logger.js";

/**
 * Cross-sandbox CLI-state rollout transport, shared by both agent runtime
 * backends. Each backend syncs ONE state subtree to the control plane's
 * per-session rollout blob:
 * - codex: `$CODEX_HOME/sessions/` (rollout JSONL; `auth.json` lives at the
 *   CODEX_HOME root, so packing only this subtree never ships credentials).
 * - claude_code: `~/.claude/projects/` (session transcripts; credentials and
 *   settings live outside this subtree).
 * - opencode: `~/.local/share/opencode/` (the whole data dir: `opencode.db`
 *   + WAL sidecars + `snapshot/`/`storage/`). Unlike codex/claude, opencode's
 *   session state and its `auth.json` share one dir, so this port relies on
 *   `excludes` to keep credentials + regenerable bloat out of the archive.
 */
const TAR_MAX_BUFFER = 256 * 1024 * 1024; // 256 MiB ceiling on archive size; rollouts are a few MB.
const TAR_TIMEOUT_MS = 30_000; // tar must not hang the bridge (pack) or cold-resume boot (extract).
const ROLLOUT_TIMEOUT_MS = 15_000;

export interface StateRolloutPort {
  /** Backend root the subtree lives under (e.g. `$CODEX_HOME` or `~/.claude`). */
  stateRoot: string;
  /** Subtree to pack/restore, relative to `stateRoot`. */
  subdir: string;
  /**
   * Paths (relative names, matched by `tar --exclude`) to keep OUT of the
   * archive when packing `subdir` — credentials and regenerable bloat that
   * must never ride the cross-sandbox blob. Undefined = pack the whole subtree
   * (codex/claude, whose credentials already live outside `subdir`).
   */
  excludes?: string[];
  /** Log-event prefix, e.g. `codex_rollout` / `claude_rollout`. */
  eventPrefix: string;
  rolloutUrl: string;
  getSandboxToken: () => string;
  fetch: typeof fetch;
  log: BridgeLogger;
}

/**
 * Whether to accept a `tar` exit code. `tar` exits `0` on success. In create
 * mode it exits `1` ("file changed as we read it") when an input file is
 * appended to mid-pack — the archive still holds a valid prefix of that file, so
 * a caller packing a live file (mid-turn rollout) opts into accepting it via
 * `allowFileChanged`. Extract must stay strict (only `0`); any other non-zero
 * code (e.g. `2`, fatal) is always rejected.
 */
export function acceptTarExit(code: number | null, opts?: { allowFileChanged?: boolean }): boolean {
  if (code === 0) return true;
  if (code === 1 && opts?.allowFileChanged) return true;
  return false;
}

/**
 * Run `tar` as an async child process: bounded by TAR_TIMEOUT_MS and TAR_MAX_BUFFER,
 * fed `input` on stdin (for extract), resolving with collected stdout (for pack).
 * Async so a large/slow/stuck tar never blocks the bridge's single event loop.
 */
function runTar(
  args: string[],
  input?: Buffer,
  opts?: { allowFileChanged?: boolean; onFileChanged?: () => void },
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdin || !stdout || !stderr) {
      child.kill("SIGKILL");
      reject(new Error("tar stdio not available"));
      return;
    }
    const chunks: Buffer[] = [];
    let outLen = 0;
    let stderrText = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("tar timed out"));
    }, TAR_TIMEOUT_MS);
    stdout.on("data", (c: Buffer) => {
      outLen += c.length;
      if (outLen > TAR_MAX_BUFFER) {
        child.kill("SIGKILL");
        reject(new Error("tar output exceeded max buffer"));
        return;
      }
      chunks.push(c);
    });
    stderr.on("data", (c: Buffer) => {
      stderrText += c.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (acceptTarExit(code, opts)) {
        // Surface the tolerated "file changed as we read it" case so a raced
        // mid-turn pack is distinguishable from a clean one in the logs.
        if (code === 1) opts?.onFileChanged?.();
        resolve(Buffer.concat(chunks));
      } else reject(new Error(`tar exited ${code}: ${stderrText.slice(0, 200)}`));
    });
    stdin.on("error", () => {
      // tar may exit (and close stdin) before we finish writing; ignore EPIPE.
    });
    stdin.end(input);
  });
}

/** Tar+gzip the state subtree under `stateRoot`. Resolves null when absent.
 * `onFileChanged` fires when tar tolerated a concurrent append (exit 1). */
export async function packStateSubtree(
  stateRoot: string,
  subdir: string,
  onFileChanged?: () => void,
  excludes?: string[],
): Promise<Buffer | null> {
  if (!existsSync(join(stateRoot, subdir))) return null;
  // `--exclude` must precede the packed path for both GNU (sandbox) and BSD
  // (dev/macOS test) tar. Keeps credentials + regenerable bloat out of the blob.
  const excludeArgs = (excludes ?? []).map((name) => `--exclude=${name}`);
  // allowFileChanged: a mid-turn persist packs the rollout JSONL the agent is
  // still appending to; tar then exits 1 ("file changed as we read it") but the
  // archive holds a valid prefix the resume reader tolerates — verified for Codex
  // 0.129.0, whose loader skips an unparseable trailing line (warn + continue)
  // rather than failing. Losing one tick to a hard failure would otherwise erode
  // the very mid-turn freshness this packing exists to provide.
  return runTar(["czf", "-", "-C", stateRoot, ...excludeArgs, subdir], undefined, {
    allowFileChanged: true,
    onFileChanged,
  });
}

/**
 * Extract a state tar.gz into `stateRoot`, restoring the packed subtree.
 * `--no-same-owner`/`--no-same-permissions` keep extraction inside the sandbox user;
 * tar's default refusal of absolute and `..` paths guards against traversal.
 */
export async function extractStateArchive(stateRoot: string, tarGz: Uint8Array): Promise<void> {
  mkdirSync(stateRoot, { recursive: true });
  const input = Buffer.isBuffer(tarGz) ? tarGz : Buffer.from(tarGz);
  await runTar(["xzf", "-", "-C", stateRoot, "--no-same-owner", "--no-same-permissions"], input);
}

/**
 * Newest mtime (ms) across the state subtree, or 0 when absent. Both CLIs append
 * to the current session's JSONL each turn, so file mtime — not directory mtime —
 * is the change signal. Callers use this to skip re-packing/uploading when
 * nothing changed.
 */
export function newestStateMtimeMs(stateRoot: string, subdir: string, excludes?: string[]): number {
  const root = join(stateRoot, subdir);
  if (!existsSync(root)) return 0;
  // Mirror the tar `--exclude=<name>` semantics so the watermark tracks only
  // files that actually ride the archive. Otherwise a credential/bloat write
  // (auth.json, log/, cache/) advances the mtime past the newest real
  // session-state file, causing redundant uploads or - on a low-resolution
  // filesystem - skipping a genuine session-state change.
  const excludeSet = new Set(excludes ?? []);
  let newest = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (excludeSet.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const m = statSync(full).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  };
  try {
    walk(root);
  } catch {
    return newest;
  }
  return newest;
}

/** Best-effort: pack the state subtree and PUT it to the control plane. Never throws. */
export async function uploadStateRollout(port: StateRolloutPort): Promise<boolean> {
  try {
    const body = await packStateSubtree(
      port.stateRoot,
      port.subdir,
      () =>
        port.log.info(
          { event: `${port.eventPrefix}.pack_file_changed` },
          "Rollout pack tolerated a concurrent append (tar file-changed); archive holds a valid prefix",
        ),
      port.excludes,
    );
    if (!body) return false;
    const res = await port.fetch(port.rolloutUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${port.getSandboxToken()}`,
        "Content-Type": "application/gzip",
      },
      body: body as unknown as BodyInit,
      signal: AbortSignal.timeout(ROLLOUT_TIMEOUT_MS),
    });
    if (!res.ok) {
      port.log.warn({ event: `${port.eventPrefix}.upload_failed`, status: res.status }, "State rollout upload failed");
      return false;
    }
    return true;
  } catch (err) {
    port.log.warn({ event: `${port.eventPrefix}.upload_error`, error: String(err) }, "State rollout upload error");
    return false;
  }
}

/** Best-effort: GET the rollout and extract it into `stateRoot` before the
 *  backend client boots. Returns true when a rollout was restored. Never throws. */
export async function restoreStateRollout(port: StateRolloutPort): Promise<boolean> {
  try {
    const res = await port.fetch(port.rolloutUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${port.getSandboxToken()}` },
      signal: AbortSignal.timeout(ROLLOUT_TIMEOUT_MS),
    });
    if (res.status === 404) return false;
    if (!res.ok) {
      port.log.warn(
        { event: `${port.eventPrefix}.restore_failed`, status: res.status },
        "State rollout restore failed",
      );
      return false;
    }
    // Mirror the pack-side TAR_MAX_BUFFER guard: never buffer an oversized
    // archive into bridge memory. Check the declared length before reading
    // and the actual bytes after.
    const declaredLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > TAR_MAX_BUFFER) {
      port.log.warn(
        { event: `${port.eventPrefix}.restore_too_large`, bytes: declaredLength },
        "State rollout restore skipped; archive exceeds max size",
      );
      return false;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0) return false;
    if (bytes.length > TAR_MAX_BUFFER) {
      port.log.warn(
        { event: `${port.eventPrefix}.restore_too_large`, bytes: bytes.length },
        "State rollout restore skipped; archive exceeds max size",
      );
      return false;
    }
    await extractStateArchive(port.stateRoot, bytes);
    port.log.info({ event: `${port.eventPrefix}.restored`, bytes: bytes.length }, "Restored state rollout");
    return true;
  } catch (err) {
    port.log.warn({ event: `${port.eventPrefix}.restore_error`, error: String(err) }, "State rollout restore error");
    return false;
  }
}

export async function persistRuntimeStateRollout(args: {
  persistRollout: (run: () => Promise<void>) => Promise<void>;
  getPort: () => StateRolloutPort;
  getLastRolloutMtimeMs: () => number;
  setLastRolloutMtimeMs: (value: number) => void;
  promptLog: BridgeLogger;
  eventPrefix: string;
  errorMessage: string;
}): Promise<void> {
  // Route through the coalescing serializer so a mid-turn periodic persist and
  // the end-of-turn persist never issue overlapping PUTs (last-writer-wins on
  // the single rollout blob could otherwise regress it to staler content).
  await args.persistRollout(async () => {
    // Best-effort and fire-and-forget: must never throw (would become an
    // unhandled rejection), so guard the whole path including port construction.
    try {
      const port = args.getPort();
      const newest = newestStateMtimeMs(port.stateRoot, port.subdir, port.excludes);
      if (newest === 0 || newest <= args.getLastRolloutMtimeMs()) return;
      const uploaded = await uploadStateRollout(port);
      if (uploaded) args.setLastRolloutMtimeMs(newest);
    } catch (err) {
      args.promptLog.warn({ event: `${args.eventPrefix}.upload_error`, error: String(err) }, args.errorMessage);
    }
  });
}

/**
 * Shared cold-resume restore for every runtime backend. Restores the persisted
 * state subtree into `stateRoot` before the backend client boots, so the
 * per-backend `resumeSession()` lookup finds the thread on disk. Behavior is
 * identical across backends; only the human-readable log messages differ (the
 * `.event` fields derive from `port.eventPrefix`), so callers pass those in.
 *
 * Warm respawn: on-disk state already exists and every uploaded archive came
 * from this disk, so it is at least as fresh as the blob. Extracting would risk
 * overwriting newer state with an older archive, so we skip and just seed the
 * watermark. Best-effort throughout: a restore failure must never block the
 * prompt.
 */
export async function prepareStateRolloutRestore(
  port: StateRolloutPort,
  opts: {
    restorableSessionId: string;
    promptLog: BridgeLogger;
    setLastRolloutMtimeMs: (value: number) => void;
    messages: { skippedLocal: string; restoreError: string; restoreMissing: string };
  },
): Promise<void> {
  let restored = false;
  try {
    const localMtimeMs = newestStateMtimeMs(port.stateRoot, port.subdir, port.excludes);
    if (localMtimeMs > 0) {
      // Seed the watermark so the next persistSession does not re-upload unchanged state.
      opts.setLastRolloutMtimeMs(localMtimeMs);
      opts.promptLog.info(
        { event: `${port.eventPrefix}.restore_skipped_local`, restorableSessionId: opts.restorableSessionId },
        opts.messages.skippedLocal,
      );
      return;
    }
    restored = await restoreStateRollout(port);
    if (restored) {
      // Restored files keep their archived mtimes; seed the watermark so the
      // first persistSession does not redundantly re-upload the same archive.
      opts.setLastRolloutMtimeMs(newestStateMtimeMs(port.stateRoot, port.subdir, port.excludes));
    }
  } catch (err) {
    opts.promptLog.warn({ event: `${port.eventPrefix}.restore_error`, error: String(err) }, opts.messages.restoreError);
  }
  if (!restored) {
    // A rollout was expected (we have a restorable session) but none was applied
    // — distinguish this missed-restore class from a normal first prompt.
    opts.promptLog.warn(
      { event: `${port.eventPrefix}.restore_missing`, restorableSessionId: opts.restorableSessionId },
      opts.messages.restoreMissing,
    );
  }
}

/**
 * Coalescing serializer for best-effort rollout uploads. The bridge persists the
 * rollout both periodically mid-turn (so a sandbox crash during a long turn still
 * leaves a recent rollout in the control plane to cold-resume from) and once at
 * turn end. Those callers can overlap, and an adapter advances its upload
 * watermark only *after* the PUT resolves — so without serialization two
 * concurrent PUTs could race the single per-session rollout blob and an older
 * archive could land last, regressing it. This runs at most one upload at a time;
 * requests that arrive while one is in flight collapse into a single trailing
 * upload that captures the latest state (using the most recent caller's closure).
 * A `run` rejection is swallowed so a best-effort upload never surfaces as an
 * unhandled rejection (the adapter persisters already catch internally).
 *
 * The returned promise is fire-and-forget: it resolves when the in-flight chain
 * drains, NOT specifically when the caller's own `run` completes — a later caller
 * can overwrite the queued run before it executes. Callers must treat persistence
 * as best-effort and must not await it to confirm their specific upload landed.
 */
export function createCoalescingPersister(): (run: () => Promise<void>) => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let queued: (() => Promise<void>) | null = null;
  return (run) => {
    if (inFlight) {
      queued = run;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        let current: (() => Promise<void>) | null = run;
        while (current) {
          try {
            await current();
          } catch {
            // best-effort: persist failures must never reject this serializer.
          }
          current = queued;
          queued = null;
        }
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}
