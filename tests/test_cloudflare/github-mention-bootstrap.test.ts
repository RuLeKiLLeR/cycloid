import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../../apps/control-plane-worker/src/types";
import type { WorkerModule } from "./helpers/worker-harness";

type SessionBindingRow = {
  sessionId: string;
  agentRole: string | null;
  businessId: string | null;
};

const mocks = vi.hoisted(() => ({
  getTrackingSessionIdForPrUrl: vi.fn<(db: D1Database, prUrl: string) => Promise<string | null>>(),
}));

vi.mock("../../apps/control-plane-worker/src/session/pr-coordination-db", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../apps/control-plane-worker/src/session/pr-coordination-db")>();
  return {
    ...actual,
    getTrackingSessionIdForPrUrl: mocks.getTrackingSessionIdForPrUrl,
  };
});

import { resolveEligibleImplementationSession } from "../../apps/control-plane-worker/src/services/github-mention-bootstrap";
import { createWorkerEnv, restoreSmokeTestFetchMock } from "../smoke/helpers";

const PR_URL = "https://github.com/trycycloid/cycloid/pull/1515";
const ACTOR_BUSINESS_ID = "business-actor";

class TestDurableObject {
  constructor(_state: unknown, _env: unknown) {}

  async fetch(): Promise<Response> {
    return new Response();
  }
}

const workerModule: WorkerModule = {
  default: {
    async fetch(): Promise<Response> {
      return new Response();
    },
  },
  SessionDO: TestDurableObject,
  SessionResumeRateLimiterDO: TestDurableObject,
};

let env: Pick<Env, "DB">;
let db: ReturnType<typeof createWorkerEnv>["db"];
let sessionRows: Map<string, SessionBindingRow>;

function bindSessions(...sessionIds: string[]): void {
  db.sessionWebhookRefs.set(`github_pr_url:${PR_URL}`, new Set(sessionIds));
}

function addSession(sessionId: string, businessId: string, agentRole: string | null = "implementation"): void {
  sessionRows.set(sessionId, { sessionId, businessId, agentRole });
}

function installSessionBindingRead(): void {
  const prepare = db.prepare.bind(db);
  db.prepare = ((query: string) => {
    if (!query.includes("SELECT session_id, agent_role, business_id FROM session_index")) {
      return prepare(query);
    }

    db.preparedQueries.push(query);
    let boundSessionIds: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        boundSessionIds = values;
        return statement;
      },
      async all() {
        return {
          results: boundSessionIds.flatMap((sessionId) => {
            if (typeof sessionId !== "string") return [];
            const row = sessionRows.get(sessionId);
            return row ? [{ session_id: row.sessionId, agent_role: row.agentRole, business_id: row.businessId }] : [];
          }),
        };
      },
    };
    return statement as unknown as ReturnType<typeof db.prepare>;
  }) as typeof db.prepare;
}

beforeEach(() => {
  vi.clearAllMocks();
  const created = createWorkerEnv(workerModule);
  env = created.env as Pick<Env, "DB">;
  db = created.db;
  sessionRows = new Map();
  installSessionBindingRead();
  mocks.getTrackingSessionIdForPrUrl.mockResolvedValue(null);
});

afterEach(() => {
  restoreSmokeTestFetchMock();
});

describe("resolveEligibleImplementationSession", () => {
  it("uses the tracking winner when it is eligible", async () => {
    mocks.getTrackingSessionIdForPrUrl.mockResolvedValue("tracked-session");
    addSession("tracked-session", ACTOR_BUSINESS_ID);
    addSession("ref-session", ACTOR_BUSINESS_ID);
    bindSessions("ref-session");

    await expect(
      resolveEligibleImplementationSession(env, { prUrl: PR_URL, actorBusinessId: ACTOR_BUSINESS_ID }),
    ).resolves.toEqual({ kind: "eligible", sessionId: "tracked-session" });
    expect(
      db.preparedQueries.some(
        (query) =>
          query.includes("SELECT session_id, agent_role, business_id FROM session_index") &&
          query.includes("WHERE session_id IN (?)"),
      ),
    ).toBe(true);
    expect(db.preparedQueries.some((query) => query.includes("FROM session_webhook_refs"))).toBe(false);
  });

  it("returns one eligible session from webhook refs", async () => {
    addSession("session-1", ACTOR_BUSINESS_ID);
    bindSessions("session-1");

    await expect(
      resolveEligibleImplementationSession(env, { prUrl: PR_URL, actorBusinessId: ACTOR_BUSINESS_ID }),
    ).resolves.toEqual({ kind: "eligible", sessionId: "session-1" });
  });

  it("treats a legacy null role as an implementation session", async () => {
    addSession("legacy-session", ACTOR_BUSINESS_ID, null);
    bindSessions("legacy-session");

    await expect(
      resolveEligibleImplementationSession(env, { prUrl: PR_URL, actorBusinessId: ACTOR_BUSINESS_ID }),
    ).resolves.toEqual({ kind: "eligible", sessionId: "legacy-session" });
  });

  it("filters a verifier-only binding", async () => {
    addSession("verifier", ACTOR_BUSINESS_ID, "verification");
    bindSessions("verifier");

    await expect(
      resolveEligibleImplementationSession(env, { prUrl: PR_URL, actorBusinessId: ACTOR_BUSINESS_ID }),
    ).resolves.toEqual({ kind: "none" });
  });

  it("filters a reviewer-only binding", async () => {
    addSession("reviewer", ACTOR_BUSINESS_ID, "review");
    bindSessions("reviewer");

    await expect(
      resolveEligibleImplementationSession(env, { prUrl: PR_URL, actorBusinessId: ACTOR_BUSINESS_ID }),
    ).resolves.toEqual({ kind: "none" });
  });

  it("returns other_business for a binding owned by another business", async () => {
    addSession("other-session", "business-other");
    bindSessions("other-session");

    await expect(
      resolveEligibleImplementationSession(env, { prUrl: PR_URL, actorBusinessId: ACTOR_BUSINESS_ID }),
    ).resolves.toEqual({ kind: "other_business", sessionId: "other-session" });
  });

  it("returns the same-business session when mixed with a verifier", async () => {
    addSession("verifier", ACTOR_BUSINESS_ID, "verification");
    addSession("implementation", ACTOR_BUSINESS_ID);
    bindSessions("verifier", "implementation");

    await expect(
      resolveEligibleImplementationSession(env, { prUrl: PR_URL, actorBusinessId: ACTOR_BUSINESS_ID }),
    ).resolves.toEqual({ kind: "eligible", sessionId: "implementation" });
  });

  it("returns ambiguous for two same-business implementation sessions", async () => {
    addSession("session-1", ACTOR_BUSINESS_ID);
    addSession("session-2", ACTOR_BUSINESS_ID);
    bindSessions("session-1", "session-2");

    await expect(
      resolveEligibleImplementationSession(env, { prUrl: PR_URL, actorBusinessId: ACTOR_BUSINESS_ID }),
    ).resolves.toEqual({ kind: "ambiguous" });
  });

  it("returns none when the PR has no binding", async () => {
    await expect(
      resolveEligibleImplementationSession(env, { prUrl: PR_URL, actorBusinessId: ACTOR_BUSINESS_ID }),
    ).resolves.toEqual({ kind: "none" });
    expect(
      db.preparedQueries.some((query) =>
        query.includes("SELECT session_id, agent_role, business_id FROM session_index"),
      ),
    ).toBe(false);
  });
});
