// Phase-runner tests for the durable Linear bootstrap (ARC-1051): sweep
// re-authorization, idempotent create, dedup enqueue, link-back recovery,
// durable/transient classification, single lifecycle emit, and sweep
// resilience. The job-table DAO runs for real against a FakeD1; external
// effects are mocked at their module boundaries.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));
vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_c: unknown, D: unknown) => D,
  withSentry: (_c: unknown, h: unknown) => h,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

const mockAuthorize = vi.fn<(...a: unknown[]) => Promise<unknown>>();
const mockCreateAndPersist = vi.fn<(...a: unknown[]) => Promise<unknown>>();
const mockEmitLifecycle = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
vi.mock("../../apps/control-plane-worker/src/webhooks/shared", async (importActual) => ({
  ...(await importActual<object>()),
  authorizeLinearWebhookRepo: (...a: unknown[]) => mockAuthorize(...a),
  createAndPersistLinearWebhookSession: (...a: unknown[]) => mockCreateAndPersist(...a),
  emitLifecycleEvent: (...a: unknown[]) => mockEmitLifecycle(...a),
}));

const mockEnqueue = vi.fn<(...a: unknown[]) => Promise<unknown>>();
const mockListPrompts = vi.fn<(...a: unknown[]) => Promise<unknown>>();
const mockCloseSession = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ closed: true, session: null }));
vi.mock("../../apps/control-plane-worker/src/session/state", async (importActual) => ({
  ...(await importActual<object>()),
  enqueueSessionPrompt: (...a: unknown[]) => mockEnqueue(...a),
  listSessionPrompts: (...a: unknown[]) => mockListPrompts(...a),
  closeSessionForWebhook: (...a: unknown[]) => mockCloseSession(...a),
}));

const mockLiveness = vi.fn<(...a: unknown[]) => Promise<unknown[]>>(async () => []);
vi.mock("../../apps/control-plane-worker/src/session/db", async (importActual) => ({
  ...(await importActual<object>()),
  getSessionLivenessRows: (...a: unknown[]) => mockLiveness(...a),
}));

const mockLink = vi.fn<(...a: unknown[]) => Promise<unknown>>();
const mockFindAttachment = vi.fn<(...a: unknown[]) => Promise<string | null>>(async () => null);
const mockFetchPickupContext = vi.fn<(...a: unknown[]) => Promise<unknown>>();
const mockUpdatePickup = vi.fn<(...a: unknown[]) => Promise<unknown>>();
const mockPostPickupComment = vi.fn<(...a: unknown[]) => Promise<unknown>>();
vi.mock("../../apps/control-plane-worker/src/webhooks/linear", async (importActual) => ({
  ...(await importActual<object>()),
  linkSessionToLinearIssue: (...a: unknown[]) => mockLink(...a),
  findLinearAttachmentExternalIdByUrl: (...a: unknown[]) => mockFindAttachment(...a),
  fetchLinearIssuePickupContext: (...a: unknown[]) => mockFetchPickupContext(...a),
  updateLinearIssueForPickup: (...a: unknown[]) => mockUpdatePickup(...a),
  postLinearIssueComment: (...a: unknown[]) => mockPostPickupComment(...a),
}));

const mockGetToken = vi.fn<(...a: unknown[]) => Promise<string | null>>(async () => "linear-token");
vi.mock("../../apps/control-plane-worker/src/auth/db", async (importActual) => ({
  ...(await importActual<object>()),
  getValidLinearToken: (...a: unknown[]) => mockGetToken(...a),
}));

vi.mock("../../apps/control-plane-worker/src/services/public-url", () => ({
  resolvePublicAppBaseUrl: () => "https://app.test",
}));

import { OpencodeAccessDeniedError } from "../../apps/control-plane-worker/src/services/opencode-access-gate";
import type { Env } from "../../apps/control-plane-worker/src/types";
import {
  claimLinearBootstrapJob,
  getLinearBootstrapJob,
  type LinearBootstrapJob,
  updateLinearBootstrapJobPhase,
} from "../../apps/control-plane-worker/src/webhooks/db";
import {
  linearBootstrapSweepTick,
  runLinearBootstrapJobPhases,
} from "../../apps/control-plane-worker/src/webhooks/linear-bootstrap";

// Minimal D1 adapter.
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

let db: FakeD1;
let env: Env;

async function seedJobAtPhase(phase: LinearBootstrapJob["phase"]): Promise<LinearBootstrapJob> {
  await claimLinearBootstrapJob(db as never, {
    linearIssueId: "issue-1",
    sessionId: "sess-1",
    businessId: "biz-1",
    actorUserId: "42",
    repoOwner: "acme",
    repoName: "repo",
    installationId: 123,
    model: null,
    promptTemplate: "PROMPT",
    issueSnapshot: JSON.stringify({ issue: { id: "issue-1", title: "T" } }),
    uploadedImages: [],
    retryAfterMs: 0,
    nowMs: 0,
  });
  const order: LinearBootstrapJob["phase"][] = [
    "linear_issue_claimed",
    "gate_revalidated",
    "session_projected",
    "prompt_enqueued",
    "linked",
    "picked_up",
  ];
  for (let i = 1; i < order.length && order[i - 1] !== phase; i++) {
    await updateLinearBootstrapJobPhase(db as never, "issue-1", order[i - 1], order[i], 0);
  }
  const job = await getLinearBootstrapJob(db as never, "issue-1");
  if (!job) throw new Error("seed failed");
  return job;
}

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeD1();
  env = { DB: db } as unknown as Env;
  mockAuthorize.mockResolvedValue({ status: "authorized", authorization: { installationId: 123 } });
  mockCreateAndPersist.mockResolvedValue({ sessionId: "sess-1", session: { sessionId: "sess-1" } });
  mockLiveness.mockResolvedValue([]);
  mockListPrompts.mockResolvedValue({ ok: true, payload: { prompts: [] } });
  mockEnqueue.mockResolvedValue({ ok: true, status: 200 });
  mockGetToken.mockResolvedValue("linear-token");
  mockFindAttachment.mockResolvedValue(null);
  mockLink.mockResolvedValue({ success: true, externalId: "att_new" });
  mockFetchPickupContext.mockResolvedValue({
    viewerId: "42",
    issue: {
      assigneeId: "42",
      state: { id: "state-triage", type: "triage" },
      startedStates: [{ id: "state-started", type: "started", position: 1 }],
      commentBodies: [],
    },
  });
  mockUpdatePickup.mockResolvedValue({ success: true, externalId: null });
  mockPostPickupComment.mockResolvedValue({ success: true, externalId: null });
});

describe("gate revalidation on the sweep path (B4)", () => {
  it("terminal-fails on a durable authorization denial", async () => {
    const job = await seedJobAtPhase("linear_issue_claimed");
    mockAuthorize.mockResolvedValue({ status: "skipped", reason: "repo_not_authorized", response: new Response() });

    const outcome = await runLinearBootstrapJobPhases(env, job, 1_000);
    expect(outcome).toEqual({ status: "failed", reason: "gate_repo_not_authorized" });
    expect((await getLinearBootstrapJob(db as never, "issue-1"))?.terminalOutcome).toBe("failed");
    expect(mockCreateAndPersist).not.toHaveBeenCalled();
  });

  it("reschedules a transient authorization failure (not terminal)", async () => {
    const job = await seedJobAtPhase("linear_issue_claimed");
    mockAuthorize.mockResolvedValue({
      status: "skipped",
      reason: "repo_access_verification_failed",
      response: new Response(),
    });

    const outcome = await runLinearBootstrapJobPhases(env, job, 1_000);
    expect(outcome.status).toBe("rescheduled");
    const after = await getLinearBootstrapJob(db as never, "issue-1");
    expect(after?.terminalOutcome).toBeNull();
    expect(after?.attemptCount).toBe(1);
    // Backoff: first transient retry is base-delayed, not immediately eligible.
    expect(after?.retryAfterMs).toBe(1_000 + 5 * 60 * 1000);
  });

  it("skips re-authorization in-request when alreadyAuthorized is set", async () => {
    const job = await seedJobAtPhase("linear_issue_claimed");
    await runLinearBootstrapJobPhases(env, job, 1_000, { alreadyAuthorized: true, stopBeforeLink: true });
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockCreateAndPersist).toHaveBeenCalledTimes(1);
  });
});

describe("idempotent session create (B5)", () => {
  it("skips create when the session already exists", async () => {
    const job = await seedJobAtPhase("gate_revalidated");
    mockLiveness.mockResolvedValue([{ session_id: "sess-1", status: "active" }]);

    await runLinearBootstrapJobPhases(env, job, 1_000, { stopBeforeLink: true });
    expect(mockCreateAndPersist).not.toHaveBeenCalled();
    expect((await getLinearBootstrapJob(db as never, "issue-1"))?.phase).toBe("prompt_enqueued");
  });

  it("reschedules (not terminal) when create throws transiently", async () => {
    const job = await seedJobAtPhase("gate_revalidated");
    mockCreateAndPersist.mockRejectedValue(new Error("D1 reset"));

    const outcome = await runLinearBootstrapJobPhases(env, job, 1_000, { stopBeforeLink: true });
    expect(outcome.status).toBe("rescheduled");
    expect((await getLinearBootstrapJob(db as never, "issue-1"))?.terminalOutcome).toBeNull();
  });

  it("terminal-fails without retry when create is permanently denied for opencode", async () => {
    const job = await seedJobAtPhase("gate_revalidated");
    mockCreateAndPersist.mockRejectedValue(new OpencodeAccessDeniedError({ businessId: "biz-1", sessionId: "sess-1" }));

    const outcome = await runLinearBootstrapJobPhases(env, job, 1_000, { stopBeforeLink: true });

    expect(outcome).toEqual({ status: "failed", reason: "opencode_access_denied" });
    const after = await getLinearBootstrapJob(db as never, "issue-1");
    expect(after?.terminalOutcome).toBe("failed");
    expect(after?.failureReason).toBe("opencode_access_denied");
    expect(after?.attemptCount).toBe(0);
  });
});

describe("prompt enqueue dedup (S1)", () => {
  it("enqueues exactly once on a create-only resume", async () => {
    const job = await seedJobAtPhase("session_projected");
    await runLinearBootstrapJobPhases(env, job, 1_000, { stopBeforeLink: true });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect((await getLinearBootstrapJob(db as never, "issue-1"))?.phase).toBe("prompt_enqueued");
  });

  it("passes persisted uploaded images into prompt enqueue on resume", async () => {
    await claimLinearBootstrapJob(db as never, {
      linearIssueId: "issue-images",
      sessionId: "sess-images",
      businessId: "biz-1",
      actorUserId: "42",
      repoOwner: "acme",
      repoName: "repo",
      installationId: 123,
      model: null,
      promptTemplate: "PROMPT",
      issueSnapshot: JSON.stringify({ issue: { id: "issue-images", title: "T" } }),
      uploadedImages: [{ name: "linear-shot.png", mediaType: "image/png", data: "aW1n" }],
      retryAfterMs: 0,
      nowMs: 0,
    });
    await updateLinearBootstrapJobPhase(db as never, "issue-images", "linear_issue_claimed", "gate_revalidated", 0);
    await updateLinearBootstrapJobPhase(db as never, "issue-images", "gate_revalidated", "session_projected", 0);
    const job = await getLinearBootstrapJob(db as never, "issue-images");
    if (!job) throw new Error("seed failed");

    await runLinearBootstrapJobPhases(env, job, 1_000, { stopBeforeLink: true });

    expect(mockEnqueue).toHaveBeenCalledWith(env, "sess-images", "PROMPT", "42", {
      auth: { userId: "42", canAccessAllSessions: false, businessId: "biz-1" },
      uploadedImages: [{ name: "linear-shot.png", mediaType: "image/png", data: "aW1n" }],
    });
  });

  it("does not re-enqueue when the prompt is already present", async () => {
    const job = await seedJobAtPhase("session_projected");
    mockListPrompts.mockResolvedValue({ ok: true, payload: { prompts: [{ prompt: "PROMPT", actorUserId: "42" }] } });

    await runLinearBootstrapJobPhases(env, job, 1_000, { stopBeforeLink: true });
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect((await getLinearBootstrapJob(db as never, "issue-1"))?.phase).toBe("prompt_enqueued");
  });
});

describe("link-back idempotency (B7) and classification (S5)", () => {
  it("recovers an existing attachment by URL instead of posting a duplicate", async () => {
    const job = await seedJobAtPhase("prompt_enqueued");
    mockFindAttachment.mockResolvedValue("att_existing");

    const outcome = await runLinearBootstrapJobPhases(env, job, 1_000);
    expect(outcome).toEqual({ status: "completed" });
    expect(mockLink).not.toHaveBeenCalled();
    const after = await getLinearBootstrapJob(db as never, "issue-1");
    expect(after?.terminalOutcome).toBe("completed");
    expect(after?.linearAttachmentExternalId).toBe("att_existing");
  });

  it("posts and stores the external id on a fresh link", async () => {
    const job = await seedJobAtPhase("prompt_enqueued");
    const outcome = await runLinearBootstrapJobPhases(env, job, 1_000);
    expect(outcome).toEqual({ status: "completed" });
    expect(mockLink).toHaveBeenCalledTimes(1);
    expect((await getLinearBootstrapJob(db as never, "issue-1"))?.linearAttachmentExternalId).toBe("att_new");
  });

  it("terminal-fails durably when the Linear token is unavailable (session left live)", async () => {
    const job = await seedJobAtPhase("prompt_enqueued");
    mockGetToken.mockResolvedValue(null);

    const outcome = await runLinearBootstrapJobPhases(env, job, 1_000);
    expect(outcome).toEqual({ status: "failed", reason: "link_linear_token_unavailable" });
    expect(mockCloseSession).not.toHaveBeenCalled();
  });

  it("reschedules when the attachment lookup throws (transient)", async () => {
    const job = await seedJobAtPhase("prompt_enqueued");
    mockFindAttachment.mockRejectedValue(new Error("network"));

    const outcome = await runLinearBootstrapJobPhases(env, job, 1_000);
    expect(outcome.status).toBe("rescheduled");
    expect((await getLinearBootstrapJob(db as never, "issue-1"))?.terminalOutcome).toBeNull();
  });

  it("reschedules when the issue update fails before the pickup comment", async () => {
    const job = await seedJobAtPhase("linked");
    mockUpdatePickup.mockResolvedValue({ success: false, externalId: null });

    const outcome = await runLinearBootstrapJobPhases(env, job, 1_000);

    expect(outcome.status).toBe("rescheduled");
    expect(mockPostPickupComment).not.toHaveBeenCalled();
    expect((await getLinearBootstrapJob(db as never, "issue-1"))?.terminalOutcome).toBeNull();
  });
});

describe("lifecycle emit (S11)", () => {
  it("emits WEBHOOK_FOLLOWUP_ENQUEUED exactly once across a resume", async () => {
    // Emit is gated on the session_projected -> prompt_enqueued advance, so seed
    // before that advance to observe it fire.
    const job = await seedJobAtPhase("session_projected");
    await runLinearBootstrapJobPhases(env, job, 1_000);
    expect(mockEmitLifecycle).toHaveBeenCalledTimes(1);

    // A resume of an already-completed job re-runs the runner; it must not
    // re-emit. (Simulate by re-fetching and re-running.)
    const completed = await getLinearBootstrapJob(db as never, "issue-1");
    if (completed) await runLinearBootstrapJobPhases(env, completed, 2_000);
    expect(mockEmitLifecycle).toHaveBeenCalledTimes(1);
  });

  it("still emits WEBHOOK_FOLLOWUP_ENQUEUED when the link-back fails durably", async () => {
    // Regression (Greptile P1): the followup event tracks the live session +
    // enqueued prompt, so a durable link-back failure (actor disconnected Linear)
    // must not suppress it.
    const job = await seedJobAtPhase("session_projected");
    mockGetToken.mockResolvedValue(null);

    const outcome = await runLinearBootstrapJobPhases(env, job, 1_000);
    expect(outcome).toEqual({ status: "failed", reason: "link_linear_token_unavailable" });
    expect(mockEmitLifecycle).toHaveBeenCalledTimes(1);
  });

  it("does not re-emit when resuming a job already at the linked phase", async () => {
    const job = await seedJobAtPhase("linked");
    await runLinearBootstrapJobPhases(env, job, 1_000);
    // The linked->completed step does not re-emit (emit is gated on the
    // prompt_enqueued->linked transition).
    expect(mockEmitLifecycle).not.toHaveBeenCalled();
    expect((await getLinearBootstrapJob(db as never, "issue-1"))?.terminalOutcome).toBe("completed");
  });
});

describe("linearBootstrapSweepTick (S7)", () => {
  it("reports per-outcome counts and one failing job does not abort the sweep", async () => {
    // Job A: healthy, at prompt_enqueued -> will complete.
    await seedJobAtPhase("prompt_enqueued");
    // Job B: a second issue at linear_issue_claimed whose authorize throws.
    await claimLinearBootstrapJob(db as never, {
      linearIssueId: "issue-2",
      sessionId: "sess-2",
      businessId: "biz-1",
      actorUserId: "42",
      repoOwner: "acme",
      repoName: "repo",
      installationId: 123,
      model: null,
      promptTemplate: "PROMPT2",
      issueSnapshot: JSON.stringify({ issue: { id: "issue-2" } }),
      uploadedImages: [],
      retryAfterMs: 0,
      nowMs: 0,
    });
    mockAuthorize.mockImplementation(async (params) => {
      if ((params as { repoOwner: string }).repoOwner === "acme") throw new Error("authorize blew up");
      return { status: "authorized", authorization: { installationId: 123 } };
    });

    const report = await linearBootstrapSweepTick(env, { now: () => 10_000, limit: 50 });
    expect(report.scanned).toBe(2);
    expect(report.completed).toBe(1);
    expect(report.errors).toBe(1);
    // The healthy job still completed despite the sibling throwing.
    expect((await getLinearBootstrapJob(db as never, "issue-1"))?.terminalOutcome).toBe("completed");
  });
});
