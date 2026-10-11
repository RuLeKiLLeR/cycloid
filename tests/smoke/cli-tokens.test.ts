import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

import { createWorkerEnv, seedAuthUser, sessionTokenHeaders, workerFetch, type WorkerModule } from "./helpers";

describe("smoke: CLI tokens (PAT lifecycle)", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(() => {
    expect(workerModule).toBeDefined();
  });

  it("full lifecycle: create via session auth -> use PAT to list sessions -> revoke -> verify 401", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    // Seed a user with session auth AND a business (required for CLI token resolution)
    const userId = db.addBusinessUser(7001, "pat-user", "biz-pat", null);
    seedAuthUser(db, "pat-session-token", 7001, "pat-user");
    // Patch the seeded auth token to use the actual internal user ID
    const authEntry = db.authTokens.get("pat-session-token")!;
    authEntry.user_id = userId;
    authEntry.id = userId;

    const sessionHeaders = sessionTokenHeaders("pat-session-token");

    // 1. Create a CLI token via session auth
    const createTokenRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({}),
    });
    expect(createTokenRes.status).toBe(200);
    const createTokenBody = await createTokenRes.json();
    expect(createTokenBody.ok).toBe(true);
    expect(createTokenBody.token).toBeDefined();
    expect(createTokenBody.token).toMatch(/^arc_/);
    const rawToken: string = createTokenBody.token;
    const tokenId: number = createTokenBody.id;

    // Verify the response has no-store cache control (token is sensitive)
    expect(createTokenRes.headers.get("cache-control")).toContain("no-store");

    // 2. Create a session using session auth so there is something to list
    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ sessionId: "s-pat-test", repoUrl: "https://github.com/test-owner/test-repo" }),
    });

    // 3. Use the PAT bearer token to list sessions
    const patHeaders = {
      authorization: `Bearer ${rawToken}`,
      "content-type": "application/json",
    };

    const listSessionsRes = await workerFetch(workerModule, env, "/api/sessions", {
      headers: patHeaders,
    });
    expect(listSessionsRes.status).toBe(200);
    const listSessionsBody = await listSessionsRes.json();
    expect(listSessionsBody.sessions.length).toBeGreaterThanOrEqual(1);
    expect(listSessionsBody.sessions[0].sessionId).toBe("s-pat-test");

    // 4. Revoke the token via session auth
    const revokeRes = await workerFetch(workerModule, env, `/api/cli-tokens/${tokenId}/revoke`, {
      method: "POST",
      headers: sessionHeaders,
    });
    expect(revokeRes.status).toBe(200);
    const revokeBody = await revokeRes.json();
    expect(revokeBody.ok).toBe(true);

    // 5. Verify the revoked PAT now returns 401
    const postRevokeRes = await workerFetch(workerModule, env, "/api/sessions", {
      headers: patHeaders,
    });
    expect(postRevokeRes.status).toBe(401);
  });

  it("allows a user to keep multiple active CLI tokens", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    const userId = db.addBusinessUser(7004, "multi-pat-user", "biz-multi-pat", null);
    seedAuthUser(db, "multi-pat-session-token", 7004, "multi-pat-user");
    const authEntry = db.authTokens.get("multi-pat-session-token")!;
    authEntry.user_id = userId;
    authEntry.id = userId;

    const sessionHeaders = sessionTokenHeaders("multi-pat-session-token");

    const firstCreateRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ scope: "read" }),
    });
    expect(firstCreateRes.status).toBe(200);
    const firstToken: string = (await firstCreateRes.json()).token;

    const secondCreateRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ scope: "read" }),
    });
    expect(secondCreateRes.status).toBe(200);
    const secondToken: string = (await secondCreateRes.json()).token;
    expect(secondToken).not.toBe(firstToken);

    const listTokensRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      headers: sessionHeaders,
    });
    expect(listTokensRes.status).toBe(200);
    const listTokensBody = await listTokensRes.json();
    expect(listTokensBody.data.filter((token: { revokedAt: number | null }) => token.revokedAt === null)).toHaveLength(
      2,
    );

    for (const rawToken of [firstToken, secondToken]) {
      const whoamiRes = await workerFetch(workerModule, env, "/api/auth/whoami", {
        headers: {
          authorization: `Bearer ${rawToken}`,
          "content-type": "application/json",
        },
      });
      expect(whoamiRes.status).toBe(200);
      const whoamiBody = await whoamiRes.json();
      expect(whoamiBody.authMode).toBe("cli_token");
    }
  });

  it("PAT can read /events/history and /export, cross-user is denied (404), unauth is rejected (401) -- ARC-453", async () => {
    // ARC-453: regression coverage that the replay (/events/history) and
    // export (/export) endpoints honor all three auth modes:
    //   - cookie session (success + cross-user 404)
    //   - CLI bearer token (success + cross-user 404)
    //   - missing auth (401)
    const { env, db } = createWorkerEnv(workerModule);

    // ─── Set up two distinct business users ──────────────────────────────
    const ownerInternalId = db.addBusinessUser(9101, "arc453-owner", "biz-arc453-owner", null);
    seedAuthUser(db, "arc453-owner-session", 9101, "arc453-owner");
    const ownerAuth = db.authTokens.get("arc453-owner-session")!;
    ownerAuth.user_id = ownerInternalId;
    ownerAuth.id = ownerInternalId;

    const otherInternalId = db.addBusinessUser(9102, "arc453-other", "biz-arc453-other", null);
    seedAuthUser(db, "arc453-other-session", 9102, "arc453-other");
    const otherAuth = db.authTokens.get("arc453-other-session")!;
    otherAuth.user_id = otherInternalId;
    otherAuth.id = otherInternalId;

    const ownerSessionHeaders = sessionTokenHeaders("arc453-owner-session");
    const otherSessionHeaders = sessionTokenHeaders("arc453-other-session");

    // ─── Owner mints a CLI token (PAT) ───────────────────────────────────
    const createTokenRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: ownerSessionHeaders,
      body: JSON.stringify({}),
    });
    expect(createTokenRes.status).toBe(200);
    const ownerPat: string = (await createTokenRes.json()).token;
    const ownerPatHeaders = {
      authorization: `Bearer ${ownerPat}`,
      "content-type": "application/json",
    };

    // Other user mints their own PAT for the cross-user PAT path
    const otherTokenRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: otherSessionHeaders,
      body: JSON.stringify({}),
    });
    expect(otherTokenRes.status).toBe(200);
    const otherPat: string = (await otherTokenRes.json()).token;
    const otherPatHeaders = {
      authorization: `Bearer ${otherPat}`,
      "content-type": "application/json",
    };

    // ─── Owner creates a session via cookie auth ─────────────────────────
    const createSessionRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: ownerSessionHeaders,
      body: JSON.stringify({
        sessionId: "s-arc453-pat",
        repoUrl: "https://github.com/test-owner/test-repo",
      }),
    });
    expect(createSessionRes.status).toBe(201);

    // ─── Cookie auth: success path on /events/history and /export ────────
    const cookieHistoryRes = await workerFetch(workerModule, env, "/api/sessions/s-arc453-pat/events/history", {
      headers: ownerSessionHeaders,
    });
    expect(cookieHistoryRes.status).toBe(200);
    const cookieHistoryBody = await cookieHistoryRes.json();
    expect(cookieHistoryBody.ok).toBe(true);
    expect(cookieHistoryBody.afterSequence).toBe(0);
    expect("hasMore" in cookieHistoryBody).toBe(true);
    expect("lastSequence" in cookieHistoryBody).toBe(true);

    const cookieExportRes = await workerFetch(workerModule, env, "/api/sessions/s-arc453-pat/export", {
      headers: ownerSessionHeaders,
    });
    expect(cookieExportRes.status).toBe(200);

    // ─── PAT bearer auth: success path on /events/history and /export ────
    const patHistoryRes = await workerFetch(workerModule, env, "/api/sessions/s-arc453-pat/events/history", {
      headers: ownerPatHeaders,
    });
    expect(patHistoryRes.status).toBe(200);
    const patHistoryBody = await patHistoryRes.json();
    expect(patHistoryBody.ok).toBe(true);
    expect("hasMore" in patHistoryBody).toBe(true);

    const patExportRes = await workerFetch(workerModule, env, "/api/sessions/s-arc453-pat/export", {
      headers: ownerPatHeaders,
    });
    expect(patExportRes.status).toBe(200);

    // ─── Cross-user via cookie: denied with 404 (NOT 403) ─────────────────
    const crossCookieHistoryRes = await workerFetch(workerModule, env, "/api/sessions/s-arc453-pat/events/history", {
      headers: otherSessionHeaders,
    });
    expect(crossCookieHistoryRes.status).toBe(404);
    const crossCookieExportRes = await workerFetch(workerModule, env, "/api/sessions/s-arc453-pat/export", {
      headers: otherSessionHeaders,
    });
    expect(crossCookieExportRes.status).toBe(404);

    // ─── Cross-user via PAT: denied with 404 (NOT 403) ───────────────────
    const crossPatHistoryRes = await workerFetch(workerModule, env, "/api/sessions/s-arc453-pat/events/history", {
      headers: otherPatHeaders,
    });
    expect(crossPatHistoryRes.status).toBe(404);
    const crossPatExportRes = await workerFetch(workerModule, env, "/api/sessions/s-arc453-pat/export", {
      headers: otherPatHeaders,
    });
    expect(crossPatExportRes.status).toBe(404);

    // ─── Missing auth: 401 (router-level) ────────────────────────────────
    const noAuthHistoryRes = await workerFetch(workerModule, env, "/api/sessions/s-arc453-pat/events/history");
    expect(noAuthHistoryRes.status).toBe(401);
    const noAuthExportRes = await workerFetch(workerModule, env, "/api/sessions/s-arc453-pat/export");
    expect(noAuthExportRes.status).toBe(401);
  });

  it("PAT cannot access /api/settings (scope restriction returns 403)", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    const userId = db.addBusinessUser(7002, "scope-user", "biz-scope", null);
    seedAuthUser(db, "scope-session-token", 7002, "scope-user");
    const authEntry = db.authTokens.get("scope-session-token")!;
    authEntry.user_id = userId;
    authEntry.id = userId;

    const sessionHeaders = sessionTokenHeaders("scope-session-token");

    // Create a CLI token
    const createRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({}),
    });
    expect(createRes.status).toBe(200);
    const { token } = await createRes.json();

    // Attempt to access /api/settings with the PAT -- should be 403
    const settingsRes = await workerFetch(workerModule, env, "/api/settings", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(settingsRes.status).toBe(403);
    const settingsBody = await settingsRes.json();
    expect(settingsBody.error).toContain("CLI tokens cannot access");
  });

  it("applies CLI token scopes to automation schedule routes", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    const userId = db.addBusinessUser(7012, "automation-scope-user", "biz-automation-scope", null);
    seedAuthUser(db, "automation-scope-session-token", 7012, "automation-scope-user");
    const authEntry = db.authTokens.get("automation-scope-session-token")!;
    authEntry.user_id = userId;
    authEntry.id = userId;

    const sessionHeaders = sessionTokenHeaders("automation-scope-session-token");

    const readCreateRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ scope: "read" }),
    });
    expect(readCreateRes.status).toBe(200);
    const readToken: string = (await readCreateRes.json()).token;

    const writeCreateRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ scope: "write" }),
    });
    expect(writeCreateRes.status).toBe(200);
    const writeToken: string = (await writeCreateRes.json()).token;

    const readHeaders = {
      authorization: `Bearer ${readToken}`,
      "content-type": "application/json",
    };
    const writeHeaders = {
      authorization: `Bearer ${writeToken}`,
      "content-type": "application/json",
    };

    const readListRes = await workerFetch(workerModule, env, "/api/automation/schedules", { headers: readHeaders });
    expect(readListRes.status).not.toBe(403);

    const blockedCreateRes = await workerFetch(workerModule, env, "/api/automation/schedules", {
      method: "POST",
      headers: readHeaders,
      body: JSON.stringify({}),
    });
    expect(blockedCreateRes.status).toBe(403);

    const blockedDeleteRes = await workerFetch(workerModule, env, "/api/automation/schedules/rule-1", {
      method: "DELETE",
      headers: readHeaders,
    });
    expect(blockedDeleteRes.status).toBe(403);

    const writeListRes = await workerFetch(workerModule, env, "/api/automation/schedules", { headers: writeHeaders });
    expect(writeListRes.status).not.toBe(403);

    const writeScheduleCreateRes = await workerFetch(workerModule, env, "/api/automation/schedules", {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({}),
    });
    expect(writeScheduleCreateRes.status).not.toBe(403);

    const writeDeleteRes = await workerFetch(workerModule, env, "/api/automation/schedules/rule-1", {
      method: "DELETE",
      headers: writeHeaders,
    });
    expect(writeDeleteRes.status).not.toBe(403);
  });

  it("PAT can access /api/cli-tokens (within allowed scope)", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    const userId = db.addBusinessUser(7003, "self-list-user", "biz-self", null);
    seedAuthUser(db, "self-list-token", 7003, "self-list-user");
    const authEntry = db.authTokens.get("self-list-token")!;
    authEntry.user_id = userId;
    authEntry.id = userId;

    const sessionHeaders = sessionTokenHeaders("self-list-token");

    // Create a CLI token
    const createRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({}),
    });
    expect(createRes.status).toBe(200);
    const { token } = await createRes.json();

    // Use the PAT to list CLI tokens (should be allowed since /api/cli-tokens is in scope)
    const listRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data.length).toBeGreaterThanOrEqual(1);
  });

  it("read-scoped PAT cannot revoke a write-scoped PAT", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    const userId = db.addBusinessUser(8010, "pat-revoke-scope-user", "biz-pat-revoke-scope", null);
    seedAuthUser(db, "pat-revoke-scope-session", 8010, "pat-revoke-scope-user");
    const authEntry = db.authTokens.get("pat-revoke-scope-session")!;
    authEntry.user_id = userId;
    authEntry.id = userId;

    const sessionHeaders = sessionTokenHeaders("pat-revoke-scope-session");

    const readCreateRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ scope: "read" }),
    });
    expect(readCreateRes.status).toBe(200);
    const readToken: string = (await readCreateRes.json()).token;

    const writeCreateRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ scope: "write" }),
    });
    expect(writeCreateRes.status).toBe(200);
    const writeBody = await writeCreateRes.json();
    const writeTokenId: number = writeBody.id;
    const writeToken: string = writeBody.token;

    const blockedRevokeRes = await workerFetch(workerModule, env, `/api/cli-tokens/${writeTokenId}/revoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${readToken}`,
        "content-type": "application/json",
      },
    });
    expect(blockedRevokeRes.status).toBe(403);

    const writeTokenStillWorksRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      headers: {
        authorization: `Bearer ${writeToken}`,
        "content-type": "application/json",
      },
    });
    expect(writeTokenStillWorksRes.status).toBe(200);
  });

  it("read-scoped PAT cannot delete a write-scoped PAT", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    const userId = db.addBusinessUser(8011, "pat-delete-scope-user", "biz-pat-delete-scope", null);
    seedAuthUser(db, "pat-delete-scope-session", 8011, "pat-delete-scope-user");
    const authEntry = db.authTokens.get("pat-delete-scope-session")!;
    authEntry.user_id = userId;
    authEntry.id = userId;

    const sessionHeaders = sessionTokenHeaders("pat-delete-scope-session");

    const readCreateRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ scope: "read" }),
    });
    expect(readCreateRes.status).toBe(200);
    const readToken: string = (await readCreateRes.json()).token;

    const writeCreateRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ scope: "write" }),
    });
    expect(writeCreateRes.status).toBe(200);
    const writeBody = await writeCreateRes.json();
    const writeTokenId: number = writeBody.id;
    const writeToken: string = writeBody.token;

    const blockedDeleteRes = await workerFetch(workerModule, env, `/api/cli-tokens/${writeTokenId}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${readToken}`,
        "content-type": "application/json",
      },
    });
    expect(blockedDeleteRes.status).toBe(403);

    const writeTokenStillWorksRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      headers: {
        authorization: `Bearer ${writeToken}`,
        "content-type": "application/json",
      },
    });
    expect(writeTokenStillWorksRes.status).toBe(200);
  });

  it("read-scoped PAT can retry revoking an already-revoked write-scoped PAT", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    const userId = db.addBusinessUser(8012, "pat-rerevoke-user", "biz-pat-rerevoke", null);
    seedAuthUser(db, "pat-rerevoke-session", 8012, "pat-rerevoke-user");
    const authEntry = db.authTokens.get("pat-rerevoke-session")!;
    authEntry.user_id = userId;
    authEntry.id = userId;

    const sessionHeaders = sessionTokenHeaders("pat-rerevoke-session");

    const readCreateRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ scope: "read" }),
    });
    expect(readCreateRes.status).toBe(200);
    const readToken: string = (await readCreateRes.json()).token;

    const writeCreateRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ scope: "write" }),
    });
    expect(writeCreateRes.status).toBe(200);
    const writeBody = await writeCreateRes.json();
    const writeTokenId: number = writeBody.id;

    const firstRevokeRes = await workerFetch(workerModule, env, `/api/cli-tokens/${writeTokenId}/revoke`, {
      method: "POST",
      headers: sessionHeaders,
    });
    expect(firstRevokeRes.status).toBe(200);

    const retryRevokeRes = await workerFetch(workerModule, env, `/api/cli-tokens/${writeTokenId}/revoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${readToken}`,
        "content-type": "application/json",
      },
    });
    expect(retryRevokeRes.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // Security: expired token rejection (end-to-end)
  // ---------------------------------------------------------------------------

  it("expired CLI token returns 401", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    const userId = db.addBusinessUser(8003, "expiry-user", "biz-expiry", null);
    seedAuthUser(db, "expiry-session", 8003, "expiry-user");
    const authEntry = db.authTokens.get("expiry-session")!;
    authEntry.user_id = userId;
    authEntry.id = userId;

    // Create a token with very short expiry (1 day)
    const createRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: sessionTokenHeaders("expiry-session"),
      body: JSON.stringify({ expiresInDays: 1 }),
    });
    expect(createRes.status).toBe(200);
    const { token, id } = await createRes.json();

    // Token works initially
    const validRes = await workerFetch(workerModule, env, "/api/sessions", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(validRes.status).toBe(200);

    // Manually expire the token by setting expires_at to the past
    const cliToken = db.cliTokens.get(id)!;
    cliToken.expires_at = Date.now() - 1000;

    // Expired token should return 401
    const expiredRes = await workerFetch(workerModule, env, "/api/sessions", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(expiredRes.status).toBe(401);
  });

  it("expired CLI token does not block creating a replacement", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    const userId = db.addBusinessUser(8009, "expiry-rotate-user", "biz-expiry-rotate", null);
    seedAuthUser(db, "expiry-rotate-session", 8009, "expiry-rotate-user");
    const authEntry = db.authTokens.get("expiry-rotate-session")!;
    authEntry.user_id = userId;
    authEntry.id = userId;

    const sessionHeaders = sessionTokenHeaders("expiry-rotate-session");

    const firstCreateRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ expiresInDays: 1 }),
    });
    expect(firstCreateRes.status).toBe(200);
    const { id: firstTokenId } = await firstCreateRes.json();

    db.cliTokens.get(firstTokenId)!.expires_at = Date.now() - 1000;

    const replacementRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ expiresInDays: 1 }),
    });
    expect(replacementRes.status).toBe(200);
    const replacementBody = await replacementRes.json();
    expect(replacementBody.id).not.toBe(firstTokenId);
  });

  // ---------------------------------------------------------------------------
  // Security: cross-user token revocation prevention
  // ---------------------------------------------------------------------------

  it("user cannot revoke another user's token", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    // User A creates a token
    const userAId = db.addBusinessUser(8004, "revoke-a", "biz-revoke-a", null);
    seedAuthUser(db, "revoke-a-session", 8004, "revoke-a");
    const authA = db.authTokens.get("revoke-a-session")!;
    authA.user_id = userAId;
    authA.id = userAId;

    const createRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: sessionTokenHeaders("revoke-a-session"),
      body: JSON.stringify({}),
    });
    expect(createRes.status).toBe(200);
    const { id: tokenAId, token: tokenA } = await createRes.json();

    // User B tries to revoke user A's token
    const userBId = db.addBusinessUser(8005, "revoke-b", "biz-revoke-b", null);
    seedAuthUser(db, "revoke-b-session", 8005, "revoke-b");
    const authB = db.authTokens.get("revoke-b-session")!;
    authB.user_id = userBId;
    authB.id = userBId;

    await workerFetch(workerModule, env, `/api/cli-tokens/${tokenAId}/revoke`, {
      method: "POST",
      headers: sessionTokenHeaders("revoke-b-session"),
    });

    // User A's token should still work (revocation was scoped to user B, so it was a no-op)
    const stillValidRes = await workerFetch(workerModule, env, "/api/sessions", {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(stillValidRes.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // Security: token list never exposes hashes or plaintext
  // ---------------------------------------------------------------------------

  it("GET /api/cli-tokens never returns token_hash or plaintext token", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    const userId = db.addBusinessUser(8006, "hash-user", "biz-hash", null);
    seedAuthUser(db, "hash-session", 8006, "hash-user");
    const authEntry = db.authTokens.get("hash-session")!;
    authEntry.user_id = userId;
    authEntry.id = userId;

    // Create a token
    const createRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: sessionTokenHeaders("hash-session"),
      body: JSON.stringify({}),
    });
    const { token: rawToken } = await createRes.json();

    // List tokens
    const listRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      headers: sessionTokenHeaders("hash-session"),
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();

    const serialized = JSON.stringify(listBody);
    // Must not contain the raw token
    expect(serialized).not.toContain(rawToken);
    // Must not contain "token_hash" field
    expect(serialized).not.toContain("token_hash");
    // Should contain only the prefix
    expect(listBody.data[0].tokenPrefix).toBe(rawToken.slice(0, 8));
  });

  // ---------------------------------------------------------------------------
  // Security: bearer token with arc_ takes priority over cookie
  // ---------------------------------------------------------------------------

  it("bearer arc_ token takes priority over session cookie", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    // User A has a session cookie
    const userAId = db.addBusinessUser(8007, "cookie-user", "biz-cookie", null);
    seedAuthUser(db, "cookie-session", 8007, "cookie-user");
    const authA = db.authTokens.get("cookie-session")!;
    authA.user_id = userAId;
    authA.id = userAId;

    // User B has a PAT
    const userBId = db.addBusinessUser(8008, "pat-bearer-user", "biz-bearer", null);
    seedAuthUser(db, "bearer-session", 8008, "pat-bearer-user");
    const authB = db.authTokens.get("bearer-session")!;
    authB.user_id = userBId;
    authB.id = userBId;

    // Create PAT for user B
    const createRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: sessionTokenHeaders("bearer-session"),
      body: JSON.stringify({}),
    });
    expect(createRes.status).toBe(200);
    const { token: patToken } = await createRes.json();

    // Send request with BOTH user A's cookie AND user B's PAT bearer
    // The PAT bearer should take priority, so scope restriction applies
    const res = await workerFetch(workerModule, env, "/api/settings", {
      headers: {
        authorization: `Bearer ${patToken}`,
        cookie: "session_token=cookie-session",
      },
    });
    // PAT cannot access /api/settings (403), proving bearer took priority over cookie
    expect(res.status).toBe(403);
  });

  it("delete token removes it permanently", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    const userId = db.addBusinessUser(7005, "delete-pat-user", "biz-delete", null);
    seedAuthUser(db, "delete-pat-session", 7005, "delete-pat-user");
    const authEntry = db.authTokens.get("delete-pat-session")!;
    authEntry.user_id = userId;
    authEntry.id = userId;

    const sessionHeaders = sessionTokenHeaders("delete-pat-session");

    // Create token
    const createRes = await workerFetch(workerModule, env, "/api/cli-tokens", {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({}),
    });
    expect(createRes.status).toBe(200);
    const { id, token } = await createRes.json();

    // Delete the token
    const deleteRes = await workerFetch(workerModule, env, `/api/cli-tokens/${id}`, {
      method: "DELETE",
      headers: sessionHeaders,
    });
    expect(deleteRes.status).toBe(200);

    // Verify the deleted PAT returns 401
    const postDeleteRes = await workerFetch(workerModule, env, "/api/sessions", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(postDeleteRes.status).toBe(401);
  });
});
