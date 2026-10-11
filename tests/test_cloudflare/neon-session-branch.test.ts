import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTracedFetch = vi.fn<(...args: unknown[]) => Promise<Response>>();

vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch: (...args: unknown[]) => mockTracedFetch(...args),
}));

import {
  cleanupSessionNeonBranch,
  resolveSessionNeonBranchCredentialEnvs,
  SESSION_NEON_BRANCH_STORAGE_KEY,
} from "../../apps/control-plane-worker/src/integrations/neon";
import { encrypt } from "../../apps/control-plane-worker/src/settings/encryption";
import { serializeNeonBranchCredentialConfig } from "../../shared/integrations/neon";

const ENCRYPTION_KEY = "1bb2dbb43d088fff13406273596faabf78ddb53fa37da918555f90146de7bb2a";

type BusinessCredentialRow = {
  api_key: string | null;
  service_url: string | null;
  encrypted: number | null;
};

class FakeStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class FakeD1Statement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes("FROM business_integration_credentials")) {
      const [businessId, integrationId] = this.boundValues as [string, string];
      const row = this.db.businessCredentials.get(`${businessId}:${integrationId}`);
      return row ? ({ ...row } as T) : null;
    }
    if (this.query.includes("FROM business_integrations")) {
      const [businessId, integrationId] = this.boundValues as [string, string];
      const row = this.db.integrationScopes.get(`${businessId}:${integrationId}`);
      return row ? ({ scope: row } as T) : null;
    }
    throw new Error(`Unhandled query: ${this.query}`);
  }

  async all<T>(): Promise<D1Result<T>> {
    if (this.query.includes("FROM business_integrations")) {
      const [businessId] = this.boundValues as [string];
      const results = [...this.db.integrationScopes.entries()]
        .filter(([key]) => key.startsWith(`${businessId}:`))
        .map(([key, scope]) => {
          const integrationId = key.slice(`${businessId}:`.length);
          return { integration_id: integrationId, scope } as T;
        });
      return { results, success: true, meta: {} };
    }
    throw new Error(`Unhandled query: ${this.query}`);
  }
}

class FakeD1 {
  readonly businessCredentials = new Map<string, BusinessCredentialRow>();
  readonly integrationScopes = new Map<string, "disabled" | "user" | "business">();

  constructor() {
    this.integrationScopes.set("biz-1:neon", "business");
  }

  prepare(query: string): D1PreparedStatement {
    return new FakeD1Statement(this, query) as unknown as D1PreparedStatement;
  }
}

describe("Neon session branch helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates one Neon branch per session and reuses it across respawns", async () => {
    const db = new FakeD1();
    const storage = new FakeStorage();
    db.businessCredentials.set("biz-1:neon", {
      api_key: "neon-api-key",
      service_url: serializeNeonBranchCredentialConfig({
        projectId: "project-123",
        parentBranchId: "br-main",
      }),
      encrypted: 0,
    });

    mockTracedFetch.mockImplementation(async (_url, init) => {
      const request = init as RequestInit;
      if (request.method !== "POST") {
        throw new Error(`Unexpected request method: ${request.method ?? "GET"}`);
      }
      const body = typeof request.body === "string" ? JSON.parse(request.body) : null;
      expect(body).toEqual({
        branch: { name: expect.stringMatching(/^cycloid-[a-f0-9]{16}$/), parent_id: "br-main" },
        endpoints: [{ type: "read_write" }],
      });
      return new Response(
        JSON.stringify({
          branch: {
            id: "br-session-1",
            name: "cycloid-branch",
            connection_uris: [{ connection_uri: "postgres://branch-1" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const declarations = [{ name: "database-url", envVar: "DATABASE_URL", source: "business_neon_branch" }] as const;
    const first = await resolveSessionNeonBranchCredentialEnvs(db as unknown as D1Database, {
      storage,
      businessId: "biz-1",
      sessionId: "sess-1",
      repoOwner: "acme",
      repoName: "widgets",
      declarations,
      encryptionKey: undefined,
    });
    const second = await resolveSessionNeonBranchCredentialEnvs(db as unknown as D1Database, {
      storage,
      businessId: "biz-1",
      sessionId: "sess-1",
      repoOwner: "acme",
      repoName: "widgets",
      declarations,
      encryptionKey: undefined,
    });

    expect(first).toEqual({ DATABASE_URL: "postgres://branch-1" });
    expect(second).toEqual({ DATABASE_URL: "postgres://branch-1" });
    expect(storage.values.get(SESSION_NEON_BRANCH_STORAGE_KEY)).toEqual(
      expect.objectContaining({
        projectId: "project-123",
        parentBranchId: "br-main",
        branchId: "br-session-1",
        connectionUri: "postgres://branch-1",
      }),
    );
    expect(mockTracedFetch).toHaveBeenCalledTimes(1);
  });

  it("uses the project default branch when no parent branch is configured", async () => {
    const db = new FakeD1();
    const storage = new FakeStorage();
    db.businessCredentials.set("biz-1:neon", {
      api_key: "neon-api-key",
      service_url: serializeNeonBranchCredentialConfig({
        projectId: "project-123",
      }),
      encrypted: 0,
    });

    mockTracedFetch.mockImplementation(async (_url, init) => {
      const request = init as RequestInit;
      const body = typeof request.body === "string" ? JSON.parse(request.body) : null;
      expect(body).toEqual({
        branch: { name: expect.stringMatching(/^cycloid-[a-f0-9]{16}$/) },
        endpoints: [{ type: "read_write" }],
      });
      return new Response(
        JSON.stringify({
          branch: {
            id: "br-session-2",
            name: "cycloid-branch",
            connection_uris: [{ connection_uri: "postgres://branch-2" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const envs = await resolveSessionNeonBranchCredentialEnvs(db as unknown as D1Database, {
      storage,
      businessId: "biz-1",
      sessionId: "sess-2",
      repoOwner: "acme",
      repoName: "widgets",
      declarations: [{ name: "database-url", envVar: "DATABASE_URL", source: "business_neon_branch" }],
      encryptionKey: undefined,
    });

    expect(envs).toEqual({ DATABASE_URL: "postgres://branch-2" });
  });

  it("deletes the stored Neon branch on session close", async () => {
    const db = new FakeD1();
    const storage = new FakeStorage();
    db.businessCredentials.set("biz-1:neon", {
      api_key: "neon-api-key",
      service_url: serializeNeonBranchCredentialConfig({
        projectId: "project-123",
        parentBranchId: "br-main",
      }),
      encrypted: 0,
    });
    await storage.put(SESSION_NEON_BRANCH_STORAGE_KEY, {
      projectId: "project-123",
      parentBranchId: "br-main",
      branchId: "br-session-1",
      branchName: "cycloid-branch",
      connectionUri: "postgres://branch-1",
      createdAt: Date.now(),
    });

    mockTracedFetch.mockResolvedValue(new Response("", { status: 200 }));

    await cleanupSessionNeonBranch(db as unknown as D1Database, {
      storage,
      businessId: "biz-1",
      sessionId: "sess-1",
      encryptionKey: undefined,
    });

    expect(mockTracedFetch).toHaveBeenCalledTimes(1);
    expect(mockTracedFetch.mock.calls[0]?.[0]).toContain("/projects/project-123/branches/br-session-1");
    expect(storage.values.has(SESSION_NEON_BRANCH_STORAGE_KEY)).toBe(false);
  });

  it("fails closed when the workspace Neon integration is missing", async () => {
    const db = new FakeD1();

    await expect(
      resolveSessionNeonBranchCredentialEnvs(db as unknown as D1Database, {
        storage: new FakeStorage(),
        businessId: "biz-1",
        sessionId: "sess-1",
        repoOwner: "acme",
        repoName: "widgets",
        declarations: [{ name: "database-url", envVar: "DATABASE_URL", source: "business_neon_branch" }],
        encryptionKey: undefined,
      }),
    ).rejects.toThrow("workspace Neon integration is not fully configured");
  });

  it("returns an empty env map when no Neon declarations are present", async () => {
    const db = new FakeD1();

    const envs = await resolveSessionNeonBranchCredentialEnvs(db as unknown as D1Database, {
      storage: new FakeStorage(),
      businessId: "biz-1",
      sessionId: "sess-1",
      repoOwner: "acme",
      repoName: "widgets",
      declarations: [{ name: "openai", envVar: "OPENAI_API_KEY", source: "business_openai_key" }],
      encryptionKey: undefined,
    });

    expect(envs).toEqual({});
    expect(mockTracedFetch).not.toHaveBeenCalled();
  });

  it("maps multiple declared env vars to the same branch connection URI", async () => {
    const db = new FakeD1();
    const storage = new FakeStorage();
    db.businessCredentials.set("biz-1:neon", {
      api_key: "neon-api-key",
      service_url: serializeNeonBranchCredentialConfig({ projectId: "project-123" }),
      encrypted: 0,
    });

    mockTracedFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          branch: {
            id: "br-session-3",
            name: "cycloid-branch",
            connection_uris: [{ connection_uri: "postgres://branch-3" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const envs = await resolveSessionNeonBranchCredentialEnvs(db as unknown as D1Database, {
      storage,
      businessId: "biz-1",
      sessionId: "sess-3",
      repoOwner: "acme",
      repoName: "widgets",
      declarations: [
        { name: "database-url", envVar: "DATABASE_URL", source: "business_neon_branch" },
        { name: "database-url-shadow", envVar: "SHADOW_DATABASE_URL", source: "business_neon_branch" },
      ],
      encryptionKey: undefined,
    });

    expect(envs).toEqual({
      DATABASE_URL: "postgres://branch-3",
      SHADOW_DATABASE_URL: "postgres://branch-3",
    });
  });

  it("decrypts encrypted workspace credentials before calling Neon", async () => {
    const db = new FakeD1();
    const storage = new FakeStorage();
    const encryptedApiKey = await encrypt("neon-api-key", ENCRYPTION_KEY);
    db.businessCredentials.set("biz-1:neon", {
      api_key: encryptedApiKey,
      service_url: serializeNeonBranchCredentialConfig({ projectId: "project-123" }),
      encrypted: 1,
    });

    mockTracedFetch.mockImplementation(async (_url, init) => {
      const headers = new Headers((init as RequestInit).headers);
      expect(headers.get("authorization")).toBe("Bearer neon-api-key");
      return new Response(
        JSON.stringify({
          branch: {
            id: "br-session-4",
            name: "cycloid-branch",
            connection_uris: [{ connection_uri: "postgres://branch-4" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const envs = await resolveSessionNeonBranchCredentialEnvs(db as unknown as D1Database, {
      storage,
      businessId: "biz-1",
      sessionId: "sess-4",
      repoOwner: "acme",
      repoName: "widgets",
      declarations: [{ name: "database-url", envVar: "DATABASE_URL", source: "business_neon_branch" }],
      encryptionKey: ENCRYPTION_KEY,
    });

    expect(envs).toEqual({ DATABASE_URL: "postgres://branch-4" });
  });

  it("fails closed when encrypted credentials cannot be decrypted", async () => {
    const db = new FakeD1();
    const encryptedApiKey = await encrypt("neon-api-key", ENCRYPTION_KEY);
    db.businessCredentials.set("biz-1:neon", {
      api_key: encryptedApiKey,
      service_url: serializeNeonBranchCredentialConfig({ projectId: "project-123" }),
      encrypted: 1,
    });

    await expect(
      resolveSessionNeonBranchCredentialEnvs(db as unknown as D1Database, {
        storage: new FakeStorage(),
        businessId: "biz-1",
        sessionId: "sess-5",
        repoOwner: "acme",
        repoName: "widgets",
        declarations: [{ name: "database-url", envVar: "DATABASE_URL", source: "business_neon_branch" }],
        encryptionKey: undefined,
      }),
    ).rejects.toThrow("workspace Neon integration is not fully configured");
  });

  it("surfaces auth failures from the Neon API", async () => {
    const db = new FakeD1();
    db.businessCredentials.set("biz-1:neon", {
      api_key: "neon-api-key",
      service_url: serializeNeonBranchCredentialConfig({ projectId: "project-123" }),
      encrypted: 0,
    });

    mockTracedFetch.mockResolvedValue(
      new Response(JSON.stringify({ message: "invalid api key" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      resolveSessionNeonBranchCredentialEnvs(db as unknown as D1Database, {
        storage: new FakeStorage(),
        businessId: "biz-1",
        sessionId: "sess-6",
        repoOwner: "acme",
        repoName: "widgets",
        declarations: [{ name: "database-url", envVar: "DATABASE_URL", source: "business_neon_branch" }],
        encryptionKey: undefined,
      }),
    ).rejects.toThrow("Neon rejected the workspace API key");
  });

  it("fails closed when Neon returns an incomplete branch payload", async () => {
    const db = new FakeD1();
    db.businessCredentials.set("biz-1:neon", {
      api_key: "neon-api-key",
      service_url: serializeNeonBranchCredentialConfig({ projectId: "project-123" }),
      encrypted: 0,
    });

    mockTracedFetch.mockResolvedValue(
      new Response(JSON.stringify({ branch: { id: "br-session-7" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      resolveSessionNeonBranchCredentialEnvs(db as unknown as D1Database, {
        storage: new FakeStorage(),
        businessId: "biz-1",
        sessionId: "sess-7",
        repoOwner: "acme",
        repoName: "widgets",
        declarations: [{ name: "database-url", envVar: "DATABASE_URL", source: "business_neon_branch" }],
        encryptionKey: undefined,
      }),
    ).rejects.toThrow("failed to provision a Neon branch");
  });

  it("no-ops cleanup when no branch record is stored", async () => {
    await cleanupSessionNeonBranch(new FakeD1() as unknown as D1Database, {
      storage: new FakeStorage(),
      businessId: "biz-1",
      sessionId: "sess-8",
      encryptionKey: undefined,
    });

    expect(mockTracedFetch).not.toHaveBeenCalled();
  });

  it("skips cleanup when business DB context is unavailable", async () => {
    const storage = new FakeStorage();
    await storage.put(SESSION_NEON_BRANCH_STORAGE_KEY, {
      projectId: "project-123",
      parentBranchId: null,
      branchId: "br-session-8",
      branchName: "cycloid-branch",
      connectionUri: "postgres://branch-8",
      createdAt: Date.now(),
    });

    await cleanupSessionNeonBranch(undefined, {
      storage,
      businessId: "biz-1",
      sessionId: "sess-8",
      encryptionKey: undefined,
    });

    expect(mockTracedFetch).not.toHaveBeenCalled();
    expect(storage.values.has(SESSION_NEON_BRANCH_STORAGE_KEY)).toBe(true);
  });

  it("treats a 404 delete response as successful cleanup", async () => {
    const db = new FakeD1();
    const storage = new FakeStorage();
    db.businessCredentials.set("biz-1:neon", {
      api_key: "neon-api-key",
      service_url: serializeNeonBranchCredentialConfig({ projectId: "project-123" }),
      encrypted: 0,
    });
    await storage.put(SESSION_NEON_BRANCH_STORAGE_KEY, {
      projectId: "project-123",
      parentBranchId: null,
      branchId: "br-session-9",
      branchName: "cycloid-branch",
      connectionUri: "postgres://branch-9",
      createdAt: Date.now(),
    });

    mockTracedFetch.mockResolvedValue(new Response("", { status: 404 }));

    await cleanupSessionNeonBranch(db as unknown as D1Database, {
      storage,
      businessId: "biz-1",
      sessionId: "sess-9",
      encryptionKey: undefined,
    });

    expect(storage.values.has(SESSION_NEON_BRANCH_STORAGE_KEY)).toBe(false);
  });

  it("recreates the session branch when workspace Neon config changes", async () => {
    const db = new FakeD1();
    const storage = new FakeStorage();
    db.businessCredentials.set("biz-1:neon", {
      api_key: "neon-api-key",
      service_url: serializeNeonBranchCredentialConfig({
        projectId: "project-new",
        parentBranchId: "br-new-parent",
      }),
      encrypted: 0,
    });
    await storage.put(SESSION_NEON_BRANCH_STORAGE_KEY, {
      projectId: "project-old",
      parentBranchId: "br-old-parent",
      branchId: "br-session-stale",
      branchName: "cycloid-branch",
      connectionUri: "postgres://stale-branch",
      createdAt: Date.now(),
    });

    mockTracedFetch.mockImplementation(async (url, init) => {
      const request = init as RequestInit;
      if (request.method === "DELETE") {
        expect(String(url)).toContain("/projects/project-old/branches/br-session-stale");
        return new Response("", { status: 200 });
      }
      return new Response(
        JSON.stringify({
          branch: {
            id: "br-session-fresh",
            name: "cycloid-branch",
            connection_uris: [{ connection_uri: "postgres://fresh-branch" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const envs = await resolveSessionNeonBranchCredentialEnvs(db as unknown as D1Database, {
      storage,
      businessId: "biz-1",
      sessionId: "sess-stale",
      repoOwner: "acme",
      repoName: "widgets",
      declarations: [{ name: "database-url", envVar: "DATABASE_URL", source: "business_neon_branch" }],
      encryptionKey: undefined,
    });

    expect(envs).toEqual({ DATABASE_URL: "postgres://fresh-branch" });
    expect(mockTracedFetch).toHaveBeenCalledTimes(2);
    expect(storage.values.get(SESSION_NEON_BRANCH_STORAGE_KEY)).toEqual(
      expect.objectContaining({
        projectId: "project-new",
        parentBranchId: "br-new-parent",
        branchId: "br-session-fresh",
        connectionUri: "postgres://fresh-branch",
      }),
    );
  });

  it("keeps the stored branch record when delete fails", async () => {
    const db = new FakeD1();
    const storage = new FakeStorage();
    db.businessCredentials.set("biz-1:neon", {
      api_key: "neon-api-key",
      service_url: serializeNeonBranchCredentialConfig({ projectId: "project-123" }),
      encrypted: 0,
    });
    await storage.put(SESSION_NEON_BRANCH_STORAGE_KEY, {
      projectId: "project-123",
      parentBranchId: null,
      branchId: "br-session-10",
      branchName: "cycloid-branch",
      connectionUri: "postgres://branch-10",
      createdAt: Date.now(),
    });

    mockTracedFetch.mockResolvedValue(
      new Response(JSON.stringify({ message: "server error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      cleanupSessionNeonBranch(db as unknown as D1Database, {
        storage,
        businessId: "biz-1",
        sessionId: "sess-10",
        encryptionKey: undefined,
      }),
    ).resolves.toBeUndefined();

    expect(storage.values.has(SESSION_NEON_BRANCH_STORAGE_KEY)).toBe(true);
  });

  it("reads connection URIs from the create-branch response root", async () => {
    const db = new FakeD1();
    const storage = new FakeStorage();
    db.businessCredentials.set("biz-1:neon", {
      api_key: "neon-api-key",
      service_url: serializeNeonBranchCredentialConfig({ projectId: "project-123" }),
      encrypted: 0,
    });

    mockTracedFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          branch: { id: "br-session-root", name: "cycloid-branch" },
          connection_uris: [{ connection_uri: "postgres://root-level-uri" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const envs = await resolveSessionNeonBranchCredentialEnvs(db as unknown as D1Database, {
      storage,
      businessId: "biz-1",
      sessionId: "sess-root",
      repoOwner: "acme",
      repoName: "widgets",
      declarations: [{ name: "database-url", envVar: "DATABASE_URL", source: "business_neon_branch" }],
      encryptionKey: undefined,
    });

    expect(envs).toEqual({ DATABASE_URL: "postgres://root-level-uri" });
  });

  it("fails closed when the Neon integration scope is not business", async () => {
    const db = new FakeD1();
    const storage = new FakeStorage();
    db.integrationScopes.set("biz-1:neon", "disabled");
    db.businessCredentials.set("biz-1:neon", {
      api_key: "neon-api-key",
      service_url: serializeNeonBranchCredentialConfig({ projectId: "project-123" }),
      encrypted: 0,
    });

    await expect(
      resolveSessionNeonBranchCredentialEnvs(db as unknown as D1Database, {
        storage,
        businessId: "biz-1",
        sessionId: "sess-disabled",
        repoOwner: "acme",
        repoName: "widgets",
        declarations: [{ name: "database-url", envVar: "DATABASE_URL", source: "business_neon_branch" }],
        encryptionKey: undefined,
      }),
    ).rejects.toThrow(/Neon integration is disabled/);

    expect(mockTracedFetch).not.toHaveBeenCalled();
  });
});
