/**
 * Tests for the scheduled handler's auth session cleanup error handling.
 * Verifies that transient D1 storage errors are swallowed (no Sentry capture)
 * while non-transient errors are captured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

const {
  captureException,
  claimReenqueueableIngestionEventsMock,
  automationSchedulerTickMock,
  getReenqueueableMemoryJobsMock,
  recoverStaleIngestionEventsMock,
  failStaleAutomationEventJobsMock,
  runReviewLoopEpochDispatchSweepMock,
  runDueGithubHealthChecksMock,
  runFreestyleVmAuditMock,
  runReviewLoopSweepMock,
  runDueJiraPersonalDataReportsMock,
  tracedEnvMock,
  warmPublicFetchPathMock,
} = vi.hoisted(() => ({
  claimReenqueueableIngestionEventsMock: vi.fn(),
  automationSchedulerTickMock: vi.fn().mockResolvedValue(undefined),
  captureException: vi.fn(),
  getReenqueueableMemoryJobsMock: vi.fn(),
  failStaleAutomationEventJobsMock: vi.fn().mockResolvedValue([]),
  recoverStaleIngestionEventsMock: vi.fn(),
  runReviewLoopEpochDispatchSweepMock: vi.fn().mockResolvedValue(undefined),
  runDueGithubHealthChecksMock: vi.fn().mockResolvedValue({ checked: 0, skipped: 0, failed: 0 }),
  runFreestyleVmAuditMock: vi.fn().mockResolvedValue({
    skipped: null,
    listedTotal: 0,
    activeCount: 0,
    registeredCount: 0,
    unregisteredCount: 0,
    possibleOrphanCount: 0,
  }),
  runReviewLoopSweepMock: vi.fn().mockResolvedValue(undefined),
  runDueJiraPersonalDataReportsMock: vi
    .fn()
    .mockResolvedValue({ reported: 0, closed: 0, updated: 0, skipped: 0, failed: 0 }),
  tracedEnvMock: vi.fn((env: unknown) => env),
  warmPublicFetchPathMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_opts: unknown, cls: unknown) => cls,
  withSentry: (_opts: unknown, handler: unknown) => handler,
  setTag: vi.fn(),
  setUser: vi.fn(),
  captureException,
}));

vi.mock("../../apps/control-plane-worker/src/routes/table", () => ({
  controlPlaneRoutes: [],
}));

vi.mock("../../apps/control-plane-worker/src/auth/routes", () => ({
  authenticateRequest: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/observability/sentry", () => ({
  resolveSentryRuntimeOptions: () => ({}),
}));

vi.mock("../../apps/control-plane-worker/src/observability/context", () => ({
  extractTraceparent: vi.fn().mockReturnValue(null),
  startSpan: vi.fn().mockReturnValue({}),
  endSpan: vi.fn(),
  runInSpan: vi.fn(),
  currentContext: vi.fn().mockReturnValue(null),
}));

vi.mock("../../apps/control-plane-worker/src/observability/exporter", () => ({
  flushSpansToQueue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedEnv: tracedEnvMock,
  tracedFetch: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/services/warm", () => ({
  warmPublicFetchPath: warmPublicFetchPathMock,
}));

vi.mock("../../apps/control-plane-worker/src/automation/scheduler.js", () => ({
  automationSchedulerTick: automationSchedulerTickMock,
}));

vi.mock("../../apps/control-plane-worker/src/automation/db.js", () => ({
  failStaleAutomationEventJobs: failStaleAutomationEventJobsMock,
}));

vi.mock("../../apps/control-plane-worker/src/integrations/github-health.js", () => ({
  runDueGithubHealthChecks: runDueGithubHealthChecksMock,
}));

vi.mock("../../apps/control-plane-worker/src/integrations/jira-personal-data-reporting.js", () => ({
  runDueJiraPersonalDataReports: runDueJiraPersonalDataReportsMock,
}));

vi.mock("../../apps/control-plane-worker/src/session/cleanup.js", () => ({
  cleanupExpiredE2BRuntimes: vi
    .fn()
    .mockResolvedValue({ scanned: 0, paused: 0, killed: 0, cleared: 0, terminalDisabled: 0, errors: 0 }),
}));

vi.mock("../../apps/control-plane-worker/src/sandbox/freestyle-vm-audit.js", () => ({
  runFreestyleVmAudit: runFreestyleVmAuditMock,
}));

vi.mock("../../apps/control-plane-worker/src/services/review-loop-sweep.js", () => ({
  runReviewLoopEpochDispatchSweep: runReviewLoopEpochDispatchSweepMock,
  runReviewLoopSweep: runReviewLoopSweepMock,
}));

const deleteExpiredAuthSessionsMock = vi.fn();
vi.mock("../../apps/control-plane-worker/src/auth/db", () => ({
  deleteExpiredAuthSessions: deleteExpiredAuthSessionsMock,
}));

vi.mock("../../apps/control-plane-worker/src/webhooks/db", () => ({
  deleteExpiredSlackRepoDisambiguations: vi.fn().mockResolvedValue(0),
  deleteExpiredWebhookIdempotencyClaims: vi.fn().mockResolvedValue(0),
}));

vi.mock("../../apps/control-plane-worker/src/company-memory/db.js", () => ({
  claimReenqueueableIngestionEvents: claimReenqueueableIngestionEventsMock,
  recoverStaleIngestionEvents: recoverStaleIngestionEventsMock,
}));

vi.mock("../../apps/control-plane-worker/src/memory/db.js", () => ({
  getReenqueueableMemoryJobs: getReenqueueableMemoryJobsMock,
  terminalizeExhaustedJobs: vi.fn().mockResolvedValue(0),
}));

import { GC_CRON } from "../../apps/control-plane-worker/src/constants/scheduler";
import {
  resetSentryRepeatSuppression,
  SENTRY_SUPPRESSION_WINDOW_MS,
} from "../../apps/control-plane-worker/src/observability/sentry-repeat-suppression";

// Fake ctx that immediately resolves waitUntil promises
function makeFakeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    async flush() {
      await Promise.allSettled(pending);
    },
  };
}

function makeFakeEnv() {
  return {
    DB: {} as D1Database,
    LOG_LEVEL: "silent",
  } as unknown as import("../../apps/control-plane-worker/src/types").Env;
}

describe("scheduled handler -- auth session cleanup transient error handling", () => {
  let scheduledHandler: ((ctrl: unknown, env: unknown, ctx: unknown) => Promise<void>) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    claimReenqueueableIngestionEventsMock.mockResolvedValue([]);
    getReenqueueableMemoryJobsMock.mockResolvedValue([]);
    recoverStaleIngestionEventsMock.mockResolvedValue(0);
    failStaleAutomationEventJobsMock.mockResolvedValue([]);
    tracedEnvMock.mockImplementation((env: unknown) => env);
    runReviewLoopSweepMock.mockResolvedValue(undefined);
    resetSentryRepeatSuppression();
    // router.ts uses `export default`, so scheduled lives on .default
    const mod = (await import("../../apps/control-plane-worker/src/router")) as {
      default?: { scheduled?: (ctrl: unknown, env: unknown, ctx: unknown) => Promise<void> };
    };
    scheduledHandler = mod.default?.scheduled;
  });

  it("does not route transient D1 storage timeout errors to Sentry", async () => {
    const transientMsg = "D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.";
    deleteExpiredAuthSessionsMock.mockRejectedValueOnce(new Error(transientMsg));

    const ctx = makeFakeCtx();
    await scheduledHandler?.({ cron: GC_CRON } as ScheduledController, makeFakeEnv(), ctx);
    await ctx.flush();

    // captureException must not have been called with the transient error
    // (other scheduled tasks may fire their own Sentry captures unrelated to auth cleanup)
    const calls = captureException.mock.calls;
    const transientCapture = calls.find((args) => {
      const err = args[0];
      return err instanceof Error && err.message.includes("storage operation exceeded timeout");
    });
    expect(transientCapture).toBeUndefined();
  });

  it("routes non-transient D1 errors to Sentry", async () => {
    const nonTransientMsg = "D1_ERROR: no such table: auth_sessions";
    deleteExpiredAuthSessionsMock.mockRejectedValueOnce(new Error(nonTransientMsg));

    const ctx = makeFakeCtx();
    await scheduledHandler?.({ cron: GC_CRON } as ScheduledController, makeFakeEnv(), ctx);
    await ctx.flush();

    // captureException must have been called with the non-transient error
    const calls = captureException.mock.calls;
    const nonTransientCapture = calls.find((args) => {
      const err = args[0];
      return err instanceof Error && err.message.includes("no such table");
    });
    expect(nonTransientCapture).toBeDefined();
  });

  it("does not route auth cleanup success to Sentry", async () => {
    deleteExpiredAuthSessionsMock.mockResolvedValueOnce(5);

    const ctx = makeFakeCtx();
    await scheduledHandler?.({ cron: GC_CRON } as ScheduledController, makeFakeEnv(), ctx);
    await ctx.flush();

    const calls = captureException.mock.calls;
    const authCleanupCapture = calls.find((args) => {
      const err = args[0];
      return err instanceof Error && (err.message.includes("auth_sessions") || err.message.includes("session cleanup"));
    });
    expect(authCleanupCapture).toBeUndefined();
  });

  it("re-enqueues recovered stale company memory ingestion events", async () => {
    recoverStaleIngestionEventsMock.mockResolvedValueOnce(2);
    claimReenqueueableIngestionEventsMock.mockResolvedValueOnce(
      Array.from({ length: 101 }, (_, index) => ({ id: `event-${index}`, businessId: `biz-${index}` })),
    );
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const ctx = makeFakeCtx();
    await scheduledHandler?.({} as ScheduledController, { ...makeFakeEnv(), MEMORY_REFINE_QUEUE: { sendBatch } }, ctx);
    await ctx.flush();

    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(sendBatch.mock.calls[0]?.[0]).toHaveLength(100);
    expect(sendBatch.mock.calls[1]?.[0]).toHaveLength(1);
    expect(sendBatch.mock.calls[0]?.[0][0]).toEqual({
      body: { businessId: "biz-0", ingestionEventId: "event-0", trigger: "auto" },
    });
    expect(sendBatch.mock.calls[1]?.[0][0]).toEqual({
      body: { businessId: "biz-100", ingestionEventId: "event-100", trigger: "auto" },
    });
  });

  it("re-enqueues stale memory analysis jobs with queue sendBatch chunks", async () => {
    getReenqueueableMemoryJobsMock.mockResolvedValueOnce(
      Array.from({ length: 101 }, (_, index) => ({ id: `job-${index}` })),
    );
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const ctx = makeFakeCtx();
    await scheduledHandler?.(
      {} as ScheduledController,
      { ...makeFakeEnv(), MEMORY_ANALYSIS_QUEUE: { sendBatch } },
      ctx,
    );
    await ctx.flush();

    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(sendBatch.mock.calls[0]?.[0]).toHaveLength(100);
    expect(sendBatch.mock.calls[1]?.[0]).toHaveLength(1);
    expect(sendBatch.mock.calls[0]?.[0][0]).toEqual({ body: { jobId: "job-0" } });
    expect(sendBatch.mock.calls[1]?.[0][0]).toEqual({ body: { jobId: "job-100" } });
  });

  it("runs Jira personal-data reporting during scheduled ticks", async () => {
    const ctx = makeFakeCtx();
    await scheduledHandler?.({ cron: "*/5 * * * *" } as ScheduledController, makeFakeEnv(), ctx);
    await ctx.flush();

    expect(runDueJiraPersonalDataReportsMock).toHaveBeenCalledWith(
      expect.objectContaining({ DB: expect.anything() }),
      expect.objectContaining({ logger: expect.anything() }),
    );
  });

  it("runs the review-loop sweep on the traced environment, not the raw scheduler env", async () => {
    const rawEnv = makeFakeEnv();
    const traced = { ...rawEnv, DB: { traced: true } as unknown as D1Database };
    tracedEnvMock.mockReturnValueOnce(traced);

    const ctx = makeFakeCtx();
    await scheduledHandler?.({ cron: "*/5 * * * *" } as ScheduledController, rawEnv, ctx);
    await ctx.flush();

    expect(tracedEnvMock).toHaveBeenCalledWith(rawEnv);
    expect(runReviewLoopSweepMock).toHaveBeenCalledWith(
      expect.objectContaining({ DB: traced.DB }),
      expect.objectContaining({ logger: expect.anything() }),
    );
    expect(runReviewLoopSweepMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ DB: rawEnv.DB }),
      expect.objectContaining({ logger: expect.anything() }),
    );
  });
});

describe("scheduled handler -- 5-minute sweep", () => {
  let scheduledHandler: ((ctrl: unknown, env: unknown, ctx: unknown) => Promise<void>) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    claimReenqueueableIngestionEventsMock.mockResolvedValue([]);
    recoverStaleIngestionEventsMock.mockResolvedValue(0);
    deleteExpiredAuthSessionsMock.mockResolvedValue(0);
    resetSentryRepeatSuppression();
    const mod = (await import("../../apps/control-plane-worker/src/router")) as {
      default?: { scheduled?: (ctrl: unknown, env: unknown, ctx: unknown) => Promise<void> };
    };
    scheduledHandler = mod.default?.scheduled;
  });

  it("the 5-minute tick runs fast sweep tasks without auth cleanup", async () => {
    const ctx = makeFakeCtx();
    await scheduledHandler?.({ cron: "*/5 * * * *" } as ScheduledController, makeFakeEnv(), ctx);
    await ctx.flush();

    expect(warmPublicFetchPathMock).toHaveBeenCalledTimes(1);
    expect(automationSchedulerTickMock).toHaveBeenCalledTimes(1);
    expect(failStaleAutomationEventJobsMock).toHaveBeenCalledWith(expect.anything(), expect.any(Number));
    expect(runDueGithubHealthChecksMock).toHaveBeenCalledTimes(1);
    expect(runReviewLoopSweepMock).toHaveBeenCalledTimes(1);
    expect(runReviewLoopEpochDispatchSweepMock).not.toHaveBeenCalled();
    expect(deleteExpiredAuthSessionsMock).not.toHaveBeenCalled();
    expect(runFreestyleVmAuditMock).not.toHaveBeenCalled();
  });

  it("the hourly GC tick runs auth cleanup without fast sweep tasks", async () => {
    const ctx = makeFakeCtx();
    await scheduledHandler?.({ cron: GC_CRON } as ScheduledController, makeFakeEnv(), ctx);
    await ctx.flush();

    expect(deleteExpiredAuthSessionsMock).toHaveBeenCalledTimes(1);
    expect(runFreestyleVmAuditMock).toHaveBeenCalledTimes(1);
    expect(warmPublicFetchPathMock).not.toHaveBeenCalled();
    expect(automationSchedulerTickMock).not.toHaveBeenCalled();
    expect(runDueGithubHealthChecksMock).not.toHaveBeenCalled();
    expect(runReviewLoopSweepMock).not.toHaveBeenCalled();
    expect(runReviewLoopEpochDispatchSweepMock).not.toHaveBeenCalled();
  });

  it("the 1-minute tick runs only review-loop dispatch", async () => {
    const ctx = makeFakeCtx();
    await scheduledHandler?.(
      { cron: "* * * * *", scheduledTime: Date.UTC(2026, 0, 1, 0, 1, 0) } as ScheduledController,
      makeFakeEnv(),
      ctx,
    );
    await ctx.flush();

    expect(runReviewLoopEpochDispatchSweepMock).toHaveBeenCalledTimes(1);
    expect(runReviewLoopSweepMock).not.toHaveBeenCalled();
    expect(deleteExpiredAuthSessionsMock).not.toHaveBeenCalled();
    expect(claimReenqueueableIngestionEventsMock).not.toHaveBeenCalled();
  });

  it("skips the 1-minute dispatch tick on full-sweep minutes", async () => {
    const ctx = makeFakeCtx();
    await scheduledHandler?.(
      { cron: "* * * * *", scheduledTime: Date.UTC(2026, 0, 1, 0, 5, 0) } as ScheduledController,
      makeFakeEnv(),
      ctx,
    );
    await ctx.flush();

    expect(runReviewLoopEpochDispatchSweepMock).not.toHaveBeenCalled();
    expect(runReviewLoopSweepMock).not.toHaveBeenCalled();
    expect(deleteExpiredAuthSessionsMock).not.toHaveBeenCalled();
  });
});

describe("handleTransientOrFatalError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSentryRepeatSuppression();
  });

  it("logs transient D1 storage errors as skipped warnings without Sentry capture", async () => {
    const { handleTransientOrFatalError } = await import("../../apps/control-plane-worker/src/router");
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    };
    const err = new Error("D1_ERROR: D1 DB network connection lost");

    handleTransientOrFatalError(err, logger, "Memory job re-enqueue failed");

    expect(logger.warn).toHaveBeenCalledWith(
      { transientError: String(err) },
      "Memory job re-enqueue skipped due to transient D1 error",
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("captures fatal errors once and logs at warn level to avoid global logger re-capture", async () => {
    const { handleTransientOrFatalError } = await import("../../apps/control-plane-worker/src/router");
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    };
    const err = new Error("D1_ERROR: no such table: auth_sessions");

    handleTransientOrFatalError(err, logger, "Auth session cleanup failed", {
      component: "scheduler",
      cron: "*/5 * * * *",
    });

    // Exactly one explicit Sentry capture. The follow-up log is at warn level
    // (not error) with no `error` field, so the worker-wide
    // setLoggerErrorHandler bridge does NOT fire a second capture.
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(err, {
      tags: { component: "scheduler", cron: "*/5 * * * *" },
      extra: { failureMessage: "Auth session cleanup failed" },
    });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      {
        errorMessage: String(err),
        failureMessage: "Auth session cleanup failed",
        component: "scheduler",
        cron: "*/5 * * * *",
      },
      "Auth session cleanup failed",
    );
  });

  it("suppresses repeat captures of the same task error but keeps logging every occurrence", async () => {
    const { handleTransientOrFatalError } = await import("../../apps/control-plane-worker/src/router");
    const logger = { warn: vi.fn() };
    const err = new Error("Warm probe failed with status 522");

    handleTransientOrFatalError(err, logger, "Fetch-path warm probe failed");
    handleTransientOrFatalError(err, logger, "Fetch-path warm probe failed");
    handleTransientOrFatalError(err, logger, "Fetch-path warm probe failed");

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it("suppresses different tasks and different errors independently", async () => {
    const { handleTransientOrFatalError } = await import("../../apps/control-plane-worker/src/router");
    const logger = { warn: vi.fn() };

    handleTransientOrFatalError(new Error("boom"), logger, "Task A failed");
    handleTransientOrFatalError(new Error("boom"), logger, "Task B failed");
    handleTransientOrFatalError(new Error("other boom"), logger, "Task A failed");

    expect(captureException).toHaveBeenCalledTimes(3);
  });
});

describe("logger error bridge repeat suppression", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetSentryRepeatSuppression();
    // Importing the router registers the suppressing setLoggerErrorHandler callback.
    await import("../../apps/control-plane-worker/src/router");
  });

  it("captures repeated error-level logs with the same error once per window", async () => {
    const { createLogger } = await import("../../apps/control-plane-worker/src/logger");
    const logger = createLogger({ bindings: { component: "e2b-client" } });

    logger.error({ error: "Unauthorized: invalid API key", endpoint: "e2b" }, "E2B sandbox runtime operation failed");
    logger.error({ error: "Unauthorized: invalid API key", endpoint: "e2b" }, "E2B sandbox runtime operation failed");

    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("captures distinct bridged errors independently", async () => {
    const { createLogger } = await import("../../apps/control-plane-worker/src/logger");
    const logger = createLogger({ bindings: { component: "e2b-client" } });

    logger.error({ error: "Unauthorized: invalid API key" }, "E2B sandbox runtime operation failed");
    logger.error({ error: "sandbox not found" }, "E2B sandbox runtime operation failed");

    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it("keys bridged errors by stable context fields when no error object is logged", async () => {
    const { createLogger } = await import("../../apps/control-plane-worker/src/logger");
    const logger = createLogger({ bindings: { component: "e2b-client" } });

    // e2b-client error logs carry no `error` field, so the bridge synthesizes
    // the Error from the fixed message; distinct errorCode/status must still
    // report independently instead of collapsing into one suppression key.
    logger.error(
      { endpoint: "e2b", method: "runCommand", errorCode: "unauthorized", status: 401 },
      "E2B sandbox runtime operation failed",
    );
    logger.error(
      { endpoint: "e2b", method: "runCommand", errorCode: "rate_limited", status: 429 },
      "E2B sandbox runtime operation failed",
    );
    expect(captureException).toHaveBeenCalledTimes(2);

    // Repeat of an already-reported code stays suppressed.
    logger.error(
      { endpoint: "e2b", method: "runCommand", errorCode: "unauthorized", status: 401 },
      "E2B sandbox runtime operation failed",
    );
    expect(captureException).toHaveBeenCalledTimes(2);
  });
});

describe("scheduled handler repeat suppression (integration)", () => {
  let scheduledHandler: ((ctrl: unknown, env: unknown, ctx: unknown) => Promise<void>) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    claimReenqueueableIngestionEventsMock.mockResolvedValue([]);
    recoverStaleIngestionEventsMock.mockResolvedValue(0);
    resetSentryRepeatSuppression();
    vi.useFakeTimers();
    const mod = (await import("../../apps/control-plane-worker/src/router")) as {
      default?: { scheduled?: (ctrl: unknown, env: unknown, ctx: unknown) => Promise<void> };
    };
    scheduledHandler = mod.default?.scheduled;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runScheduledTick() {
    const ctx = makeFakeCtx();
    await scheduledHandler?.({ cron: GC_CRON } as ScheduledController, makeFakeEnv(), ctx);
    await ctx.flush();
  }

  it("captures a permanently failing task once per window across real scheduled ticks", async () => {
    const failure = new Error("D1_ERROR: no such table: auth_sessions");
    deleteExpiredAuthSessionsMock.mockRejectedValue(failure);
    const authCleanupCaptures = () =>
      captureException.mock.calls.filter(
        (args) => args[0] instanceof Error && args[0].message.includes("no such table"),
      );

    const start = Date.now();
    vi.setSystemTime(start);
    await runScheduledTick();
    expect(authCleanupCaptures()).toHaveLength(1);

    // Next GC tick inside the window: suppressed.
    vi.setSystemTime(start + 5 * 60 * 1000);
    await runScheduledTick();
    expect(authCleanupCaptures()).toHaveLength(1);

    // First tick after the window: re-reported with the suppressed count.
    vi.setSystemTime(start + SENTRY_SUPPRESSION_WINDOW_MS + 1);
    await runScheduledTick();
    const captures = authCleanupCaptures();
    expect(captures).toHaveLength(2);
    expect(captures[1][1]).toMatchObject({
      extra: { failureMessage: "Auth session cleanup failed", suppressedSinceLastReport: 1, firstSeenAt: start },
    });
  });
});
