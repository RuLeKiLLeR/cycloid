import { describe, expect, it } from "vitest";

import {
  claimGithubCheckJob,
  leaseGithubCheckJob,
  listDueGithubCheckJobs,
  updateGithubCheckJob,
} from "../../apps/control-plane-worker/src/automation/github-check-db";

describe("GitHub check automation jobs", () => {
  it("claims one job per rule, pull request, and head", async () => {
    const binds: unknown[][] = [];
    const db = {
      prepare: () => ({
        bind: (...values: unknown[]) => {
          binds.push(values);
          return { run: async () => ({ meta: { changes: binds.length === 1 ? 1 : 0 } }) };
        },
      }),
    } as unknown as D1Database;
    const rule = {
      id: "rule-1",
      businessId: "business-1",
      configuredByUserId: "user-1",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      installationId: 1,
      checkName: null,
      modelId: null,
      promptTemplate: "Fix the failing check",
      name: "CI fixer",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const input = { rule, checkRunId: 9, prNumber: 42, headSha: "abc", checkName: "test", now: 10 };
    await expect(claimGithubCheckJob(db, input)).resolves.toBe(true);
    await expect(claimGithubCheckJob(db, input)).resolves.toBe(false);
    expect(binds[0]?.[1]).toBe("rule-1:42:abc");
  });

  it("recovers prompt checkpoints and guards updates with the current lease", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            statements.push({ sql, values });
            return {
              all: async () => ({ results: [] }),
              run: async () => ({ meta: { changes: 1 } }),
            };
          },
        };
      },
    } as unknown as D1Database;

    await listDueGithubCheckJobs(db, 10, 5);
    const leaseOwner = await leaseGithubCheckJob(db, "job-1", 10);
    expect(leaseOwner).toBeTruthy();
    await updateGithubCheckJob(db, {
      id: "job-1",
      phase: "prompt_enqueued",
      sessionId: "session-1",
      reason: null,
      now: 10,
      leaseOwner: leaseOwner!,
    });

    expect(statements[0]!.sql).toContain("'prompt_enqueued'");
    expect(statements[1]!.sql).toContain("'prompt_enqueued'");
    expect(statements[2]!.sql).toContain("lease_owner=?");
    expect(statements[2]!.values.at(-1)).toBe(leaseOwner);
  });
});
