import { describe, expect, it } from "vitest";

import { BaseFakeD1Statement, batchFakeD1Statements } from "./fake-d1";

class InspectableStatement extends BaseFakeD1Statement<null> {
  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    return { results: [{ values: [...this.boundValues] }] };
  }
}

class OrderedRunStatement extends BaseFakeD1Statement<{ events: string[] }> {
  constructor(
    db: { events: string[] },
    query: string,
    private readonly shouldFail = false,
  ) {
    super(db, query);
  }

  async run(): Promise<{ success: true }> {
    this.db.events.push(`start:${this.query}`);
    if (this.shouldFail) {
      throw new Error(this.query);
    }
    this.db.events.push(`end:${this.query}`);
    return { success: true };
  }
}

describe("fake-d1 helpers", () => {
  it("returns a new bound statement without mutating the original", async () => {
    const statement = new InspectableStatement(null, "SELECT 1");

    const first = statement.bind("alpha");
    const second = statement.bind("beta");

    expect(first).not.toBe(statement);
    expect(second).not.toBe(statement);

    await expect(statement.executeBatch()).resolves.toEqual({ results: [{ values: [] }] });
    await expect(first.executeBatch()).resolves.toEqual({ results: [{ values: ["alpha"] }] });
    await expect(second.executeBatch()).resolves.toEqual({ results: [{ values: ["beta"] }] });
  });

  it("executes fake batches sequentially in input order", async () => {
    const db = { events: [] as string[] };

    await expect(
      batchFakeD1Statements([new OrderedRunStatement(db, "first"), new OrderedRunStatement(db, "second")]),
    ).resolves.toEqual([{ results: [] }, { results: [] }]);

    expect(db.events).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("stops executing fake batches after the first failure", async () => {
    const db = { events: [] as string[] };

    await expect(
      batchFakeD1Statements([
        new OrderedRunStatement(db, "first"),
        new OrderedRunStatement(db, "fail", true),
        new OrderedRunStatement(db, "third"),
      ]),
    ).rejects.toThrow("fail");

    expect(db.events).toEqual(["start:first", "end:first", "start:fail"]);
  });
});
