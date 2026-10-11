import { describe, expect, it } from "vitest";

import {
  executionOutcomeFromPhase,
  recordAutomationExecutionOutcome,
  truncateUtf8,
} from "../../apps/control-plane-worker/src/automation/execution-outcome";

describe("automation execution outcomes", () => {
  it("maps only immutable terminal phases", () => {
    expect(executionOutcomeFromPhase("completed")).toBe("completed");
    expect(executionOutcomeFromPhase("blocked")).toBe("blocked");
    expect(executionOutcomeFromPhase("superseded")).toBe("superseded");
    expect(executionOutcomeFromPhase("stopped")).toBeNull();
    expect(executionOutcomeFromPhase("archived")).toBeNull();
  });

  it("truncates execution reasons to the database byte limit without splitting unicode", () => {
    const reason = `${"a".repeat(510)}💥tail`;
    const truncated = truncateUtf8(reason, 512);
    expect(truncated).toBe("a".repeat(510));
    expect(new TextEncoder().encode(truncated!).byteLength).toBeLessThanOrEqual(512);
  });

  it("records exactly one source and preserves the first outcome", async () => {
    const updates: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            if (sql.startsWith("SELECT")) return { all: async () => ({ results: [{ source: "schedule" }] }) };
            updates.push(values);
            return { run: async () => ({ meta: { changes: 1 } }) };
          },
        };
      },
    } as unknown as D1Database;
    await expect(
      recordAutomationExecutionOutcome(db, { sessionId: "s1", phase: "completed", reason: null, completedAt: 10 }),
    ).resolves.toBe("recorded");
    expect(updates).toEqual([["completed", 10, null, 10, "s1"]]);
  });

  it("does not update ambiguous cross-source matches", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: [{ source: "schedule" }, { source: "slack_alert" }] }) }),
      }),
    } as unknown as D1Database;
    await expect(
      recordAutomationExecutionOutcome(db, { sessionId: "s1", phase: "failed", reason: "boom", completedAt: 10 }),
    ).resolves.toBe("ambiguous");
  });
});
