import { beforeAll, describe, expect, it } from "vitest";

import { upsertSessionPlan } from "../../../apps/control-plane-worker/src/session/do-db";
import type { InternalAuthContext, SessionState } from "../../../apps/control-plane-worker/src/types";
import {
  FakeDurableState,
  FakeSqlStorage,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  type WorkerModule,
} from "../helpers/worker-harness";

mockCloudflareWorkers();
mockSentryCloudflare();

type SessionDOTestHandle = {
  fetch(request: Request): Promise<Response>;
  parseAuthHeaders(request: Request): {
    userId: string;
    canAccessAllSessions: boolean;
    businessId?: string | null;
    sharedSessions?: boolean;
    businessMemberIds?: string[];
    email?: string | null;
    username?: string | null;
    repoAccessVerifiedSessionId?: string;
    repoAccessVerifiedRepoOwner?: string;
    repoAccessVerifiedRepoName?: string;
  } | null;
  checkAccess(auth: InternalAuthContext, session: SessionState): boolean;
};

describe("session DO auth helpers", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  function createInstance(): SessionDOTestHandle {
    const state = new FakeDurableState(new FakeSqlStorage());
    return new workerModule.SessionDO(state, { WORKER_ENV: "test" }) as unknown as SessionDOTestHandle;
  }

  function makeSession(overrides: Partial<SessionState> = {}): SessionState {
    return {
      sessionId: "sess-1",
      ownerUserId: "owner-1",
      businessId: "biz-1",
      status: "active",
      createdAt: "2026-04-07T09:00:00.000Z",
      updatedAt: "2026-04-07T09:00:00.000Z",
      closedAt: null,
      lastEventId: null,
      title: null,
      ...overrides,
    };
  }

  function sharedBusinessAuth(overrides: Partial<InternalAuthContext> = {}): InternalAuthContext {
    return {
      userId: "member-1",
      canAccessAllSessions: false,
      businessId: "biz-1",
      sharedSessions: true,
      businessMemberIds: ["owner-1", "member-1"],
      ...overrides,
    };
  }

  it("parses internal auth headers into an auth context", () => {
    const instance = createInstance();
    const auth = instance.parseAuthHeaders(
      new Request("https://internal/session/prompts", {
        headers: {
          "x-auth-user-id": "user-1",
          "x-auth-can-access-all": "false",
          "x-auth-business-id": "biz-1",
          "x-auth-shared-sessions": "true",
          "x-auth-business-member-ids": '["user-1","user-2"]',
          "x-auth-repo-access-session-id": "sess-1",
          "x-auth-repo-access-repo-owner": "trycycloid",
          "x-auth-repo-access-repo-name": "cycloid",
          "x-auth-user-email": "user@example.com",
          "x-auth-user-username": "user-login",
        },
      }),
    );

    expect(auth).toEqual({
      userId: "user-1",
      canAccessAllSessions: false,
      businessId: "biz-1",
      sharedSessions: true,
      businessMemberIds: ["user-1", "user-2"],
      repoAccessVerifiedSessionId: "sess-1",
      repoAccessVerifiedRepoOwner: "trycycloid",
      repoAccessVerifiedRepoName: "cycloid",
      email: "user@example.com",
      username: "user-login",
    });
  });

  it("ignores a non-JSON business-member-ids header (JSON-only after the comma fallback removal)", () => {
    const instance = createInstance();
    const auth = instance.parseAuthHeaders(
      new Request("https://internal/session/prompts", {
        headers: {
          "x-auth-user-id": "user-1",
          "x-auth-can-access-all": "false",
          // The producer (session/state.ts) always JSON.stringifies; a legacy
          // comma-delimited value no longer parses and leaves the field unset.
          "x-auth-business-member-ids": "user-1,user-2",
        },
      }),
    );

    expect(auth).toEqual({
      userId: "user-1",
      canAccessAllSessions: false,
      businessId: null,
      sharedSessions: false,
      businessMemberIds: undefined,
      email: undefined,
      username: undefined,
    });
  });

  it("returns null when auth headers are absent", () => {
    const instance = createInstance();
    expect(instance.parseAuthHeaders(new Request("https://internal/session/prompts"))).toBeNull();
  });

  it("allows the owner", () => {
    const instance = createInstance();
    expect(
      instance.checkAccess({ userId: "owner-1", canAccessAllSessions: false }, makeSession({ businessId: null })),
    ).toBe(true);
  });

  it("allows admins", () => {
    const instance = createInstance();
    expect(instance.checkAccess({ userId: "admin-1", canAccessAllSessions: true }, makeSession())).toBe(true);
  });

  it("denies shared business members on a repo-less session (fail closed, mirrors the worker gate)", () => {
    // A repo-less session gives the DO no repo context to verify GitHub access
    // against, so a non-owner shared-business member must be denied -- matching
    // authorizeSessionRepoAccess, which 404s this case at the worker layer.
    const instance = createInstance();
    expect(instance.checkAccess(sharedBusinessAuth(), makeSession())).toBe(false);
  });

  it("still allows the owner on a repo-less session", () => {
    const instance = createInstance();
    expect(instance.checkAccess(sharedBusinessAuth({ userId: "owner-1" }), makeSession())).toBe(true);
  });

  it("rejects shared business auth when the session belongs to another business", () => {
    const instance = createInstance();
    expect(
      instance.checkAccess(
        sharedBusinessAuth({ userId: "member-2", businessId: "biz-2", businessMemberIds: ["owner-2", "member-2"] }),
        makeSession({ businessId: "biz-1" }),
      ),
    ).toBe(false);
  });

  it("requires route-level repo verification for repo-backed shared business sessions", () => {
    const storage = new FakeSqlStorage();
    const state = new FakeDurableState(storage);
    const instance = new workerModule.SessionDO(state, { WORKER_ENV: "test" }) as unknown as SessionDOTestHandle;
    storage.sql.exec(
      `INSERT INTO session (session_id, owner_user_id, business_id, status, created_at, updated_at, repo_owner, repo_name)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
      "sess-repo",
      "owner-1",
      "biz-1",
      Date.now(),
      Date.now(),
      "trycycloid",
      "cycloid",
    );

    const sharedAuth = sharedBusinessAuth();
    const session = makeSession({ sessionId: "sess-repo" });

    expect(instance.checkAccess(sharedAuth, session)).toBe(false);
    expect(instance.checkAccess({ ...sharedAuth, repoAccessVerifiedSessionId: "sess-repo" }, session)).toBe(false);
    expect(
      instance.checkAccess(
        {
          ...sharedAuth,
          repoAccessVerifiedSessionId: "sess-repo",
          repoAccessVerifiedRepoOwner: "trycycloid",
          repoAccessVerifiedRepoName: "other",
        },
        session,
      ),
    ).toBe(false);
    expect(
      instance.checkAccess(
        {
          ...sharedAuth,
          repoAccessVerifiedSessionId: "sess-repo",
          repoAccessVerifiedRepoOwner: "trycycloid",
          repoAccessVerifiedRepoName: "cycloid",
        },
        session,
      ),
    ).toBe(true);
  });

  it("applies the repo gate to authed state and view reads", async () => {
    const storage = new FakeSqlStorage();
    const state = new FakeDurableState(storage);
    const instance = new workerModule.SessionDO(state, { WORKER_ENV: "test" }) as unknown as SessionDOTestHandle;
    storage.sql.exec(
      `INSERT INTO session (session_id, owner_user_id, business_id, status, created_at, updated_at, repo_owner, repo_name)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
      "sess-repo",
      "owner-1",
      "biz-1",
      Date.now(),
      Date.now(),
      "trycycloid",
      "cycloid",
    );

    const baseHeaders = {
      "x-session-id": "sess-repo",
      "x-auth-user-id": "member-1",
      "x-auth-can-access-all": "false",
      "x-auth-business-id": "biz-1",
      "x-auth-shared-sessions": "true",
      "x-auth-business-member-ids": '["owner-1","member-1"]',
    };

    const deniedState = await instance.fetch(new Request("https://internal/session/state", { headers: baseHeaders }));
    expect(deniedState.status).toBe(404);

    const deniedView = await instance.fetch(new Request("https://internal/session/view", { headers: baseHeaders }));
    expect(deniedView.status).toBe(404);

    const verifiedHeaders = {
      ...baseHeaders,
      "x-auth-repo-access-session-id": "sess-repo",
      "x-auth-repo-access-repo-owner": "trycycloid",
      "x-auth-repo-access-repo-name": "cycloid",
    };
    const allowedState = await instance.fetch(
      new Request("https://internal/session/state", { headers: verifiedHeaders }),
    );
    expect(allowedState.status).toBe(200);

    const allowedView = await instance.fetch(
      new Request("https://internal/session/view", { headers: verifiedHeaders }),
    );
    expect(allowedView.status).toBe(200);
  });

  it("returns the latest plan through the authorized internal route", async () => {
    const storage = new FakeSqlStorage();
    const state = new FakeDurableState(storage);
    const instance = new workerModule.SessionDO(state, { WORKER_ENV: "test" }) as unknown as SessionDOTestHandle;
    storage.sql.exec(
      `INSERT INTO session (session_id, owner_user_id, business_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
      "sess-plan",
      "owner-1",
      "biz-1",
      Date.now(),
      Date.now(),
    );
    upsertSessionPlan(storage.sql as unknown as SqlStorage, {
      sessionId: "sess-plan",
      planPromptId: "p-plan-2",
      implementationPromptId: null,
      markdown: "# Plan\n\nLatest revision",
      excerpt: "Latest revision",
      artifactId: null,
      valid: true,
      missingReason: null,
      missingHeadings: [],
      status: "pending",
      revision: 2,
      userEdited: true,
      approvedBy: null,
      approvedAt: null,
      source: "edit",
      createdAt: "2026-07-09T15:00:00.000Z",
      updatedAt: "2026-07-09T16:00:00.000Z",
    });

    const response = await instance.fetch(
      new Request("https://internal/session/plan", {
        headers: {
          "x-session-id": "sess-plan",
          "x-auth-user-id": "owner-1",
          "x-auth-can-access-all": "false",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "pending",
      revision: 2,
      markdown: "# Plan\n\nLatest revision",
      userEdited: true,
      updatedAt: "2026-07-09T16:00:00.000Z",
      planPromptId: "p-plan-2",
    });
  });

  it("returns 404 when the authorized session has no plan", async () => {
    const storage = new FakeSqlStorage();
    const state = new FakeDurableState(storage);
    const instance = new workerModule.SessionDO(state, { WORKER_ENV: "test" }) as unknown as SessionDOTestHandle;
    storage.sql.exec(
      `INSERT INTO session (session_id, owner_user_id, business_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
      "sess-no-plan",
      "owner-1",
      "biz-1",
      Date.now(),
      Date.now(),
    );

    const response = await instance.fetch(
      new Request("https://internal/session/plan", {
        headers: {
          "x-session-id": "sess-no-plan",
          "x-auth-user-id": "owner-1",
          "x-auth-can-access-all": "false",
        },
      }),
    );

    expect(response.status).toBe(404);
  });

  it("hides a plan from an unauthorized internal caller", async () => {
    const storage = new FakeSqlStorage();
    const state = new FakeDurableState(storage);
    const instance = new workerModule.SessionDO(state, { WORKER_ENV: "test" }) as unknown as SessionDOTestHandle;
    storage.sql.exec(
      `INSERT INTO session (session_id, owner_user_id, business_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
      "sess-private-plan",
      "owner-1",
      "biz-1",
      Date.now(),
      Date.now(),
    );

    const response = await instance.fetch(
      new Request("https://internal/session/plan", {
        headers: {
          "x-session-id": "sess-private-plan",
          "x-auth-user-id": "intruder-1",
          "x-auth-can-access-all": "false",
          "x-auth-business-id": "biz-2",
        },
      }),
    );

    expect(response.status).toBe(404);
  });

  it("rejects non-members", () => {
    const instance = createInstance();
    expect(
      instance.checkAccess(
        {
          userId: "intruder-1",
          canAccessAllSessions: false,
          businessId: "biz-1",
          sharedSessions: false,
          businessMemberIds: ["intruder-1", "someone-else"],
        },
        makeSession(),
      ),
    ).toBe(false);
  });
});
