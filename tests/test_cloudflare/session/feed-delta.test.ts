import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../../../apps/control-plane-worker/src/types";
import { createFakeState, mockCloudflareWorkers, mockSentryCloudflare, seedSession } from "./helpers";

mockCloudflareWorkers();
mockSentryCloudflare();

type FeedModule = typeof import("../../../apps/control-plane-worker/src/session/feed-delta");

let feedFetch: ReturnType<typeof vi.fn>;
let idFromName: ReturnType<typeof vi.fn>;

function feedEnv(extra: Partial<Env> = {}): Env {
  feedFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  idFromName = vi.fn().mockImplementation((name: string) => `id:${name}`);
  return {
    SESSION_FEED: { idFromName, get: vi.fn().mockReturnValue({ fetch: feedFetch }) },
    ...extra,
  } as unknown as Env;
}

function publishedBody(): Record<string, unknown> {
  expect(feedFetch).toHaveBeenCalledTimes(1);
  return JSON.parse(feedFetch.mock.calls[0][1].body as string);
}

describe("feed-delta publishers", () => {
  let mod: FeedModule;

  beforeAll(async () => {
    mod = await import("../../../apps/control-plane-worker/src/session/feed-delta");
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("publishSessionFeedDelta (DO SQLite path)", () => {
    it("resolves the gate envelope from the session row and routes by businessId", () => {
      const state = createFakeState();
      seedSession(state.storage, {
        sessionId: "s-1",
        ownerUserId: "owner-1",
        businessId: "biz-1",
        repoOwner: "Acme",
        repoName: "Widgets",
      });
      const env = feedEnv();

      mod.publishSessionFeedDelta(env, state.storage.sql, {
        type: "session_status",
        sessionId: "s-1",
        source: "status:agent",
        phase: "running",
      });

      expect(idFromName).toHaveBeenCalledWith("biz-1");
      expect(publishedBody()).toMatchObject({
        type: "session_status",
        sessionId: "s-1",
        ownerUserId: "owner-1",
        repoOwner: "Acme",
        repoName: "Widgets",
        source: "status:agent",
        phase: "running",
      });
    });

    it("is a no-op when the session row is absent", () => {
      const state = createFakeState();
      const env = feedEnv();
      mod.publishSessionFeedDelta(env, state.storage.sql, {
        type: "session_status",
        sessionId: "missing",
        source: "status",
        phase: "running",
      });
      expect(feedFetch).not.toHaveBeenCalled();
    });
  });

  describe("publishSessionUpsertedFromDb (D1 path)", () => {
    const sessionRow = {
      session_id: "s-1",
      owner_user_id: 42,
      business_id: "biz-1",
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      closed_at: null,
      last_event_id: null,
      title: "demo",
      rich_status: "idle",
      repo_owner: "acme",
      repo_name: "widgets",
      initiation_mode: "user",
      pr_url: null,
      pr_draft: null,
    };

    function dbReturning(row: unknown): D1Database {
      const first = vi.fn().mockResolvedValue(row);
      const bind = vi.fn().mockReturnValue({ first });
      return { prepare: vi.fn().mockReturnValue({ bind }) } as unknown as D1Database;
    }

    it("reads the row, runs toSessionApiShape, and publishes session_upserted", async () => {
      const db = dbReturning(sessionRow);
      const env = feedEnv({ DB: db });

      await mod.publishSessionUpsertedFromDb(env, db, "s-1", "session-create");

      expect(idFromName).toHaveBeenCalledWith("biz-1");
      const body = publishedBody();
      expect(body).toMatchObject({
        type: "session_upserted",
        sessionId: "s-1",
        ownerUserId: "42",
        repoOwner: "acme",
        repoName: "widgets",
        source: "session-create",
      });
      expect(body.session).toMatchObject({ sessionId: "s-1", phase: "idle", title: "demo", prUrl: null });
    });

    it("is a no-op (and never throws) when the row is missing", async () => {
      const db = dbReturning(null);
      const env = feedEnv({ DB: db });
      await expect(mod.publishSessionUpsertedFromDb(env, db, "missing", "session-create")).resolves.toBeUndefined();
      expect(feedFetch).not.toHaveBeenCalled();
    });

    it("publishSessionClosedFromDb reads repo context from D1 and publishes session_closed", async () => {
      const db = dbReturning(sessionRow);
      const env = feedEnv({ DB: db });

      await mod.publishSessionClosedFromDb(env, db, "s-1", "routes.sessions.close");

      expect(idFromName).toHaveBeenCalledWith("biz-1");
      expect(publishedBody()).toMatchObject({
        type: "session_closed",
        sessionId: "s-1",
        ownerUserId: "42",
        repoOwner: "acme",
        repoName: "widgets",
        source: "routes.sessions.close",
        phase: "archived",
      });
    });

    it("publishSessionClosedFromDb never throws when the D1 read throws (must not fail the delete)", async () => {
      const first = vi.fn().mockRejectedValue(new Error("D1 unavailable"));
      const db = {
        prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first }) }),
      } as unknown as D1Database;
      const env = feedEnv({ DB: db });
      await expect(mod.publishSessionClosedFromDb(env, db, "s-1", "routes.sessions.close")).resolves.toBeUndefined();
      expect(feedFetch).not.toHaveBeenCalled();
    });
  });
});
