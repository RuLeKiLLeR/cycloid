import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  extractCommonWebhookActor,
  extractRepoAndInstallation,
} from "../../apps/control-plane-worker/src/webhooks/shared";
import {
  buildGithubInstallationPayload,
  buildGithubInstallationRepositoriesPayload,
  buildGithubPullRequestPayload,
  computeHmacSha256Hex,
  makeSignedGithubRequest,
} from "./github-webhook-fixtures";

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

// Track installation DB calls
const installationDbCalls: Array<{ fn: string; args: unknown[] }> = [];
const webhookOperationCalls: string[] = [];
let upsertInstallationImpl: (...args: unknown[]) => Promise<void>;
let updateInstallationPermissionsImpl: (...args: unknown[]) => Promise<void>;
let deleteCachedInstallationReposImpl: (...args: unknown[]) => Promise<void>;
let getConflictingInstallationByOwnerImpl: (...args: unknown[]) => Promise<Record<string, unknown> | null>;
let isInstallationOwnerUniqueConstraintErrorImpl: (error: unknown) => boolean;
let replaceConflictingInstallationImpl: (...args: unknown[]) => Promise<void>;

vi.mock("../../apps/control-plane-worker/src/github/installations-db", () => ({
  upsertInstallation: (...args: unknown[]) => upsertInstallationImpl(...args),
  updateInstallationPermissions: (...args: unknown[]) => updateInstallationPermissionsImpl(...args),
  getConflictingInstallationByOwner: (...args: unknown[]) => getConflictingInstallationByOwnerImpl(...args),
  isInstallationOwnerUniqueConstraintError: (error: unknown) => isInstallationOwnerUniqueConstraintErrorImpl(error),
  replaceConflictingInstallation: (...args: unknown[]) => replaceConflictingInstallationImpl(...args),
  deleteInstallation: async (...args: unknown[]) => {
    installationDbCalls.push({ fn: "deleteInstallation", args });
  },
  suspendInstallation: async (...args: unknown[]) => {
    installationDbCalls.push({ fn: "suspendInstallation", args });
  },
  unsuspendInstallation: async (...args: unknown[]) => {
    installationDbCalls.push({ fn: "unsuspendInstallation", args });
  },
  deleteCachedInstallationRepos: (...args: unknown[]) => deleteCachedInstallationReposImpl(...args),
}));

// Track notify and close calls
const sessionStateCalls: Array<{ fn: string; args: unknown[] }> = [];
const notifySessionCalls: Array<{ sessionId: string; prUrl: string }> = [];
type NotifySessionPrMergedMock = (
  env: unknown,
  sessionId: string,
  prUrl: string,
) => Promise<{ status: number; ok: boolean; payload: { ok: boolean; notified?: boolean } | null }>;
const defaultNotifySessionPrMerged: NotifySessionPrMergedMock = async (_env, sessionId, prUrl) => {
  notifySessionCalls.push({ sessionId, prUrl });
  return { status: 200, ok: true, payload: { ok: true, notified: true } };
};
let notifySessionPrMergedImpl: NotifySessionPrMergedMock = defaultNotifySessionPrMerged;

// Mock session state to prevent DO lookups
vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  closeSessionForWebhook: async (...args: unknown[]) => {
    sessionStateCalls.push({ fn: "closeSessionForWebhook", args });
    return { closed: true };
  },
  notifySessionPrMerged: (...args: Parameters<NotifySessionPrMergedMock>) => notifySessionPrMergedImpl(...args),
  getSessionState: async () => ({ ownerUserId: "user-1", sessionId: "sess-abc", status: "archived" }),
}));

const githubPrCalls: Array<{ fn: string; args: unknown[] }> = [];
let mockReviewComments: Array<{ id: number | null; inReplyToId: number | null }> = [];
let mockCommitShas: string[] = [];
let mockCiStatus: "success" | "failed" | "pending" | "unknown" = "success";
let mockCiStatusError: Error | null = null;
let mockCiStatuses = new Map<string, "success" | "failed" | "pending" | "unknown">();
let mockCiStatusErrors = new Map<string, Error>();

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: async () => "ghs_install_token",
  createScopedInstallationToken: async () => "ghs_install_token",
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
  getAppSlug: async () => "cycloid-dev",
  invalidateInstallationTokenCache: async () => {},
}));

vi.mock("../../apps/control-plane-worker/src/auth/db", () => ({
  getUserByGithubId: async () => null,
  getValidGithubToken: async () => "ghp_user_token",
}));

type GithubWebhookModule = {
  handleGithubWebhook: (request: Request, env: unknown, ctx?: unknown) => Promise<Response>;
};

class FakeKV {
  readonly store = new Map<string, string>();

  async get(key: string, type?: string): Promise<unknown> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: string): Promise<void> {
    webhookOperationCalls.push(`kv.put:${key}`);
    this.store.set(key, value);
  }
}

const WEBHOOK_SECRET = "test-webhook-secret";

// Minimal D1 fake for idempotency/session lookups (PR close path)
class FakeD1Statement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: FakePrD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  async run(): Promise<{ success: true; meta?: { changes: number } }> {
    if (this.query.includes("INTO webhook_idempotency")) {
      const [key] = this.boundValues as [string];
      if (this.db.idempotency.has(key)) return { success: true, meta: { changes: 0 } };
      this.db.idempotency.add(key);
      return { success: true, meta: { changes: 1 } };
    }
    if (this.query.includes("UPDATE session_completions")) {
      this.db.outcomeUpdates.push(this.boundValues);
      return { success: true, meta: { changes: 1 } };
    }
    return { success: true };
  }

  async first(): Promise<Record<string, unknown> | null> {
    return null;
  }

  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    if (this.query.includes("FROM session_webhook_refs")) {
      return { results: this.db.sessionRefs };
    }
    if (this.query.includes("FROM session_completions")) {
      const prUrl = this.boundValues[this.boundValues.length - 1];
      const sessionIds = new Set(this.boundValues.slice(0, -1));
      return {
        results: this.db.completionRows.filter((row) => sessionIds.has(row.session_id) && row.pr_url === prUrl),
      };
    }
    return { results: [] };
  }
}

class FakePrD1 {
  readonly idempotency = new Set<string>();
  sessionRefs: Array<{ session_id: string }> = [];
  completionRows: Array<Record<string, unknown>> = [];
  outcomeUpdates: unknown[][] = [];

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }

  async batch(statements: FakeD1Statement[]): Promise<Array<{ success: true; meta?: { changes: number } }>> {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

async function makeSignedRequest(body: string, eventType: string, deliveryId?: string): Promise<Request> {
  return makeSignedGithubRequest(body, { eventType, secret: WEBHOOK_SECRET, deliveryId });
}

let githubMod: GithubWebhookModule;

describe("github webhook dispatch", () => {
  let fakeDb: FakePrD1;
  let fakeKv: FakeKV;

  beforeEach(async () => {
    installationDbCalls.length = 0;
    upsertInstallationImpl = async (...args: unknown[]) => {
      installationDbCalls.push({ fn: "upsertInstallation", args });
    };
    updateInstallationPermissionsImpl = async (...args: unknown[]) => {
      installationDbCalls.push({ fn: "updateInstallationPermissions", args });
    };
    deleteCachedInstallationReposImpl = async (...args: unknown[]) => {
      webhookOperationCalls.push("deleteCachedInstallationRepos");
      installationDbCalls.push({ fn: "deleteCachedInstallationRepos", args });
    };
    getConflictingInstallationByOwnerImpl = async () => null;
    isInstallationOwnerUniqueConstraintErrorImpl = (error: unknown) =>
      String(error).includes("UNIQUE constraint failed: github_installations.owner_login");
    replaceConflictingInstallationImpl = async (...args: unknown[]) => {
      installationDbCalls.push({ fn: "replaceConflictingInstallation", args });
    };
    sessionStateCalls.length = 0;
    notifySessionCalls.length = 0;
    webhookOperationCalls.length = 0;
    notifySessionPrMergedImpl = defaultNotifySessionPrMerged;
    githubPrCalls.length = 0;
    mockReviewComments = [];
    mockCommitShas = [];
    mockCiStatus = "success";
    mockCiStatusError = null;
    mockCiStatuses = new Map();
    mockCiStatusErrors = new Map();
    fakeDb = new FakePrD1();
    fakeKv = new FakeKV();
    vi.resetModules();
    // Re-mock after resetModules
    vi.doMock("../../apps/control-plane-worker/src/github/installations-db", () => ({
      upsertInstallation: (...args: unknown[]) => upsertInstallationImpl(...args),
      updateInstallationPermissions: (...args: unknown[]) => updateInstallationPermissionsImpl(...args),
      getConflictingInstallationByOwner: (...args: unknown[]) => getConflictingInstallationByOwnerImpl(...args),
      isInstallationOwnerUniqueConstraintError: (error: unknown) => isInstallationOwnerUniqueConstraintErrorImpl(error),
      replaceConflictingInstallation: (...args: unknown[]) => replaceConflictingInstallationImpl(...args),
      deleteInstallation: async (...args: unknown[]) => {
        installationDbCalls.push({ fn: "deleteInstallation", args });
      },
      suspendInstallation: async (...args: unknown[]) => {
        installationDbCalls.push({ fn: "suspendInstallation", args });
      },
      unsuspendInstallation: async (...args: unknown[]) => {
        installationDbCalls.push({ fn: "unsuspendInstallation", args });
      },
      deleteCachedInstallationRepos: (...args: unknown[]) => deleteCachedInstallationReposImpl(...args),
    }));
    vi.doMock("../../apps/control-plane-worker/src/session/state", () => ({
      closeSessionForWebhook: async (...args: unknown[]) => {
        sessionStateCalls.push({ fn: "closeSessionForWebhook", args });
        return { closed: true };
      },
      notifySessionPrMerged: (...args: Parameters<NotifySessionPrMergedMock>) => notifySessionPrMergedImpl(...args),
      getSessionState: async () => ({ ownerUserId: "user-1", sessionId: "sess-abc", status: "archived" }),
    }));
    vi.doMock("../../apps/control-plane-worker/src/github/pr", () => ({
      getPrReviewComments: async (...args: unknown[]) => {
        githubPrCalls.push({ fn: "getPrReviewComments", args });
        return mockReviewComments;
      },
      getPrCommitShas: async (...args: unknown[]) => {
        githubPrCalls.push({ fn: "getPrCommitShas", args });
        return mockCommitShas;
      },
      getCommitCiStatus: async (...args: unknown[]) => {
        githubPrCalls.push({ fn: "getCommitCiStatus", args });
        const sha = args[3] as string;
        const shaError = mockCiStatusErrors.get(sha);
        if (shaError) throw shaError;
        if (mockCiStatusError) throw mockCiStatusError;
        const shaStatus = mockCiStatuses.get(sha);
        if (shaStatus) return shaStatus;
        return mockCiStatus;
      },
    }));
    vi.doMock("../../apps/control-plane-worker/src/github/octokit", () => ({
      createInstallationToken: async () => "ghs_install_token",
      getAppSlug: async () => "cycloid-dev",
      invalidateInstallationTokenCache: async (...args: unknown[]) => {
        installationDbCalls.push({ fn: "invalidateInstallationTokenCache", args });
      },
    }));
    vi.doMock("../../apps/control-plane-worker/src/auth/db", () => ({
      getUserByGithubId: async () => null,
      getValidGithubToken: async () => "ghp_user_token",
    }));
    const path: string = "../../apps/control-plane-worker/src/webhooks/github";
    githubMod = (await import(path)) as unknown as GithubWebhookModule;
  });

  describe("payload helpers", () => {
    it("extracts common sender metadata", () => {
      expect(
        extractCommonWebhookActor({
          sender: { id: 123, login: "octocat", type: "User" },
        }),
      ).toEqual({
        senderId: 123,
        senderLogin: "octocat",
        senderType: "User",
      });
    });

    it("returns null actor fields for malformed sender payloads", () => {
      expect(extractCommonWebhookActor({ sender: "octocat" })).toEqual({
        senderId: null,
        senderLogin: null,
        senderType: "",
      });
    });

    it("extracts repository metadata, URL fallback, and numeric installation id", () => {
      expect(
        extractRepoAndInstallation({
          installation: { id: 456 },
          repository: {
            name: "repo",
            private: true,
            owner: { login: "acme" },
          },
        }),
      ).toEqual({
        repoOwner: "acme",
        repoName: "repo",
        repoPrivate: true,
        repositoryUrl: "https://github.com/acme/repo",
        installationId: 456,
      });
    });

    it("does not coerce string installation ids", () => {
      expect(
        extractRepoAndInstallation({
          installation: { id: "456" },
          repository: {
            name: "repo",
            html_url: "https://github.example/acme/repo",
            owner: { login: "acme" },
          },
        }),
      ).toEqual({
        repoOwner: "acme",
        repoName: "repo",
        repoPrivate: undefined,
        repositoryUrl: "https://github.example/acme/repo",
        installationId: null,
      });
    });
  });

  describe("event routing", () => {
    it("routes installation events to installation handler", async () => {
      const body = JSON.stringify(buildGithubInstallationPayload());
      const request = await makeSignedRequest(body, "installation");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, REPOS_CACHE: fakeKv };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.action).toBe("created");
      expect(installationDbCalls).toHaveLength(1);
      expect(installationDbCalls[0].fn).toBe("upsertInstallation");
      expect(await fakeKv.get("repos:installations:version")).toBeTruthy();
    });

    it("routes pull_request events to PR handler", async () => {
      fakeDb.sessionRefs = [{ session_id: "sess-abc" }];
      const body = JSON.stringify(
        buildGithubPullRequestPayload({
          pull_request: {
            html_url: "https://github.com/trycycloid/cycloid/pull/1",
            number: 1,
            base: { repo: { owner: { login: "trycycloid" }, name: "cycloid" } },
          },
        }),
      );
      const request = await makeSignedRequest(body, "pull_request");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.skipped).toBe(true);
      expect(installationDbCalls).toHaveLength(0);
    });

    it("acknowledges opened PR events without session eval side effects", async () => {
      const body = JSON.stringify(
        buildGithubPullRequestPayload({
          pull_request: {
            html_url: "https://github.com/org/repo/pull/1",
            number: 1,
          },
        }),
      );
      const request = await makeSignedRequest(body, "pull_request");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.skipped).toBe(true);
    });

    it("returns skipped for unknown event types", async () => {
      const body = JSON.stringify({ action: "edited" });
      const request = await makeSignedRequest(body, "repository");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.skipped).toBe(true);
    });

    it("returns skipped when x-github-event header is missing", async () => {
      const body = JSON.stringify({ action: "created" });
      const hmac = await computeHmacSha256Hex(WEBHOOK_SECRET, body);
      const request = new Request("https://example.com/api/webhooks/github", {
        method: "POST",
        headers: {
          "x-hub-signature-256": `sha256=${hmac}`,
          "content-type": "application/json",
        },
        body,
      });
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json.skipped).toBe(true);
    });
  });

  describe("installation events", () => {
    it("handles installation created", async () => {
      const body = JSON.stringify(
        buildGithubInstallationPayload({
          installation: {
            repository_selection: "selected",
            permissions: { contents: "write", metadata: "read", pull_requests: "write" },
            events: ["issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment", "push"],
          },
        }),
      );
      const request = await makeSignedRequest(body, "installation");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, REPOS_CACHE: fakeKv };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(json.ok).toBe(true);
      expect(json.action).toBe("created");
      expect(installationDbCalls[0].fn).toBe("upsertInstallation");
      const params = (installationDbCalls[0].args as [unknown, Record<string, unknown>])[1];
      expect(params.installationId).toBe(12345);
      expect(params.ownerLogin).toBe("acme-corp");
      expect(params.repositorySelection).toBe("selected");
      expect(params.permissions).toEqual({ contents: "write", metadata: "read", pull_requests: "write" });
      expect(params.events).toEqual([
        "issue_comment",
        "pull_request",
        "pull_request_review",
        "pull_request_review_comment",
        "push",
      ]);
    });

    it("replaces a stale installation row when a reinstall hits the owner uniqueness constraint", async () => {
      const ownerConflictError = new Error("D1_ERROR: UNIQUE constraint failed: github_installations.owner_login");
      let attempt = 0;
      upsertInstallationImpl = async (...args: unknown[]) => {
        installationDbCalls.push({ fn: "upsertInstallation", args });
        if (attempt++ === 0) throw ownerConflictError;
      };
      getConflictingInstallationByOwnerImpl = async () => ({
        installation_id: 999,
        owner_login: "acme-corp",
        owner_id: 1,
        owner_type: "Organization",
        repository_selection: "selected",
        created_at: 100,
        suspended_at: null,
      });

      const body = JSON.stringify(
        buildGithubInstallationPayload({
          installation: { repository_selection: "selected" },
        }),
      );
      const request = await makeSignedRequest(body, "installation");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, REPOS_CACHE: fakeKv };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.action).toBe("created");
      expect(installationDbCalls.map((call) => call.fn)).toEqual([
        "upsertInstallation",
        "replaceConflictingInstallation",
      ]);
      expect(installationDbCalls[1].args[1]).toBe(999);
    });

    it("skips duplicate installation deliveries before bumping cache version", async () => {
      const body = JSON.stringify(
        buildGithubInstallationPayload({
          installation: { repository_selection: "selected" },
        }),
      );
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, REPOS_CACHE: fakeKv };

      const firstRequest = await makeSignedRequest(body, "installation", "delivery-install-1");
      const firstResponse = await githubMod.handleGithubWebhook(firstRequest, env);
      const firstJson = (await firstResponse.json()) as Record<string, unknown>;
      const firstVersion = await fakeKv.get("repos:installations:version");

      const secondRequest = await makeSignedRequest(body, "installation", "delivery-install-1");
      const secondResponse = await githubMod.handleGithubWebhook(secondRequest, env);
      const secondJson = (await secondResponse.json()) as Record<string, unknown>;
      const secondVersion = await fakeKv.get("repos:installations:version");

      expect(firstResponse.status).toBe(200);
      expect(firstJson.ok).toBe(true);
      expect(secondResponse.status).toBe(200);
      expect(secondJson.skipped).toBe(true);
      expect(secondJson.reason).toBe("duplicate");
      expect(installationDbCalls).toHaveLength(1);
      expect(secondVersion).toBe(firstVersion);
    });

    it("handles installation deleted", async () => {
      const body = JSON.stringify(buildGithubInstallationPayload({ action: "deleted" }));
      const request = await makeSignedRequest(body, "installation");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, REPOS_CACHE: fakeKv };

      await githubMod.handleGithubWebhook(request, env);

      expect(installationDbCalls[0].fn).toBe("deleteInstallation");
      expect(installationDbCalls[0].args[1]).toBe(12345);
    });

    it("handles installation suspend", async () => {
      const body = JSON.stringify(buildGithubInstallationPayload({ action: "suspend" }));
      const request = await makeSignedRequest(body, "installation");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, REPOS_CACHE: fakeKv };

      await githubMod.handleGithubWebhook(request, env);

      expect(installationDbCalls[0].fn).toBe("suspendInstallation");
      expect(installationDbCalls[0].args[1]).toBe(12345);
    });

    it("handles installation unsuspend", async () => {
      const body = JSON.stringify(buildGithubInstallationPayload({ action: "unsuspend" }));
      const request = await makeSignedRequest(body, "installation");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, REPOS_CACHE: fakeKv };

      await githubMod.handleGithubWebhook(request, env);

      expect(installationDbCalls[0].fn).toBe("unsuspendInstallation");
      expect(installationDbCalls[0].args[1]).toBe(12345);
    });

    it("persists installation permissions when new permissions are accepted", async () => {
      const body = JSON.stringify(
        buildGithubInstallationPayload({
          action: "new_permissions_accepted",
          installation: {
            repository_selection: "selected",
            permissions: { contents: "write", metadata: "read", pull_requests: "write" },
            events: ["pull_request", "pull_request_review", "pull_request_review_comment"],
          },
        }),
      );
      const request = await makeSignedRequest(body, "installation");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, REPOS_CACHE: fakeKv };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(json.ok).toBe(true);
      expect(json.action).toBe("new_permissions_accepted");
      expect(installationDbCalls[0].fn).toBe("updateInstallationPermissions");
      const params = (installationDbCalls[0].args as [unknown, Record<string, unknown>])[1];
      expect(params.installationId).toBe(12345);
      expect(params.ownerLogin).toBe("acme-corp");
      expect(params.repositorySelection).toBe("selected");
      expect(params.permissions).toEqual({ contents: "write", metadata: "read", pull_requests: "write" });
      expect(params.events).toEqual(["pull_request", "pull_request_review", "pull_request_review_comment"]);
      expect(await fakeKv.get("repos:installations:version")).toBeTruthy();
    });

    it("returns skipped for unhandled installation action", async () => {
      const body = JSON.stringify(buildGithubInstallationPayload({ action: "repositories_added" }));
      const request = await makeSignedRequest(body, "installation");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, REPOS_CACHE: fakeKv };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(json.ok).toBe(true);
      expect(json.skipped).toBe(true);
      expect(installationDbCalls).toHaveLength(0);
    });

    it("returns 400 when installation payload is missing", async () => {
      const body = JSON.stringify({ action: "created" });
      const request = await makeSignedRequest(body, "installation");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, REPOS_CACHE: fakeKv };

      const response = await githubMod.handleGithubWebhook(request, env);
      expect(response.status).toBe(400);
    });

    it("bumps the repo cache version for installation_repositories events", async () => {
      const body = JSON.stringify(buildGithubInstallationRepositoriesPayload());
      const request = await makeSignedRequest(body, "installation_repositories");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, REPOS_CACHE: fakeKv };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.action).toBe("added");
      expect(await fakeKv.get("repos:installations:version")).toBeTruthy();
      expect(installationDbCalls).toContainEqual({
        fn: "deleteCachedInstallationRepos",
        args: [fakeDb, 12345],
      });
      expect(webhookOperationCalls).toContain("deleteCachedInstallationRepos");
      expect(webhookOperationCalls).toContain("kv.put:repos:installations:version");
      expect(webhookOperationCalls.indexOf("deleteCachedInstallationRepos")).toBeLessThan(
        webhookOperationCalls.indexOf("kv.put:repos:installations:version"),
      );
      // A token minted before the grant changed carries stale repo scope; evict it.
      expect(installationDbCalls).toContainEqual({
        fn: "invalidateInstallationTokenCache",
        args: [env, 12345],
      });
    });

    it("skips the installation-version bump when the D1 cache delete fails", async () => {
      deleteCachedInstallationReposImpl = async () => {
        throw new Error("D1 delete failed");
      };
      const body = JSON.stringify(buildGithubInstallationRepositoriesPayload());
      const request = await makeSignedRequest(body, "installation_repositories");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, REPOS_CACHE: fakeKv };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      // Bumping after a failed delete would force user-level misses that re-hydrate
      // a fresh KV entry from the still-stale D1 row, so the bump must be skipped.
      expect(await fakeKv.get("repos:installations:version")).toBeNull();
      expect(webhookOperationCalls).not.toContain("kv.put:repos:installations:version");
    });

    it("skips duplicate installation_repositories deliveries before bumping cache version", async () => {
      const body = JSON.stringify(buildGithubInstallationRepositoriesPayload());
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, REPOS_CACHE: fakeKv };

      const firstRequest = await makeSignedRequest(body, "installation_repositories", "delivery-install-repos-1");
      const firstResponse = await githubMod.handleGithubWebhook(firstRequest, env);
      const firstJson = (await firstResponse.json()) as Record<string, unknown>;
      const firstVersion = await fakeKv.get("repos:installations:version");

      const secondRequest = await makeSignedRequest(body, "installation_repositories", "delivery-install-repos-1");
      const secondResponse = await githubMod.handleGithubWebhook(secondRequest, env);
      const secondJson = (await secondResponse.json()) as Record<string, unknown>;
      const secondVersion = await fakeKv.get("repos:installations:version");

      expect(firstResponse.status).toBe(200);
      expect(firstJson.ok).toBe(true);
      expect(secondResponse.status).toBe(200);
      expect(secondJson.skipped).toBe(true);
      expect(secondJson.reason).toBe("duplicate");
      expect(secondVersion).toBe(firstVersion);
    });
  });

  describe("PR merge notification", () => {
    it("sends PR-merged notification when PR is merged", async () => {
      fakeDb.sessionRefs = [{ session_id: "sess-abc" }];
      const body = JSON.stringify(
        buildGithubPullRequestPayload({
          action: "closed",
          installation: undefined,
          pull_request: {
            merged: true,
          },
        }),
      );
      const request = await makeSignedRequest(body, "pull_request");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, SESSION: {} };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(json.ok).toBe(true);
      expect(json.merged).toBe(true);
      expect(json.notified).toBe(1);
      expect(notifySessionCalls).toEqual([{ sessionId: "sess-abc", prUrl: "https://github.com/org/repo/pull/42" }]);
      expect(sessionStateCalls).toHaveLength(1);
      expect(sessionStateCalls[0].args[3]).toEqual({
        reason: "pr_merged",
        metadata: {
          closeSource: "github_pr_webhook",
          prState: "merged",
          prUrl: "https://github.com/org/repo/pull/42",
          prNumber: 42,
        },
      });
    });

    it("does not send notification when PR is closed without merge", async () => {
      fakeDb.sessionRefs = [{ session_id: "sess-abc" }];
      const body = JSON.stringify(
        buildGithubPullRequestPayload({
          action: "closed",
          installation: undefined,
          pull_request: {
            merged: false,
          },
        }),
      );
      const request = await makeSignedRequest(body, "pull_request");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, SESSION: {} };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(json.ok).toBe(true);
      expect(json.merged).toBe(false);
      expect(json.notified).toBe(0);
      expect(notifySessionCalls).toHaveLength(0);
      // Still archives the session
      expect(sessionStateCalls).toHaveLength(1);
      expect(sessionStateCalls[0].fn).toBe("closeSessionForWebhook");
      expect(sessionStateCalls[0].args[3]).toEqual({
        reason: "pr_closed",
        metadata: {
          closeSource: "github_pr_webhook",
          prState: "closed",
          prUrl: "https://github.com/org/repo/pull/42",
          prNumber: 42,
        },
      });
    });

    it("records clean merged completion outcomes", async () => {
      fakeDb.sessionRefs = [{ session_id: "sess-abc" }];
      fakeDb.completionRows = [
        {
          session_id: "sess-abc",
          prompt_id: "p-1",
          pr_url: "https://github.com/org/repo/pull/42",
          commit_sha: "base-sha",
        },
      ];
      mockCommitShas = ["base-sha"];
      mockReviewComments = [];
      mockCiStatus = "success";
      const body = JSON.stringify(
        buildGithubPullRequestPayload({
          action: "closed",
          installation: { id: 99999 },
          pull_request: {
            merged: true,
          },
        }),
      );
      const request = await makeSignedRequest(body, "pull_request");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, SESSION: {} };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(json.ok).toBe(true);
      expect(githubPrCalls.map((call) => call.fn)).toEqual([
        "getPrReviewComments",
        "getPrCommitShas",
        "getCommitCiStatus",
      ]);
      expect(fakeDb.outcomeUpdates).toEqual([["merged", expect.any(Number), 1, 0, 0, "success", "sess-abc", "p-1"]]);
    });

    it("does not mark merged completion outcomes first-pass until CI succeeds", async () => {
      fakeDb.sessionRefs = [{ session_id: "sess-abc" }];
      fakeDb.completionRows = [
        {
          session_id: "sess-abc",
          prompt_id: "p-1",
          pr_url: "https://github.com/org/repo/pull/42",
          commit_sha: "base-sha",
        },
      ];
      mockCommitShas = ["base-sha"];
      mockReviewComments = [];
      mockCiStatus = "pending";
      const body = JSON.stringify(
        buildGithubPullRequestPayload({
          action: "closed",
          installation: { id: 99999 },
          pull_request: {
            merged: true,
          },
        }),
      );
      const request = await makeSignedRequest(body, "pull_request");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, SESSION: {} };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(json.ok).toBe(true);
      expect(fakeDb.outcomeUpdates).toEqual([["merged", expect.any(Number), 0, 0, 0, "pending", "sess-abc", "p-1"]]);
      expect(notifySessionCalls).toEqual([{ sessionId: "sess-abc", prUrl: "https://github.com/org/repo/pull/42" }]);
    });

    it("deduplicates completion CI status lookups before writing outcomes", async () => {
      fakeDb.sessionRefs = [{ session_id: "sess-abc" }];
      fakeDb.completionRows = [
        {
          session_id: "sess-abc",
          prompt_id: "p-1",
          pr_url: "https://github.com/org/repo/pull/42",
          commit_sha: "base-sha",
        },
        {
          session_id: "sess-abc",
          prompt_id: "p-2",
          pr_url: "https://github.com/org/repo/pull/42",
          commit_sha: "base-sha",
        },
      ];
      mockCommitShas = ["base-sha"];
      mockReviewComments = [];
      mockCiStatus = "success";
      const body = JSON.stringify(
        buildGithubPullRequestPayload({
          action: "closed",
          installation: { id: 99999 },
          pull_request: {
            merged: true,
          },
        }),
      );
      const request = await makeSignedRequest(body, "pull_request");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, SESSION: {} };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(json.ok).toBe(true);
      expect(githubPrCalls.filter((call) => call.fn === "getCommitCiStatus")).toHaveLength(1);
      expect(fakeDb.outcomeUpdates).toEqual([
        ["merged", expect.any(Number), 1, 0, 0, "success", "sess-abc", "p-1"],
        ["merged", expect.any(Number), 1, 0, 0, "success", "sess-abc", "p-2"],
      ]);
    });

    it("records completion outcomes with unknown CI status when CI lookup throws", async () => {
      fakeDb.sessionRefs = [{ session_id: "sess-abc" }];
      fakeDb.completionRows = [
        {
          session_id: "sess-abc",
          prompt_id: "p-1",
          pr_url: "https://github.com/org/repo/pull/42",
          commit_sha: "base-sha",
        },
      ];
      mockCommitShas = ["base-sha"];
      mockReviewComments = [];
      mockCiStatusError = new Error("malformed GitHub status JSON");
      const body = JSON.stringify(
        buildGithubPullRequestPayload({
          action: "closed",
          installation: { id: 99999 },
          pull_request: {
            merged: true,
          },
        }),
      );
      const request = await makeSignedRequest(body, "pull_request");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, SESSION: {} };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(json.ok).toBe(true);
      expect(githubPrCalls.map((call) => call.fn)).toEqual([
        "getPrReviewComments",
        "getPrCommitShas",
        "getCommitCiStatus",
      ]);
      expect(fakeDb.outcomeUpdates).toEqual([["merged", expect.any(Number), 0, 0, 0, "unknown", "sess-abc", "p-1"]]);
    });

    it("keeps successful CI statuses when another commit status lookup throws", async () => {
      fakeDb.sessionRefs = [{ session_id: "sess-abc" }];
      fakeDb.completionRows = [
        {
          session_id: "sess-abc",
          prompt_id: "p-1",
          pr_url: "https://github.com/org/repo/pull/42",
          commit_sha: "base-sha",
        },
        {
          session_id: "sess-abc",
          prompt_id: "p-2",
          pr_url: "https://github.com/org/repo/pull/42",
          commit_sha: "fail-sha",
        },
      ];
      mockCommitShas = ["fail-sha", "base-sha"];
      mockReviewComments = [];
      mockCiStatuses.set("base-sha", "success");
      mockCiStatusErrors.set("fail-sha", new Error("unexpected CI lookup failure"));
      const body = JSON.stringify(
        buildGithubPullRequestPayload({
          action: "closed",
          installation: { id: 99999 },
          pull_request: {
            merged: true,
          },
        }),
      );
      const request = await makeSignedRequest(body, "pull_request");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, SESSION: {} };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(json.ok).toBe(true);
      expect(githubPrCalls.filter((call) => call.fn === "getCommitCiStatus")).toHaveLength(2);
      expect(fakeDb.outcomeUpdates).toEqual([
        ["merged", expect.any(Number), 1, 0, 0, "success", "sess-abc", "p-1"],
        ["merged", expect.any(Number), 0, 0, 1, "unknown", "sess-abc", "p-2"],
      ]);
    });

    it("records closed unmerged completion outcomes for retrieval exclusion", async () => {
      fakeDb.sessionRefs = [{ session_id: "sess-abc" }];
      fakeDb.completionRows = [
        {
          session_id: "sess-abc",
          prompt_id: "p-1",
          pr_url: "https://github.com/org/repo/pull/42",
          commit_sha: "base-sha",
        },
      ];
      mockCommitShas = ["base-sha", "followup-sha"];
      mockReviewComments = [{ id: 1, inReplyToId: null }];
      const body = JSON.stringify(
        buildGithubPullRequestPayload({
          action: "closed",
          installation: { id: 99999 },
          pull_request: {
            merged: false,
          },
        }),
      );
      const request = await makeSignedRequest(body, "pull_request");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, SESSION: {} };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(json.ok).toBe(true);
      expect(fakeDb.outcomeUpdates).toEqual([["closed", expect.any(Number), 0, 1, 1, "success", "sess-abc", "p-1"]]);
      expect(notifySessionCalls).toHaveLength(0);
    });

    it("still archives session when notification fails", async () => {
      fakeDb.sessionRefs = [{ session_id: "sess-abc" }];
      notifySessionPrMergedImpl = async (_env, sessionId, prUrl) => {
        notifySessionCalls.push({ sessionId, prUrl });
        throw new Error("network error");
      };

      const body = JSON.stringify(
        buildGithubPullRequestPayload({
          action: "closed",
          installation: undefined,
          pull_request: {
            merged: true,
          },
        }),
      );
      const request = await makeSignedRequest(body, "pull_request");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, SESSION: {} };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(json.ok).toBe(true);
      expect(json.archived).toBe(1);
      // Session was still closed despite notification failure
      expect(sessionStateCalls).toHaveLength(1);
    });

    it("processes multiple sessions in parallel", async () => {
      fakeDb.sessionRefs = [{ session_id: "sess-1" }, { session_id: "sess-2" }, { session_id: "sess-3" }];
      const body = JSON.stringify(
        buildGithubPullRequestPayload({
          action: "closed",
          installation: undefined,
          pull_request: {
            html_url: "https://github.com/org/repo/pull/99",
            number: 99,
            merged: true,
          },
        }),
      );
      const request = await makeSignedRequest(body, "pull_request");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, SESSION: {} };

      const response = await githubMod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(json.ok).toBe(true);
      expect(json.archived).toBe(3);
      expect(json.notified).toBe(3);
      expect(json.total).toBe(3);
      expect(notifySessionCalls).toHaveLength(3);
      expect(sessionStateCalls).toHaveLength(3);
    });

    it("failure in one session does not prevent other sessions from processing", async () => {
      fakeDb.sessionRefs = [{ session_id: "sess-ok-1" }, { session_id: "sess-fail" }, { session_id: "sess-ok-2" }];

      // Make closeSessionForWebhook throw for the second session
      vi.resetModules();
      vi.doMock("../../apps/control-plane-worker/src/session/state", () => ({
        closeSessionForWebhook: async (...args: unknown[]) => {
          const sessionId = args[2] as string;
          sessionStateCalls.push({ fn: "closeSessionForWebhook", args });
          if (sessionId === "sess-fail") throw new Error("simulated failure");
          return { closed: true };
        },
        notifySessionPrMerged: (...args: Parameters<NotifySessionPrMergedMock>) => notifySessionPrMergedImpl(...args),
        getSessionState: async () => ({ ownerUserId: "user-1", sessionId: "sess-abc", status: "archived" }),
        getSessionExportData: async () => ({ ok: true, events: [], prompts: [] }),
      }));
      const path: string = "../../apps/control-plane-worker/src/webhooks/github";
      const mod = (await import(path)) as unknown as GithubWebhookModule;

      const body = JSON.stringify(
        buildGithubPullRequestPayload({
          action: "closed",
          installation: undefined,
          pull_request: {
            html_url: "https://github.com/org/repo/pull/100",
            number: 100,
            merged: true,
          },
        }),
      );
      const request = await makeSignedRequest(body, "pull_request");
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, SESSION: {} };

      const response = await mod.handleGithubWebhook(request, env);
      const json = (await response.json()) as Record<string, unknown>;

      expect(json.ok).toBe(true);
      // 2 of 3 sessions closed successfully
      expect(json.archived).toBe(2);
      // All 3 were notified (notification happens before close)
      expect(json.notified).toBe(3);
      expect(json.total).toBe(3);
    });
  });

  describe("signature verification", () => {
    it("rejects missing signature", async () => {
      const request = new Request("https://example.com/api/webhooks/github", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb };

      const response = await githubMod.handleGithubWebhook(request, env);
      expect(response.status).toBe(401);
    });

    it("rejects invalid signature", async () => {
      const request = new Request("https://example.com/api/webhooks/github", {
        method: "POST",
        headers: {
          "x-hub-signature-256": "sha256=invalid",
          "content-type": "application/json",
        },
        body: "{}",
      });
      const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb };

      const response = await githubMod.handleGithubWebhook(request, env);
      expect(response.status).toBe(401);
    });
  });
});
