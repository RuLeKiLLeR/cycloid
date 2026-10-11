import { describe, expect, it } from "vitest";

import {
  listImpersonationDirectory,
  searchImpersonationTargets,
} from "../../apps/control-plane-worker/src/auth/impersonation-db";
import {
  ARCANIST_BUSINESS_ID,
  IMPERSONATION_MAX_ACTIVE_PER_ACTOR,
} from "../../apps/control-plane-worker/src/constants/auth";
import { routeMutatesUnderImpersonation } from "../../apps/control-plane-worker/src/router";
import { adminImpersonationRoutes } from "../../apps/control-plane-worker/src/routes/admin-impersonation";
import { authRoutes } from "../../apps/control-plane-worker/src/routes/auth";

describe("auth route impersonation opt-outs", () => {
  it("POST /auth/logout opts out of the read-only guard so impersonated operators can exit", () => {
    const logout = authRoutes.find((r) => r.method === "POST" && r.pattern.test("/auth/logout"));
    expect(logout).toBeDefined();
    expect(routeMutatesUnderImpersonation(logout!.method, logout!)).toBe(false);
  });
});

describe("searchImpersonationTargets", () => {
  it("returns display-safe session target rows by session ID", async () => {
    const prepared: string[] = [];
    const db = {
      prepare: (query: string) => {
        prepared.push(query);
        return {
          bind: (..._values: unknown[]) => ({
            all: async () => ({
              results: [
                {
                  session_id: "s-recent",
                  title: "Debug this",
                  updated_at: 1234,
                  owner_user_id: 42,
                  owner_login: "customer",
                  owner_name: "Customer User",
                  owner_email: null,
                  business_id: "biz-customer",
                  business_name: "Customer Inc",
                },
              ],
            }),
          }),
        };
      },
    } as unknown as D1Database;

    const result = await searchImpersonationTargets(db, "customer");

    expect(result.sessions[0]).toMatchObject({
      sessionId: "s-recent",
      owner: { id: 42, login: "customer", email: null },
      businessId: "biz-customer",
    });
    expect(prepared[0]).toContain("WHERE LOWER(s.session_id) = LOWER(?) OR LOWER(s.session_id) LIKE");
    expect(prepared[0]).not.toContain("LOWER(COALESCE(u.email");
    expect(JSON.stringify(result)).not.toContain("token");
  });

  it("uses an exact session-id lookup before fuzzy matching", async () => {
    const binds: unknown[][] = [];
    const db = {
      prepare: (query: string) => ({
        bind: (...values: unknown[]) => {
          binds.push(values);
          return {
            all: async () => ({ results: [] }),
          };
        },
        query,
      }),
    } as unknown as D1Database;

    await searchImpersonationTargets(db, "6c56a550-a7b0-4ffc-8b9e-9a608163b55d");

    expect(binds[0]?.[0]).toBe("6c56a550-a7b0-4ffc-8b9e-9a608163b55d");
    expect(binds[0]?.[1]).toBe("%6c56a550-a7b0-4ffc-8b9e-9a608163b55d%");
  });

  it("accepts a pasted session URL in the support search route", async () => {
    const binds: unknown[][] = [];
    const db = {
      prepare: (query: string) => ({
        bind: (...values: unknown[]) => {
          binds.push(values);
          return {
            first: async () => ({ business_id: ARCANIST_BUSINESS_ID, business_role: "admin" }),
            all: async () => ({ results: [] }),
          };
        },
      }),
    } as unknown as D1Database;
    const route = adminImpersonationRoutes.find(
      (candidate) => candidate.method === "GET" && candidate.pattern.test("/api/admin/impersonation/search"),
    );
    expect(route).toBeDefined();

    const response = await route!.handler(
      new Request(
        "https://app.trycycloid.com/api/admin/impersonation/search?q=https%3A%2F%2Fapp.trycycloid.com%2Fsessions%2Fsess-123%3Ftab%3Dtranscript",
        {
          headers: { cookie: "session_token=existing-operator-session" },
        },
      ),
      { DB: db } as never,
      { params: {}, groups: {} },
      {
        authMode: "user_session",
        tokenSource: "session_token",
        userId: "71931994",
        canAccessAllSessions: false,
        user: {
          id: 71931994,
          githubUserId: 71931994,
          login: "operator",
          name: "Operator",
          email: null,
          businessId: ARCANIST_BUSINESS_ID,
          businessRole: "admin",
          sharedSessions: false,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(binds.at(-1)?.[0]).toBe("sess-123");
    expect(binds.at(-1)?.[1]).toBe("%sess-123%");
  });
});

describe("listImpersonationDirectory", () => {
  it("does not require fresh relogin when the current operator session is active", async () => {
    const prepared: string[] = [];
    const db = {
      prepare: (query: string) => {
        prepared.push(query);
        return {
          bind: (..._values: unknown[]) => ({
            first: async () => ({ business_id: ARCANIST_BUSINESS_ID, business_role: "admin" }),
            all: async () => ({ results: [] }),
          }),
        };
      },
    } as unknown as D1Database;

    const route = adminImpersonationRoutes.find(
      (candidate) => candidate.method === "GET" && candidate.pattern.test("/api/admin/impersonation/directory"),
    );
    expect(route).toBeDefined();

    const response = await route!.handler(
      new Request("https://app.trycycloid.com/api/admin/impersonation/directory", {
        headers: { cookie: "session_token=existing-operator-session" },
      }),
      { DB: db } as never,
      { params: {}, groups: {} },
      {
        authMode: "user_session",
        tokenSource: "session_token",
        userId: "71931994",
        canAccessAllSessions: false,
        user: {
          id: 71931994,
          githubUserId: 71931994,
          login: "operator",
          name: "Operator",
          email: null,
          businessId: ARCANIST_BUSINESS_ID,
          businessRole: "admin",
          sharedSessions: false,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, businesses: [] });
    expect(prepared.join("\n")).not.toContain("auth_sessions");
  });

  it("groups display-safe customers by business for the dropdown", async () => {
    const db = {
      prepare: (query: string) => ({
        bind: (..._values: unknown[]) => ({
          all: async () => ({
            results: [
              {
                id: 42,
                login: "customer",
                name: "Customer User",
                business_id: "biz-customer",
                business_name: "Customer Inc",
                email: "hidden@example.com",
              },
              {
                id: 43,
                login: "teammate",
                name: "Team Mate",
                business_id: "biz-customer",
                business_name: "Customer Inc",
                email: "hidden-2@example.com",
              },
            ],
          }),
        }),
        query,
      }),
    } as unknown as D1Database;

    const result = await listImpersonationDirectory(db);

    expect(result).toEqual({
      truncated: false,
      businesses: [
        {
          id: "biz-customer",
          name: "Customer Inc",
          users: [
            {
              id: 42,
              login: "customer",
              name: "Customer User",
              businessId: "biz-customer",
              businessName: "Customer Inc",
            },
            {
              id: 43,
              login: "teammate",
              name: "Team Mate",
              businessId: "biz-customer",
              businessName: "Customer Inc",
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("hidden@example.com");
  });

  it("reports when the customer directory is truncated", async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({
      id: index + 1,
      login: `customer-${index + 1}`,
      name: `Customer ${index + 1}`,
      business_id: "biz-customer",
      business_name: "Customer Inc",
    }));
    const db = {
      prepare: (_query: string) => ({
        bind: (..._values: unknown[]) => ({
          all: async () => ({ results: rows }),
        }),
      }),
    } as unknown as D1Database;

    const result = await listImpersonationDirectory(db);

    expect(result.truncated).toBe(true);
    expect(result.businesses[0]?.users).toHaveLength(500);
  });
});

describe("admin impersonation creation", () => {
  function findCreateRoute() {
    const route = adminImpersonationRoutes.find(
      (candidate) => candidate.method === "POST" && candidate.pattern.test("/api/admin/impersonation"),
    );
    expect(route).toBeDefined();
    return route!;
  }

  function adminGateDb(): D1Database {
    return {
      prepare: (query: string) => ({
        bind: (..._values: unknown[]) => ({
          first: async () => {
            if (query.includes("bm.role AS business_role")) {
              return { business_id: ARCANIST_BUSINESS_ID, business_role: "admin" };
            }
            return null;
          },
          run: async () => ({ meta: { changes: 0 } }),
        }),
      }),
    } as unknown as D1Database;
  }

  const operatorAuth = {
    authMode: "user_session",
    tokenSource: "session_token",
    userId: "71931994",
    canAccessAllSessions: false,
    user: {
      id: 71931994,
      githubUserId: 71931994,
      login: "operator",
      name: "Operator",
      email: null,
      businessId: ARCANIST_BUSINESS_ID,
      businessRole: "admin",
      sharedSessions: false,
    },
  } as const;

  it("accepts a short support-view reason", async () => {
    const insertedImpersonationBindings: unknown[][] = [];
    const db = {
      prepare: (query: string) => ({
        bind: (...values: unknown[]) => ({
          first: async () => {
            if (query.includes("member_id") && query.includes("WHERE u.id = ? LIMIT 1")) {
              return { id: 42, login: "customer", business_id: "biz-customer", member_id: 42 };
            }
            if (query.includes("bm.role AS business_role")) {
              return { business_id: ARCANIST_BUSINESS_ID, business_role: "admin" };
            }
            return null;
          },
          run: async () => {
            if (query.includes("INSERT INTO impersonation_sessions")) {
              insertedImpersonationBindings.push(values);
            }
            return { meta: { changes: 1 } };
          },
        }),
      }),
    } as unknown as D1Database;

    const route = findCreateRoute();

    const response = await route.handler(
      new Request("https://app.trycycloid.com/api/admin/impersonation", {
        method: "POST",
        headers: { cookie: "session_token=existing-operator-session", "content-type": "application/json" },
        body: JSON.stringify({ targetUserId: 42, reason: "x" }),
      }),
      { DB: db } as never,
      { params: {}, groups: {} },
      operatorAuth,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(insertedImpersonationBindings).toEqual([
      [
        expect.any(String),
        expect.any(String),
        71931994,
        42,
        "x",
        expect.any(Number),
        expect.any(Number),
        71931994,
        expect.any(Number),
        IMPERSONATION_MAX_ACTIVE_PER_ACTOR,
      ],
    ]);
  });

  it("keeps the targetUserId validation message when the body is empty", async () => {
    const response = await findCreateRoute().handler(
      new Request("https://app.trycycloid.com/api/admin/impersonation", {
        method: "POST",
        headers: { cookie: "session_token=existing-operator-session" },
      }),
      { DB: adminGateDb() } as never,
      { params: {}, groups: {} },
      operatorAuth,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "targetUserId must be a positive integer" });
  });

  it("keeps the reason validation message", async () => {
    const response = await findCreateRoute().handler(
      new Request("https://app.trycycloid.com/api/admin/impersonation", {
        method: "POST",
        headers: { cookie: "session_token=existing-operator-session", "content-type": "application/json" },
        body: JSON.stringify({ targetUserId: 42, reason: 123 }),
      }),
      { DB: adminGateDb() } as never,
      { params: {}, groups: {} },
      operatorAuth,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "reason must be a string of at most 500 characters",
    });
  });
});

describe("routeMutatesUnderImpersonation", () => {
  it("blocks all standard mutating HTTP methods by default", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(routeMutatesUnderImpersonation(method, {})).toBe(true);
    }
  });

  it("allows safe HTTP methods by default", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(routeMutatesUnderImpersonation(method, {})).toBe(false);
    }
  });

  it("respects impersonationReadOnlyAllowed opt-out", () => {
    expect(routeMutatesUnderImpersonation("DELETE", { impersonationReadOnlyAllowed: true })).toBe(false);
    expect(routeMutatesUnderImpersonation("POST", { impersonationReadOnlyAllowed: true })).toBe(false);
  });

  it("respects impersonationMutatingGet opt-in for GET routes that have side effects", () => {
    expect(routeMutatesUnderImpersonation("GET", { impersonationMutatingGet: true })).toBe(true);
  });

  it("opt-out wins over opt-in (both flags set)", () => {
    expect(
      routeMutatesUnderImpersonation("GET", {
        impersonationReadOnlyAllowed: true,
        impersonationMutatingGet: true,
      }),
    ).toBe(false);
  });
});
