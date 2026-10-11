import { describe, expect, it } from "vitest";

import {
  connectBusinessCredentials,
  disconnectBusinessCredentials,
} from "../../apps/control-plane-worker/src/integrations/service.js";
import { CREDENTIAL_VALIDATION_STATUS } from "../../shared/constants/onboarding.js";

class RecordingStatement {
  boundValues: unknown[] = [];

  constructor(
    private readonly db: RecordingD1,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  async run(): Promise<{ success: true; meta: { last_row_id: number } }> {
    if (this.db.insideBatch) {
      this.db.batchRuns.push(this);
    } else {
      this.db.standaloneRuns.push(this);
    }
    return { success: true, meta: { last_row_id: 0 } };
  }
}

class RecordingD1 {
  readonly prepared: RecordingStatement[] = [];
  readonly batches: RecordingStatement[][] = [];
  readonly standaloneRuns: RecordingStatement[] = [];
  readonly batchRuns: RecordingStatement[] = [];
  insideBatch = false;

  prepare(query: string): RecordingStatement {
    const statement = new RecordingStatement(this, query);
    this.prepared.push(statement);
    return statement;
  }

  async batch(statements: RecordingStatement[]): Promise<Array<{ success: true; meta: { last_row_id: number } }>> {
    this.batches.push(statements);
    this.insideBatch = true;
    try {
      return await Promise.all(statements.map((statement) => statement.run()));
    } finally {
      this.insideBatch = false;
    }
  }
}

describe("integrations/service business credentials", () => {
  it("stores provider business keys as saved_unverified until validation succeeds", async () => {
    const db = new RecordingD1();

    await connectBusinessCredentials(
      db as never,
      "biz-1",
      "openai",
      { apiKey: "openai-business-key" },
      "test-encryption-key",
    );

    expect(db.standaloneRuns).toHaveLength(1);
    const [statement] = db.standaloneRuns;
    expect(statement.query).toContain("INSERT INTO business_integration_credentials");
    expect(statement.boundValues).toContain(CREDENTIAL_VALIDATION_STATUS.SAVED_UNVERIFIED);
  });

  it("disconnects business credentials and resets user-scoped providers in one D1 batch", async () => {
    const db = new RecordingD1();

    await disconnectBusinessCredentials(db as never, "biz-1", "openai");

    expect(db.standaloneRuns).toHaveLength(0);
    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(2);
    expect(db.batchRuns).toEqual(db.batches[0]);

    const [deleteStatement, scopeStatement] = db.batches[0];
    expect(deleteStatement.query).toContain("DELETE FROM business_integration_credentials");
    expect(deleteStatement.boundValues).toEqual(["biz-1", "openai"]);
    expect(scopeStatement.query).toContain("INSERT INTO business_integrations");
    expect(scopeStatement.boundValues.slice(0, 3)).toEqual(["biz-1", "openai", "user"]);
    expect(scopeStatement.boundValues[3]).toEqual(scopeStatement.boundValues[4]);
    expect(typeof scopeStatement.boundValues[3]).toBe("number");
  });

  it.each(["sentry", "stripe"] as const)(
    "resets business-only provider %s to disabled in the same D1 batch",
    async (integrationId) => {
      const db = new RecordingD1();

      await disconnectBusinessCredentials(db as never, "biz-1", integrationId);

      expect(db.standaloneRuns).toHaveLength(0);
      expect(db.batches).toHaveLength(1);
      const [, scopeStatement] = db.batches[0];
      expect(scopeStatement.boundValues.slice(0, 3)).toEqual(["biz-1", integrationId, "disabled"]);
    },
  );
});
