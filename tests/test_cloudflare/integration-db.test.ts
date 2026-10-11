import { beforeEach, describe, expect, it } from "vitest";

import {
  buildGithubCredentialData,
  connectIntegration,
  disconnectIntegration,
  getUserByExternalId,
  readBusinessCredentialRow,
} from "../../apps/control-plane-worker/src/integrations/db.js";

type UserRow = {
  id: number;
  login: string | null;
};

type IntegrationRow = {
  user_id: number;
  integration_id: string;
  oauth_access_token: string | null;
  oauth_refresh_token: string | null;
  oauth_expires_at: number | null;
  api_key: string | null;
  external_user_id: string | null;
  service_url: string | null;
  encrypted: number;
  connected_at: number;
  updated_at: number;
};

type BusinessCredentialRow = {
  business_id: string;
  integration_id: string;
  api_key: string | null;
  oauth_access_token: string | null;
  service_url: string | null;
  encrypted: number | null;
};

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
      if (!row) return null;

      const selectedColumns =
        this.query
          .match(/SELECT\s+(.+?)\s+FROM business_integration_credentials/s)?.[1]
          ?.split(",")
          .map((column) => column.trim()) ?? [];
      return Object.fromEntries(
        selectedColumns.map((column) => [column, row[column as keyof BusinessCredentialRow]]),
      ) as T;
    }

    if (this.query.includes("FROM user_integrations") && this.query.includes("INNER JOIN users")) {
      const [integrationId, externalUserId] = this.boundValues as [string, string];
      for (const row of this.db.integrations.values()) {
        if (row.integration_id === integrationId && row.external_user_id === externalUserId) {
          const user = this.db.users.get(row.user_id);
          if (user) {
            return { id: user.id, login: user.login } as T;
          }
        }
      }
      return null;
    }

    throw new Error(`Unhandled first query: ${this.query}`);
  }

  async run(): Promise<{ success: true; meta: { last_row_id: number } }> {
    if (this.query.includes("INSERT INTO user_integrations")) {
      const [
        userId,
        integrationId,
        oauthAccessToken,
        oauthRefreshToken,
        oauthExpiresAt,
        apiKey,
        externalUserId,
        serviceUrl,
        encrypted,
        _lastValidatedAt,
        _lastValidationStatus,
        _lastValidationReasonCode,
        connectedAt,
        updatedAt,
      ] = this.boundValues as [
        number,
        string,
        string | null,
        string | null,
        number | null,
        string | null,
        string | null,
        string | null,
        number,
        number | null,
        string | null,
        string | null,
        number,
        number,
      ];

      this.db.integrations.set(`${userId}:${integrationId}`, {
        user_id: userId,
        integration_id: integrationId,
        oauth_access_token: oauthAccessToken,
        oauth_refresh_token: oauthRefreshToken,
        oauth_expires_at: oauthExpiresAt,
        api_key: apiKey,
        external_user_id: externalUserId,
        service_url: serviceUrl,
        encrypted,
        connected_at: connectedAt,
        updated_at: updatedAt,
      });
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("DELETE FROM user_integrations")) {
      const [userId, integrationId] = this.boundValues as [number, string];
      this.db.integrations.delete(`${userId}:${integrationId}`);
      return { success: true, meta: { last_row_id: 0 } };
    }

    throw new Error(`Unhandled run query: ${this.query}`);
  }
}

class FakeD1 {
  readonly users = new Map<number, UserRow>();
  readonly integrations = new Map<string, IntegrationRow>();
  readonly businessCredentials = new Map<string, BusinessCredentialRow>();

  addUser(id: number, login: string): void {
    this.users.set(id, { id, login });
  }

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }
}

describe("readBusinessCredentialRow", () => {
  let db: FakeD1;

  beforeEach(() => {
    db = new FakeD1();
    db.businessCredentials.set("biz-1:datadog", {
      business_id: "biz-1",
      integration_id: "datadog",
      api_key: "api-key",
      oauth_access_token: "app-key",
      service_url: "us5.datadoghq.com",
      encrypted: 1,
    });
  });

  it("returns only the requested business credential columns", async () => {
    await expect(
      readBusinessCredentialRow(db as never, "biz-1", "datadog", ["api_key", "service_url", "encrypted"]),
    ).resolves.toEqual({
      api_key: "api-key",
      service_url: "us5.datadoghq.com",
      encrypted: 1,
    });
  });

  it("returns null when the business credential row is missing", async () => {
    await expect(readBusinessCredentialRow(db as never, "biz-1", "cloudflare", ["api_key"])).resolves.toBeNull();
  });

  it("rejects columns outside the allowlist before touching the database", async () => {
    await expect(
      readBusinessCredentialRow(db as never, "biz-1", "datadog", ["api_key; DROP TABLE" as never]),
    ).rejects.toThrow(/unknown column/);
  });
});

describe("integrations/db legacy Slack compatibility", () => {
  let db: FakeD1;

  beforeEach(() => {
    db = new FakeD1();
    db.addUser(42, "slack-user");
  });

  it("stores legacy Slack external user ids via connectIntegration", async () => {
    await connectIntegration(db as never, 42, "slack", { externalUserId: "USLACK42" });

    expect(db.integrations.get("42:slack")?.external_user_id).toBe("USLACK42");
  });

  it("deletes legacy Slack rows via disconnectIntegration", async () => {
    await connectIntegration(db as never, 42, "slack", { externalUserId: "USLACK42" });

    await disconnectIntegration(db as never, 42, "slack");

    expect(db.integrations.has("42:slack")).toBe(false);
  });

  it("resolves linked users from legacy Slack external ids", async () => {
    await connectIntegration(db as never, 42, "slack", { externalUserId: "USLACK42" });

    await expect(getUserByExternalId(db as never, "slack", "USLACK42")).resolves.toEqual({
      id: 42,
      login: "slack-user",
    });
  });
});

describe("buildGithubCredentialData", () => {
  it("throws without an encryption key instead of returning plaintext", async () => {
    await expect(buildGithubCredentialData("gho_access", "ghr_refresh", null, undefined)).rejects.toThrow(
      "TOKEN_ENCRYPTION_KEY is required to store GitHub tokens",
    );
  });

  it("encrypts access and refresh tokens with a key", async () => {
    const data = await buildGithubCredentialData("gho_access", "ghr_refresh", 123, "test-encryption-key");
    expect(data.encrypted).toBe(true);
    expect(data.oauthAccessToken).toMatch(/^enc:/);
    expect(data.oauthRefreshToken).toMatch(/^enc:/);
    expect(data.oauthExpiresAt).toBe(123);
  });
});
