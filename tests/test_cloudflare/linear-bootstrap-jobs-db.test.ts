// DAO tests for the Linear webhook bootstrap job table (ARC-1051): the atomic
// ref+job claim, due-listing/lease semantics, phase-conditional transitions,
// reschedule/terminal, and the both-keys-scoped delete.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  claimLinearBootstrapJob,
  claimLinearBootstrapJobLease,
  deleteLinearBootstrapJob,
  getLinearBootstrapJob,
  listDueLinearBootstrapJobs,
  markLinearBootstrapJobTerminal,
  rescheduleLinearBootstrapJob,
  updateLinearBootstrapJobPhase,
} from "../../apps/control-plane-worker/src/webhooks/db";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

// Minimal D1 adapter over better-sqlite3 with all migrations applied.
class Stmt {
  private vals: unknown[] = [];
  constructor(
    private readonly sqlite: Database.Database,
    private readonly q: string,
  ) {}
  bind(...v: unknown[]): this {
    this.vals = v;
    return this;
  }
  async run() {
    const r = this.sqlite.prepare(this.q).run(...(this.vals as never[]));
    return { success: true as const, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid ?? 0) } };
  }
  async first<T>(): Promise<T | null> {
    return (this.sqlite.prepare(this.q).get(...(this.vals as never[])) as T | undefined) ?? null;
  }
  async all<T>() {
    return { results: this.sqlite.prepare(this.q).all(...(this.vals as never[])) as T[] };
  }
}
class FakeD1 {
  readonly sqlite = new Database(":memory:");
  constructor() {
    this.sqlite.pragma("foreign_keys = ON");
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      this.sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
    }
  }
  prepare(q: string) {
    return new Stmt(this.sqlite, q);
  }
  async batch(stmts: Stmt[]) {
    const out: Awaited<ReturnType<Stmt["run"]>>[] = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
}

const baseInput = (overrides: Partial<Parameters<typeof claimLinearBootstrapJob>[1]> = {}) => ({
  linearIssueId: "issue-1",
  sessionId: "sess-1",
  businessId: "biz-1",
  actorUserId: "42",
  repoOwner: "acme",
  repoName: "repo",
  installationId: 123,
  model: null,
  promptTemplate: "PROMPT",
  issueSnapshot: JSON.stringify({ issue: { id: "issue-1" } }),
  uploadedImages: [],
  retryAfterMs: 1_000,
  nowMs: 1_000,
  ...overrides,
});

let db: FakeD1;
beforeEach(() => {
  db = new FakeD1();
});

describe("claimLinearBootstrapJob", () => {
  it("writes both the ref and the job atomically and wins once", async () => {
    const won = await claimLinearBootstrapJob(db as never, baseInput());
    expect(won).toBe(true);

    const ref = db.sqlite
      .prepare("SELECT session_id, updated_at FROM linear_issue_session_refs WHERE linear_issue_id = ?")
      .get("issue-1") as { session_id: string; updated_at: string };
    expect(ref.session_id).toBe("sess-1");
    // The ref keeps its ISO timestamp; job columns are integer ms.
    expect(Number.isNaN(Date.parse(ref.updated_at))).toBe(false);
    expect(typeof ref.updated_at).toBe("string");

    const job = await getLinearBootstrapJob(db as never, "issue-1");
    expect(job?.phase).toBe("linear_issue_claimed");
    expect(job?.installationId).toBe(123);
    expect(job?.uploadedImages).toEqual([]);
    expect(job?.createdAt).toBe(1_000);
  });

  it("persists uploaded images on the bootstrap job", async () => {
    await claimLinearBootstrapJob(
      db as never,
      baseInput({
        uploadedImages: [{ name: "linear-shot.png", mediaType: "image/png", data: "aW1n" }],
      }),
    );

    const job = await getLinearBootstrapJob(db as never, "issue-1");
    expect(job?.uploadedImages).toEqual([{ name: "linear-shot.png", mediaType: "image/png", data: "aW1n" }]);
  });

  it("loses on conflict and does not overwrite the existing job", async () => {
    await claimLinearBootstrapJob(db as never, baseInput());
    const second = await claimLinearBootstrapJob(db as never, baseInput({ sessionId: "sess-2", installationId: 999 }));
    expect(second).toBe(false);
    const job = await getLinearBootstrapJob(db as never, "issue-1");
    expect(job?.sessionId).toBe("sess-1");
    expect(job?.installationId).toBe(123);
  });
});

describe("listDueLinearBootstrapJobs", () => {
  it("honors terminal_outcome IS NULL, retry_after_ms, and lease", async () => {
    await claimLinearBootstrapJob(db as never, baseInput({ retryAfterMs: 1_000 }));

    // Not due yet (retry_after_ms in the future).
    expect(await listDueLinearBootstrapJobs(db as never, 500, 10)).toHaveLength(0);
    // Due now.
    expect(await listDueLinearBootstrapJobs(db as never, 2_000, 10)).toHaveLength(1);

    // An active lease hides it.
    await claimLinearBootstrapJobLease(db as never, "issue-1", 2_000, 9_000);
    expect(await listDueLinearBootstrapJobs(db as never, 2_000, 10)).toHaveLength(0);
    // Once the lease expires it is due again.
    expect(await listDueLinearBootstrapJobs(db as never, 9_500, 10)).toHaveLength(1);

    // Terminal jobs are never due.
    await markLinearBootstrapJobTerminal(db as never, "issue-1", "completed", 9_500);
    expect(await listDueLinearBootstrapJobs(db as never, 100_000, 10)).toHaveLength(0);
  });
});

describe("updateLinearBootstrapJobPhase (phase-conditional)", () => {
  it("advances only from the expected predecessor phase", async () => {
    await claimLinearBootstrapJob(db as never, baseInput());

    // Wrong predecessor: no-op.
    const wrong = await updateLinearBootstrapJobPhase(
      db as never,
      "issue-1",
      "session_projected",
      "prompt_enqueued",
      2_000,
    );
    expect(wrong).toBe(false);
    expect((await getLinearBootstrapJob(db as never, "issue-1"))?.phase).toBe("linear_issue_claimed");

    // Correct predecessor: advances and persists installation + attachment id.
    const ok = await updateLinearBootstrapJobPhase(
      db as never,
      "issue-1",
      "linear_issue_claimed",
      "gate_revalidated",
      2_000,
      { installationId: 555 },
    );
    expect(ok).toBe(true);
    const job = await getLinearBootstrapJob(db as never, "issue-1");
    expect(job?.phase).toBe("gate_revalidated");
    expect(job?.installationId).toBe(555);
  });

  it("persists a captured attachment external id", async () => {
    await claimLinearBootstrapJob(db as never, baseInput());
    await updateLinearBootstrapJobPhase(db as never, "issue-1", "linear_issue_claimed", "gate_revalidated", 2_000);
    await updateLinearBootstrapJobPhase(db as never, "issue-1", "gate_revalidated", "session_projected", 2_000);
    await updateLinearBootstrapJobPhase(db as never, "issue-1", "session_projected", "prompt_enqueued", 2_000);
    await updateLinearBootstrapJobPhase(db as never, "issue-1", "prompt_enqueued", "linked", 2_000, {
      attachmentExternalId: "att_99",
    });
    expect((await getLinearBootstrapJob(db as never, "issue-1"))?.linearAttachmentExternalId).toBe("att_99");
  });
});

describe("rescheduleLinearBootstrapJob", () => {
  it("bumps attempt_count, clears the lease, and stays non-terminal", async () => {
    await claimLinearBootstrapJob(db as never, baseInput());
    await claimLinearBootstrapJobLease(db as never, "issue-1", 1_500, 9_000);
    await rescheduleLinearBootstrapJob(db as never, "issue-1", 5_000, 2_000, "transient");
    const job = await getLinearBootstrapJob(db as never, "issue-1");
    expect(job?.attemptCount).toBe(1);
    expect(job?.leaseExpiresAt).toBeNull();
    expect(job?.terminalOutcome).toBeNull();
    expect(job?.retryAfterMs).toBe(5_000);
    expect(job?.failureReason).toBe("transient");
  });
});

describe("deleteLinearBootstrapJob (both-keys scoped)", () => {
  it("deletes only when both linear_issue_id and session_id match", async () => {
    await claimLinearBootstrapJob(db as never, baseInput());

    // Wrong session id: a concurrent re-claim's newer job is never wiped.
    expect(await deleteLinearBootstrapJob(db as never, "issue-1", "other-session")).toBe(false);
    expect(await getLinearBootstrapJob(db as never, "issue-1")).not.toBeNull();

    // Correct session id deletes it.
    expect(await deleteLinearBootstrapJob(db as never, "issue-1", "sess-1")).toBe(true);
    expect(await getLinearBootstrapJob(db as never, "issue-1")).toBeNull();
  });
});
