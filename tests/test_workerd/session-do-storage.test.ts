import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { CycloidEvent } from "../../shared/events/schema.js";
import {
  flattenSessionEvents,
  getRawSessionEventData,
  getRawSessionEventKind,
} from "../../shared/transcript/projector.js";

async function json<T>(response: Response): Promise<T> {
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

function storageStub(name: string): DurableObjectStub {
  return env.TEST_SESSION_STORAGE.get(env.TEST_SESSION_STORAGE.idFromName(name));
}

describe("workerd SessionDO storage", () => {
  it("initializes the real SessionDO binding and persists replay metadata in DO SQLite", async () => {
    const sessionId = "sess-real-session-do";
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));

    const initialized = await json<{
      ok: true;
      session: { sessionId: string; planMode: boolean; planApprovalRequired: boolean };
      replay: { lastEventSequence: number };
    }>(
      await stub.fetch("https://session-do.test/session/initialize", {
        method: "POST",
        body: JSON.stringify({
          sessionId,
          ownerUserId: "42",
          businessId: "biz-workerd",
          repoOwner: "trycycloid",
          repoName: "cycloid",
          planMode: true,
          planApprovalRequired: true,
        }),
      }),
    );
    expect(initialized.session.sessionId).toBe(sessionId);
    expect(initialized.session).toMatchObject({ planMode: true, planApprovalRequired: true });
    expect(initialized.replay.lastEventSequence).toBe(0);

    await evictDurableObject(stub);
    const state = await json<{
      ok: true;
      session: { sessionId: string; planMode: boolean; planApprovalRequired: boolean };
    }>(await stub.fetch("https://session-do.test/session/state"));
    expect(state.session).toMatchObject({ sessionId, planMode: true, planApprovalRequired: true });

    const replay = await json<{ ok: true; replay: { sessionId: string; lastEventSequence: number } }>(
      await stub.fetch("https://session-do.test/session/replay"),
    );
    expect(replay.replay).toMatchObject({ sessionId, lastEventSequence: 0 });
  });

  it("round-trips a canonical replay frame through real DO SQLite and the transcript projector", async () => {
    const sessionId = "sess-workerd-storage";
    const promptId = "prompt-workerd-storage";
    const event: CycloidEvent<"text.delta"> = {
      phase: "text.delta",
      timestampMs: 1760000000000,
      sessionId,
      promptId,
      sandboxId: "sbx-workerd-storage",
      payload: {
        channel: "output",
        text: "stored under workerd",
        partId: "text-workerd-1",
        bridgeEventType: "text",
        bridgeData: { streamId: "stream-workerd" },
      },
    };
    const stub = storageStub(sessionId);

    await json(
      await stub.fetch("https://storage-do.test/create", {
        method: "POST",
        body: JSON.stringify({ sessionId, ownerUserId: "42", businessId: "biz-workerd" }),
      }),
    );
    const append = await json<{ ok: true; newReplayEvents: unknown[] }>(
      await stub.fetch("https://storage-do.test/append", {
        method: "POST",
        body: JSON.stringify(event),
      }),
    );
    expect(append.newReplayEvents).toHaveLength(1);

    await evictDurableObject(stub);

    const replay = await json<{ ok: true; events: CycloidEvent[] }>(
      await stub.fetch(`https://storage-do.test/replay?sessionId=${sessionId}`),
    );
    expect(replay.events).toHaveLength(1);
    expect(getRawSessionEventKind(replay.events[0])).toBe("text");
    expect(getRawSessionEventData(replay.events[0])).toMatchObject({
      id: "text-workerd-1",
      promptId,
      text: "stored under workerd",
    });
    expect(flattenSessionEvents(replay.events)).toEqual([
      expect.objectContaining({ type: "text", id: "text-workerd-1", text: "stored under workerd" }),
    ]);
  });
});
