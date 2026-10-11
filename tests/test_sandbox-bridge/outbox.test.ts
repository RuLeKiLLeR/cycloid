import { createHmac } from "crypto";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EVENT_BUFFER_MAX } from "../../apps/sandbox-bridge/src/constants/bridge.ts";
import { ControlPlaneSession } from "../../apps/sandbox-bridge/src/control-plane-session.ts";
import { createBridgeLogger, LOG_ORDINALS } from "../../apps/sandbox-bridge/src/logger.ts";
import { DurableOutbox } from "../../apps/sandbox-bridge/src/services/outbox.ts";
import type { BridgeEvent as SandboxEvent } from "../../shared/events/bridge.ts";

// Quiet logger (error level only); these tests never emit errors.
const log = createBridgeLogger(LOG_ORDINALS.error, {});
const KEY = "test-outbox-signing-key-0123456789abcdef";

function newDir(): string {
  return mkdtempSync(path.join(tmpdir(), "cycloid-outbox-test-"));
}

/** Construct an outbox with the signing key installed (as activation would). */
function makeOutbox(sessionId: string, dir: string, key: string = KEY): DurableOutbox {
  const outbox = new DurableOutbox({ sessionId, log, dir });
  outbox.setSigningKey(key);
  return outbox;
}

/** Serialize a record the way the outbox does on disk: `{mac, payload}` with the
 * MAC over the canonical payload JSON. Used to plant fixtures in tests. */
function signedLine(record: unknown, key: string = KEY): string {
  const payloadJson = JSON.stringify(record);
  const mac = createHmac("sha256", key).update(payloadJson).digest("hex");
  return JSON.stringify({ mac, payload: record }) + "\n";
}

function postExecutionEvent(messageId: string, ackId: string, extra: Record<string, unknown> = {}): SandboxEvent {
  return {
    type: "post_execution",
    messageId,
    ackId,
    hasChanges: true,
    pushed: true,
    branch: "feat/x",
    commitSha: "abc123",
    sandboxId: "sb-1",
    timestamp: 1,
    ...extra,
  } as SandboxEvent;
}

// Keep required checks running after a base retarget.
describe("DurableOutbox", () => {
  let dir: string;
  beforeEach(() => {
    dir = newDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("scans a queued event as pending until it is acked", () => {
    const outbox = makeOutbox("sess-1", dir);
    outbox.appendEventQueued("m1:post_execution:1:h", "m1", postExecutionEvent("m1", "m1:post_execution:1:h"));

    const scan1 = makeOutbox("sess-1", dir).scan();
    expect(scan1.pendingEvents).toHaveLength(1);
    expect(scan1.pendingEvents[0].ackId).toBe("m1:post_execution:1:h");
    expect(scan1.pendingEvents[0].event.type).toBe("post_execution");

    outbox.appendEventAcked("m1:post_execution:1:h", "m1");
    // File is deleted on drain, so a fresh scan finds nothing.
    const scan2 = makeOutbox("sess-1", dir).scan();
    expect(scan2.pendingEvents).toHaveLength(0);
  });

  it("returns the live set as queued minus acked", () => {
    const outbox = makeOutbox("sess-2", dir);
    outbox.appendEventQueued("m1:push_complete:1:h", "m1", {
      type: "push_complete",
      messageId: "m1",
      ackId: "m1:push_complete:1:h",
      branchName: "b",
      timestamp: 1,
    } as SandboxEvent);
    outbox.appendEventQueued("m1:post_execution:2:h", "m1", postExecutionEvent("m1", "m1:post_execution:2:h"));
    outbox.appendEventAcked("m1:push_complete:1:h", "m1");

    const scan = makeOutbox("sess-2", dir).scan();
    expect(scan.pendingEvents.map((e) => e.ackId)).toEqual(["m1:post_execution:2:h"]);
  });

  it("records push_result and exposes it for recovery, separate from a queued post_execution", () => {
    const outbox = makeOutbox("sess-3", dir);
    outbox.appendPushResult("m1", { branch: "feat/x", commitSha: "deadbeef" });

    const scan = makeOutbox("sess-3", dir).scan();
    expect(scan.pushResultByMessageId.get("m1")).toEqual({ branch: "feat/x", commitSha: "deadbeef" });
    expect(scan.queuedPostExecutionMessageIds.has("m1")).toBe(false);
  });

  it("derives a push trigger from a queued push_complete when no push_result checkpoint exists", () => {
    // Simulates recordPushCheckpoint fail-opening while push_complete still persisted.
    const outbox = makeOutbox("sess-pc", dir);
    outbox.appendEventQueued("m1:push_complete:1:h", "m1", {
      type: "push_complete",
      messageId: "m1",
      ackId: "m1:push_complete:1:h",
      branchName: "feat/x",
      commitSha: "abc123",
      timestamp: 1,
    } as SandboxEvent);

    const scan = makeOutbox("sess-pc", dir).scan();
    expect(scan.pushResultByMessageId.get("m1")).toEqual({ branch: "feat/x", commitSha: "abc123" });
    expect(scan.queuedPostExecutionMessageIds.has("m1")).toBe(false);
  });

  it("prefers an explicit push_result checkpoint over a push_complete-derived one", () => {
    const outbox = makeOutbox("sess-pc2", dir);
    outbox.appendPushResult("m1", { branch: "feat/checkpoint", commitSha: "check123" });
    outbox.appendEventQueued("m1:push_complete:1:h", "m1", {
      type: "push_complete",
      messageId: "m1",
      ackId: "m1:push_complete:1:h",
      branchName: "feat/event",
      commitSha: "event456",
      timestamp: 1,
    } as SandboxEvent);

    const scan = makeOutbox("sess-pc2", dir).scan();
    expect(scan.pushResultByMessageId.get("m1")).toEqual({ branch: "feat/checkpoint", commitSha: "check123" });
  });

  it("records push_attempt and exposes it for recovery, separate from push_result", () => {
    const outbox = makeOutbox("sess-pa", dir);
    outbox.appendPushAttempt("m1", { branch: "feat/x", commitSha: "abc123" });

    const scan = makeOutbox("sess-pa", dir).scan();
    expect(scan.pushAttemptByMessageId.get("m1")).toEqual({ branch: "feat/x", commitSha: "abc123" });
    expect(scan.pushResultByMessageId.has("m1")).toBe(false);
  });

  it("marks a messageId as having a queued push_error once one is written", () => {
    const outbox = makeOutbox("sess-pe", dir);
    outbox.appendPushAttempt("m1", { branch: "feat/x" });
    outbox.appendEventQueued("m1:push_error:1:h", "m1", {
      type: "push_error",
      messageId: "m1",
      ackId: "m1:push_error:1:h",
      branchName: "feat/x",
      error: "remote rejected",
      timestamp: 1,
    } as SandboxEvent);

    const scan = makeOutbox("sess-pe", dir).scan();
    expect(scan.queuedPushErrorMessageIds.has("m1")).toBe(true);
    expect(scan.pushAttemptByMessageId.has("m1")).toBe(true);
  });

  it("marks a push_attempt as resolved once a push_attempt_resolved record is written", () => {
    const outbox = makeOutbox("sess-par", dir);
    outbox.appendPushAttempt("m1", { branch: "feat/x", commitSha: "abc1234" });
    outbox.appendPushAttemptResolved("m1", "session_not_active");

    const scan = makeOutbox("sess-par", dir).scan();
    expect(scan.pushAttemptByMessageId.has("m1")).toBe(true);
    expect(scan.resolvedPushAttemptMessageIds.has("m1")).toBe(true);
  });

  it("tracks branch-specific push_attempt resolution separately from message resolution", () => {
    const outbox = makeOutbox("sess-par-branch", dir);
    outbox.appendPushAttempt("m1", { branch: "feat/x", commitSha: "abc1234" });
    outbox.appendPushAttemptResolved("m1", "branch_name_taken", "feat/x");

    const scan = makeOutbox("sess-par-branch", dir).scan();
    expect(scan.pushAttemptByMessageId.has("m1")).toBe(true);
    expect(scan.resolvedPushAttemptMessageIds.has("m1")).toBe(false);
    expect(scan.resolvedPushAttemptBranchKeys.has("m1\0feat/x")).toBe(true);
  });

  it("marks a messageId as having a queued post_execution once one is written", () => {
    const outbox = makeOutbox("sess-3b", dir);
    outbox.appendPushResult("m1", { branch: "feat/x", commitSha: "deadbeef" });
    outbox.appendEventQueued("m1:post_execution:1:h", "m1", postExecutionEvent("m1", "m1:post_execution:1:h"));

    const scan = makeOutbox("sess-3b", dir).scan();
    expect(scan.queuedPostExecutionMessageIds.has("m1")).toBe(true);
  });

  it("restores the max ACK sequence per messageId", () => {
    const outbox = makeOutbox("sess-4", dir);
    outbox.appendEventQueued("m1:execution_complete:1", "m1", {
      type: "execution_complete",
      messageId: "m1",
      ackId: "m1:execution_complete:1",
      success: true,
      sandboxId: "sb",
      timestamp: 1,
    } as SandboxEvent);
    outbox.appendEventQueued("m1:post_execution:2:h", "m1", postExecutionEvent("m1", "m1:post_execution:2:h"));

    const scan = makeOutbox("sess-4", dir).scan();
    expect(scan.maxAckSequenceByMessageId.get("m1")).toBe(2);
  });

  it("tolerates a corrupt/partial trailing line", () => {
    const outbox = makeOutbox("sess-5", dir);
    outbox.appendEventQueued("m1:post_execution:1:h", "m1", postExecutionEvent("m1", "m1:post_execution:1:h"));
    // Simulate a crash mid-append: a truncated JSON line with no newline.
    writeFileSync(path.join(dir, "sess-5.ndjson"), '{"mac":"abc","payload":{"kind":"event_q', { flag: "a" });

    const scan = makeOutbox("sess-5", dir).scan();
    expect(scan.pendingEvents.map((e) => e.ackId)).toEqual(["m1:post_execution:1:h"]);
  });

  it("skips an oversized record written directly to the file", () => {
    const file = path.join(dir, "sess-6.ndjson");
    writeFileSync(file, "x".repeat(5 * 1024 * 1024) + "\n");
    // A valid signed record after it should still be read.
    makeOutbox("sess-6", dir).appendEventQueued(
      "m1:post_execution:1:h",
      "m1",
      postExecutionEvent("m1", "m1:post_execution:1:h"),
    );

    const scan = makeOutbox("sess-6", dir).scan();
    expect(scan.pendingEvents.map((e) => e.ackId)).toEqual(["m1:post_execution:1:h"]);
  });

  it("does not persist an oversized event on append", () => {
    const outbox = makeOutbox("sess-6b", dir);
    outbox.appendEventQueued(
      "m1:post_execution:1:h",
      "m1",
      postExecutionEvent("m1", "m1:post_execution:1:h", { prBody: "y".repeat(5 * 1024 * 1024) }),
    );
    expect(makeOutbox("sess-6b", dir).scan().pendingEvents).toHaveLength(0);
  });

  it("refuses to read a symlinked outbox path", () => {
    const real = path.join(dir, "real-target.ndjson");
    writeFileSync(
      real,
      signedLine({
        kind: "event_queued",
        ackId: "m1:post_execution:1:h",
        messageId: "m1",
        event: postExecutionEvent("m1", "m1:post_execution:1:h"),
      }),
    );
    symlinkSync(real, path.join(dir, "sess-7.ndjson"));

    expect(makeOutbox("sess-7", dir).scan().pendingEvents).toHaveLength(0);
  });

  it("rejects a (properly MAC'd) record whose embedded event messageId does not match", () => {
    writeFileSync(
      path.join(dir, "sess-8.ndjson"),
      signedLine({
        kind: "event_queued",
        ackId: "a",
        messageId: "m1",
        event: { type: "post_execution", messageId: "OTHER", sandboxId: "sb", timestamp: 1, hasChanges: true },
      }),
    );
    expect(makeOutbox("sess-8", dir).scan().pendingEvents).toHaveLength(0);
  });

  it("rejects a (properly MAC'd) record carrying a non-durable event type (e.g. question)", () => {
    writeFileSync(
      path.join(dir, "sess-8b.ndjson"),
      signedLine({
        kind: "event_queued",
        ackId: "a",
        messageId: "m1",
        event: { type: "question", messageId: "m1", questionId: "q", question: "?", sandboxId: "sb", timestamp: 1 },
      }),
    );
    expect(makeOutbox("sess-8b", dir).scan().pendingEvents).toHaveLength(0);
  });

  it("does not write a tombstone (or create the file) for an ack of a never-queued event", () => {
    const outbox = makeOutbox("sess-9b", dir);
    // Ack for an event that was never durably queued (e.g. a question).
    outbox.appendEventAcked("m1:question:1", "m1");
    expect(existsSync(path.join(dir, "sess-9b.ndjson"))).toBe(false);
  });

  it("deletes the file once all queued events are acked", () => {
    const outbox = makeOutbox("sess-9", dir);
    outbox.appendEventQueued("m1:post_execution:1:h", "m1", postExecutionEvent("m1", "m1:post_execution:1:h"));
    expect(existsSync(path.join(dir, "sess-9.ndjson"))).toBe(true);
    outbox.appendEventAcked("m1:post_execution:1:h", "m1");
    expect(existsSync(path.join(dir, "sess-9.ndjson"))).toBe(false);
  });

  it("disables durability for an unsafe sessionId without creating files or throwing", () => {
    const outbox = new DurableOutbox({ sessionId: "../escape", log, dir });
    outbox.setSigningKey(KEY);
    expect(() => outbox.appendEventQueued("a", "m1", postExecutionEvent("m1", "a"))).not.toThrow();
    expect(outbox.scan().pendingEvents).toHaveLength(0);
    expect(existsSync(path.join(dir, "..", "escape.ndjson"))).toBe(false);
  });

  it("never throws out of append when the directory cannot be created (fail-open)", () => {
    // Point the outbox dir inside a regular file so mkdir fails with ENOTDIR.
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x");
    const outbox = makeOutbox("sess-10", path.join(blocker, "nested"));
    expect(() => outbox.appendEventQueued("a", "m1", postExecutionEvent("m1", "a"))).not.toThrow();
    expect(outbox.scan().pendingEvents).toHaveLength(0);
  });

  // --- Authenticity (HMAC) ---

  it("is inert (persists nothing, recovers nothing) until a signing key is set", () => {
    const noKey = new DurableOutbox({ sessionId: "sess-11", log, dir });
    noKey.appendEventQueued("m1:post_execution:1:h", "m1", postExecutionEvent("m1", "m1:post_execution:1:h"));
    expect(existsSync(path.join(dir, "sess-11.ndjson"))).toBe(false);
    expect(noKey.scan().pendingEvents).toHaveLength(0);
  });

  it("drops a record planted with no MAC wrapper (forged by an agent)", () => {
    writeFileSync(
      path.join(dir, "sess-12.ndjson"),
      JSON.stringify({
        kind: "event_queued",
        ackId: "m1:post_execution:1:h",
        messageId: "m1",
        event: postExecutionEvent("m1", "m1:post_execution:1:h"),
      }) + "\n",
    );
    expect(makeOutbox("sess-12", dir).scan().pendingEvents).toHaveLength(0);
  });

  it("drops a record signed with a different key", () => {
    writeFileSync(
      path.join(dir, "sess-13.ndjson"),
      signedLine(
        {
          kind: "event_queued",
          ackId: "m1:post_execution:1:h",
          messageId: "m1",
          event: postExecutionEvent("m1", "m1:post_execution:1:h"),
        },
        "attacker-key",
      ),
    );
    expect(makeOutbox("sess-13", dir).scan().pendingEvents).toHaveLength(0);
  });

  it("drops a record whose payload was tampered after signing", () => {
    const original = {
      kind: "event_queued",
      ackId: "m1:post_execution:1:h",
      messageId: "m1",
      event: postExecutionEvent("m1", "m1:post_execution:1:h"),
    };
    const mac = createHmac("sha256", KEY).update(JSON.stringify(original)).digest("hex");
    const tampered = { ...original, event: postExecutionEvent("m1", "m1:post_execution:1:h", { branch: "evil" }) };
    writeFileSync(path.join(dir, "sess-14.ndjson"), JSON.stringify({ mac, payload: tampered }) + "\n");
    expect(makeOutbox("sess-14", dir).scan().pendingEvents).toHaveLength(0);
  });

  it("drops a forged multi-byte mac line without aborting recovery of valid records", () => {
    // A 64-CHAR (but 128-byte) mac would pass a JS-string-length guard and make
    // timingSafeEqual throw, aborting the whole scan. It must be dropped instead,
    // and a following valid signed record must still be recovered.
    const file = path.join(dir, "sess-mb.ndjson");
    const forged = JSON.stringify({
      mac: "é".repeat(64),
      payload: { kind: "event_acked", ackId: "x", messageId: "m" },
    });
    const valid = signedLine({
      kind: "event_queued",
      ackId: "m1:post_execution:1:h",
      messageId: "m1",
      event: postExecutionEvent("m1", "m1:post_execution:1:h"),
    });
    writeFileSync(file, forged + "\n" + valid);

    const scan = makeOutbox("sess-mb", dir).scan();
    expect(scan.pendingEvents.map((e) => e.ackId)).toEqual(["m1:post_execution:1:h"]);
  });

  it("reports isReady only once a signing key is installed", () => {
    const outbox = new DurableOutbox({ sessionId: "sess-ready", log, dir });
    expect(outbox.isReady()).toBe(false);
    outbox.setSigningKey(KEY);
    expect(outbox.isReady()).toBe(true);
  });

  it("does not recover records written under a different signing key", () => {
    makeOutbox("sess-15", dir, "key-a").appendEventQueued(
      "m1:post_execution:1:h",
      "m1",
      postExecutionEvent("m1", "m1:post_execution:1:h"),
    );
    expect(makeOutbox("sess-15", dir, "key-b").scan().pendingEvents).toHaveLength(0);
  });
});

describe("ControlPlaneSession durable round-trip", () => {
  let dir: string;
  beforeEach(() => {
    dir = newDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeSession(outbox: DurableOutbox): ControlPlaneSession {
    return new ControlPlaneSession({
      sessionId: "sess-rt",
      sandboxId: "sb-1",
      setAuthToken: () => {},
      onEventSent: () => {},
      log,
      outbox,
    });
  }

  it("persists an ACK-required event and survives a simulated process restart with the same ackId", () => {
    const session1 = makeSession(makeOutbox("sess-rt", dir));
    // No ws connected: sendEvent records pending + durable, then returns.
    session1.sendEvent({
      type: "post_execution",
      messageId: "m1",
      hasChanges: true,
      pushed: true,
      branch: "feat/x",
      commitSha: "abc",
      sandboxId: "sb-1",
      timestamp: 1,
    } as SandboxEvent);

    const originalAckId = [...session1.pendingAckEvents.keys()][0];
    expect(originalAckId).toMatch(/^m1:post_execution:1:/);

    // Simulate restart: brand new outbox + session (same key + dir), recover.
    const outbox2 = makeOutbox("sess-rt", dir);
    const scan = outbox2.scan();
    const session2 = makeSession(outbox2);
    session2.restorePendingAckEvents(scan.pendingEvents, scan.maxAckSequenceByMessageId);

    expect([...session2.pendingAckEvents.keys()]).toEqual([originalAckId]);
    // Sequence counter restored so a NEW event for m1 gets sequence 2, no collision.
    session2.sendEvent({
      type: "push_complete",
      messageId: "m1",
      branchName: "feat/x",
      sandboxId: "sb-1",
      timestamp: 2,
    } as SandboxEvent);
    const newAckId = [...session2.pendingAckEvents.keys()].find((k) => k.includes(":push_complete:"));
    expect(newAckId).toMatch(/^m1:push_complete:2:/);
  });

  it("persists ACK-required structured transcript events for restart recovery", () => {
    const session1 = makeSession(makeOutbox("sess-rt", dir));
    session1.sendEvent({
      type: "tool_call",
      tool: "bash",
      args: { command: "npm test" },
      callId: "call-1",
      messageId: "m1",
      sandboxId: "sb-1",
      timestamp: 1,
    } as SandboxEvent);

    const originalAckId = [...session1.pendingAckEvents.keys()][0];
    expect(originalAckId).toMatch(/^m1:tool_call:1:/);

    const scan = makeOutbox("sess-rt", dir).scan();
    expect(scan.pendingEvents).toHaveLength(1);
    expect(scan.pendingEvents[0].ackId).toBe(originalAckId);
    expect(scan.pendingEvents[0].event.type).toBe("tool_call");
  });

  it("hashes structured transcript ackIds so post-restart events do not collide", () => {
    const toolCallEvent = (command: string, timestamp: number): SandboxEvent =>
      ({
        type: "tool_call",
        tool: "bash",
        args: { command },
        callId: `call-${timestamp}`,
        messageId: "m1",
        sandboxId: "sb-1",
        timestamp,
      }) as SandboxEvent;
    const ackIdOf = (event: SandboxEvent): string | undefined => (event as { ackId?: string }).ackId;

    const session1 = makeSession(makeOutbox("sess-rt", dir));
    const firstAckId = ackIdOf(session1.withAckId(toolCallEvent("npm test", 1)));

    const session2 = makeSession(makeOutbox("sess-rt", dir));
    const secondAckId = ackIdOf(session2.withAckId(toolCallEvent("npm run lint", 2)));

    expect(firstAckId).toMatch(/^m1:tool_call:1:/);
    expect(secondAckId).toMatch(/^m1:tool_call:1:/);
    expect(firstAckId).not.toBe(secondAckId);

    const session3 = makeSession(makeOutbox("sess-rt", dir));
    const replayAckId = ackIdOf(session3.withAckId(toolCallEvent("npm test", 1)));
    expect(replayAckId).toBe(firstAckId);
  });

  it("hashes question ackIds so a post-restart question is not deduped onto an earlier one", () => {
    const questionEvent = (questionId: string, question: string, timestamp: number): SandboxEvent =>
      ({ type: "question", messageId: "m1", questionId, question, sandboxId: "sb-1", timestamp }) as SandboxEvent;
    const ackIdOf = (event: SandboxEvent): string | undefined => (event as { ackId?: string }).ackId;

    const session1 = makeSession(makeOutbox("sess-rt", dir));
    const q1 = ackIdOf(session1.withAckId(questionEvent("qA", "Which file?", 1)));

    // Simulate a bridge restart: questions are not durable, so the fresh
    // session's in-memory ackSequenceByMessageId resets to 1 for m1.
    const session2 = makeSession(makeOutbox("sess-rt", dir));
    const q2 = ackIdOf(session2.withAckId(questionEvent("qB", "Which branch?", 2)));

    // Same messageId, same reset sequence (1), but distinct payload → distinct
    // ackId, so the DO eventId differs and the new question is not deduped away.
    expect(q1).toMatch(/^m1:question:1:/);
    expect(q2).toMatch(/^m1:question:1:/);
    expect(q1).not.toBe(q2);

    // An exact replay of the same question still collides — a true replay, correctly deduped.
    const session3 = makeSession(makeOutbox("sess-rt", dir));
    const q1Replay = ackIdOf(session3.withAckId(questionEvent("qA", "Which file?", 1)));
    expect(q1Replay).toBe(q1);
  });

  it("flushes buffered events before redelivering unacked completions on activation", () => {
    const session = makeSession(makeOutbox("sess-rt", dir));
    const order: string[] = [];
    vi.spyOn(session, "flushEventBuffer").mockImplementation(() => {
      order.push("flush");
    });
    vi.spyOn(session, "resendPendingAckEvents").mockImplementation(() => {
      order.push("resend");
    });

    session.activateSandboxSession(
      { type: "sandbox_session", sessionKey: "key-1", connectionGeneration: 1, nextAuthToken: "tok-1" },
      () => {},
    );

    // Buffered (non-ack) token stream must flush before the completion redelivery
    // that logically closes it, so the UI timeline stays ordered on reconnect.
    expect(order).toEqual(["flush", "resend"]);
  });

  it("drops the oldest buffered event on overflow, keeping the newest", () => {
    const session = makeSession(makeOutbox("sess-rt", dir));
    const warn = vi.spyOn(log, "warn");
    const makeEvent = (seq: number): SandboxEvent =>
      ({ type: "tool_call_delta", messageId: "m1", sandboxId: "sb-1", timestamp: seq, seq }) as unknown as SandboxEvent;

    const overflow = 3;
    for (let i = 0; i < EVENT_BUFFER_MAX + overflow; i++) {
      session.enqueueEventBuffer(makeEvent(i));
    }

    expect(session.eventBuffer).toHaveLength(EVENT_BUFFER_MAX);
    // The newest EVENT_BUFFER_MAX events are retained; the oldest `overflow` dropped.
    const seqOf = (event: SandboxEvent): number => (event as unknown as { seq: number }).seq;
    expect(seqOf(session.eventBuffer[0])).toBe(overflow);
    expect(seqOf(session.eventBuffer[session.eventBuffer.length - 1])).toBe(EVENT_BUFFER_MAX + overflow - 1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "dropped_oldest" }), expect.any(String));
  });

  it("appends an ack tombstone and drains the file when the event is acked", () => {
    const session = makeSession(makeOutbox("sess-rt", dir));
    session.sendEvent({
      type: "post_execution",
      messageId: "m1",
      hasChanges: true,
      pushed: true,
      sandboxId: "sb-1",
      timestamp: 1,
    } as SandboxEvent);
    const ackId = [...session.pendingAckEvents.keys()][0];
    expect(existsSync(path.join(dir, "sess-rt.ndjson"))).toBe(true);

    session.handleAckMessage({ type: "ack", ackId } as never);
    expect(session.pendingAckEvents.size).toBe(0);
    expect(existsSync(path.join(dir, "sess-rt.ndjson"))).toBe(false);
  });

  it("queueRecoveredEvent persists and queues without sending (so the activation resend delivers it once)", () => {
    const session = makeSession(makeOutbox("sess-rt", dir));
    const sends: string[] = [];
    session.ws = {
      readyState: 1,
      send: (data: string) => sends.push(data),
      on: () => {},
      close: () => {},
      ping: () => {},
    } as never;
    session.sandboxSessionKey = "k";

    session.queueRecoveredEvent({
      type: "post_execution",
      messageId: "m1",
      ackId: "m1:post_execution:recovery",
      hasChanges: true,
      pushed: true,
      sandboxId: "sb-1",
      timestamp: 1,
    } as SandboxEvent);

    // Queued + persisted, but NOT sent yet (the activation resend will send it).
    expect(sends).toHaveLength(0);
    expect(session.pendingAckEvents.has("m1:post_execution:recovery")).toBe(true);
    // The activation resend delivers it exactly once.
    session.resendPendingAckEvents();
    expect(sends).toHaveLength(1);
  });

  it("does not persist a question event (excluded from the durable set)", () => {
    const session = makeSession(makeOutbox("sess-rt", dir));
    session.sendEvent({
      type: "question",
      questionId: "q1",
      question: "pick one",
      messageId: "m1",
      sandboxId: "sb-1",
      timestamp: 1,
    } as SandboxEvent);
    // Pending in memory (ACK-required) but NOT persisted durably.
    expect(session.pendingAckEvents.size).toBe(1);
    expect(makeOutbox("sess-rt", dir).scan().pendingEvents).toHaveLength(0);
  });
});
