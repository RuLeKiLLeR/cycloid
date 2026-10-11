import { describe, expect, it, vi } from "vitest";

import { handleRespond, type QuestionReplyDeps } from "../../apps/sandbox-bridge/src/services/question-reply.ts";
import type { BridgeEvent as SandboxEvent } from "../../shared/events/bridge.ts";

function makeDeps(overrides: Partial<QuestionReplyDeps> = {}): {
  deps: QuestionReplyDeps;
  events: SandboxEvent[];
  resolvedIds: Set<string>;
} {
  const events: SandboxEvent[] = [];
  const resolvedIds = new Set<string>();
  const log = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as QuestionReplyDeps["log"];
  const deps: QuestionReplyDeps = {
    getClient: () => null,
    sendEvent: (event) => events.push(event),
    sandboxId: "sbx_test",
    log,
    getPendingQuestion: () => null,
    setPendingQuestion: vi.fn(),
    isQuestionResolved: (id) => resolvedIds.has(id),
    markQuestionResolved: (id) => {
      resolvedIds.add(id);
    },
    ...overrides,
  };
  return { deps, events, resolvedIds };
}

describe("handleRespond error events name the residual failure (D9: never 'unknown')", () => {
  it("emits question_delivery_failed when the client is unavailable for a pending question", async () => {
    const resolve = vi.fn();
    const { deps, events } = makeDeps({
      getClient: () => null,
      getPendingQuestion: () => ({ id: "q1", resolve }),
    });

    handleRespond(deps, "the answer");
    await vi.waitFor(() => expect(events).toHaveLength(1));

    expect(events[0]).toMatchObject({
      type: "error",
      code: "question_delivery_failed",
      messageId: "q1",
      sandboxId: "sbx_test",
    });
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("emits question_delivery_failed when the Codex reply is rejected", async () => {
    const resolve = vi.fn();
    const reply = vi.fn().mockResolvedValue({ data: { ok: false } });
    const { deps, events } = makeDeps({
      getClient: () => ({ question: { reply } }) as never,
      getPendingQuestion: () => ({ id: "q2", resolve }),
    });

    handleRespond(deps, "the answer");
    await vi.waitFor(() => expect(events).toHaveLength(1));

    expect(events[0]).toMatchObject({ type: "error", code: "question_delivery_failed", messageId: "q2" });
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("emits question_delivery_failed on the DO-mediated flow when no parent is pending and the reply throws", async () => {
    const reply = vi.fn().mockRejectedValue(new Error("boom"));
    const { deps, events } = makeDeps({
      getClient: () => ({ question: { reply } }) as never,
      getPendingQuestion: () => null,
    });

    handleRespond(deps, "answer", "do-req");
    await vi.waitFor(() => expect(events).toHaveLength(1));

    expect(events[0]).toMatchObject({ type: "error", code: "question_delivery_failed", messageId: "do-req" });
  });

  it("emits question_delivery_failed when a child-session reply throws", async () => {
    const parentResolve = vi.fn();
    const reply = vi.fn().mockRejectedValue(new Error("boom"));
    const { deps, events } = makeDeps({
      getClient: () => ({ question: { reply } }) as never,
      getPendingQuestion: () => ({ id: "parent", resolve: parentResolve }),
    });

    handleRespond(deps, "child answer", "child-req");
    await vi.waitFor(() => expect(events).toHaveLength(1));

    expect(events[0]).toMatchObject({ type: "error", code: "question_delivery_failed", messageId: "child-req" });
    // parent question stays pending for the child branch
    expect(parentResolve).not.toHaveBeenCalled();
  });

  it("never emits the generic 'unknown' code on a delivery failure", async () => {
    const { deps, events } = makeDeps({
      getClient: () => null,
      getPendingQuestion: () => ({ id: "q3", resolve: vi.fn() }),
    });

    handleRespond(deps, "answer");
    await vi.waitFor(() => expect(events).toHaveLength(1));

    expect(events[0]).toMatchObject({ type: "error", code: "question_delivery_failed" });
    expect(events.every((e) => "code" in e && e.code != null && e.code !== "unknown")).toBe(true);
  });
});

describe("handleRespond is idempotent for redelivered answers (9.3)", () => {
  it("marks a delivered parent question resolved so a redelivery is suppressed", async () => {
    const resolve = vi.fn();
    const reply = vi.fn().mockResolvedValue({ data: { ok: true } });
    const pending: { id: string; resolve: () => void } | null = { id: "q1", resolve };
    const { deps, events, resolvedIds } = makeDeps({
      getClient: () => ({ question: { reply } }) as never,
      getPendingQuestion: () => pending,
      setPendingQuestion: vi.fn(),
    });

    handleRespond(deps, "the answer", "q1");
    await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolvedIds.has("q1")).toBe(true);
    expect(events).toHaveLength(0);
  });

  it("ignores a redelivered answer for an already-resolved question (no duplicate reply, no error)", async () => {
    const reply = vi.fn().mockResolvedValue({ data: { ok: true } });
    // No pending question (the agent already moved on); the id is already resolved.
    const { deps, events } = makeDeps({
      getClient: () => ({ question: { reply } }) as never,
      getPendingQuestion: () => null,
      isQuestionResolved: (id) => id === "q1",
    });

    handleRespond(deps, "the answer", "q1");
    // Give any (incorrect) async reply a chance to fire.
    await Promise.resolve();
    await Promise.resolve();

    expect(reply).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("delivers the first DO-mediated answer then suppresses its redelivery", async () => {
    const reply = vi.fn().mockResolvedValue({ data: { ok: true } });
    const { deps, events, resolvedIds } = makeDeps({
      getClient: () => ({ question: { reply } }) as never,
      getPendingQuestion: () => null,
    });

    // First delivery (DO-mediated, no local pending question) replies and marks resolved.
    handleRespond(deps, "the answer", "do-req");
    await vi.waitFor(() => expect(resolvedIds.has("do-req")).toBe(true));
    expect(reply).toHaveBeenCalledOnce();

    // Redelivery of the same answer is a benign no-op: no second reply, no error event.
    handleRespond(deps, "the answer", "do-req");
    await Promise.resolve();
    await Promise.resolve();
    expect(reply).toHaveBeenCalledOnce();
    expect(events).toHaveLength(0);
  });
});
