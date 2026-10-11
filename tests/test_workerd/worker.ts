import { DurableObject } from "cloudflare:workers";

import { dispatchQueueBatch } from "../../apps/control-plane-worker/src/queue-dispatch.js";
import { createSession, getReplayEvents } from "../../apps/control-plane-worker/src/session/do-db.js";
import { SessionDO } from "../../apps/control-plane-worker/src/session/durable-object.js";
import {
  appendDurableEvents,
  projectCycloidEventToDurableEntry,
} from "../../apps/control-plane-worker/src/session/events.js";
import { initSchema } from "../../apps/control-plane-worker/src/session/schema.js";
import type { Env } from "../../apps/control-plane-worker/src/types.js";
import { validateCycloidEvent } from "../../shared/events/schema.js";

export { SessionDO };

export class TestSessionStorageDO extends DurableObject<Cloudflare.Env> {
  declare state: DurableObjectState;

  constructor(state: DurableObjectState, env: Cloudflare.Env) {
    super(state, env);
    this.state = state;
    void this.ctx.blockConcurrencyWhile(async () => {
      initSchema(this.state.storage.sql);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/create") {
      const body = (await request.json()) as { sessionId: string; ownerUserId: string; businessId: string };
      const session = createSession(this.state.storage.sql, {
        sessionId: body.sessionId,
        ownerUserId: body.ownerUserId,
        businessId: body.businessId,
        repoOwner: "trycycloid",
        repoName: "cycloid",
      });
      return Response.json({ ok: true, session });
    }

    if (request.method === "POST" && url.pathname === "/append") {
      const rawEvent = (await request.json()) as unknown;
      const event = validateCycloidEvent(rawEvent);
      const entry = projectCycloidEventToDurableEntry(event);
      if (!entry) return Response.json({ ok: false, error: "event did not project" }, { status: 400 });
      const result = await appendDurableEvents(this.state, event.sessionId, [entry], event.promptId, {
        includeEvents: false,
      });
      return Response.json({ ok: true, replay: result.replay, newReplayEvents: result.newReplayEvents ?? [] });
    }

    if (request.method === "GET" && url.pathname === "/replay") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) return Response.json({ ok: false, error: "missing sessionId" }, { status: 400 });
      const events = getReplayEvents(this.state.storage.sql, sessionId);
      return Response.json({ ok: true, events });
    }

    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }
}

export default {
  async fetch(): Promise<Response> {
    return Response.json({ ok: true });
  },
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    await dispatchQueueBatch(batch, env);
  },
};
