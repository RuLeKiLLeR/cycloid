import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GC_CRON } from "../../apps/control-plane-worker/src/constants/scheduler";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_opts: unknown, cls: unknown) => cls,
  withSentry: (_opts: unknown, handler: unknown) => handler,
  setTag: vi.fn(),
  setUser: vi.fn(),
  captureException: vi.fn(),
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
  tracedEnv: (env: unknown) => env,
  tracedFetch: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/services/warm", () => ({
  warmPublicFetchPath: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../apps/control-plane-worker/src/benchmark/service.js", () => ({
  reapStuckBenchmarkRuns: vi.fn().mockResolvedValue({ reaped: 0, runIds: [] }),
}));

vi.mock("../../apps/control-plane-worker/src/integrations/github-health.js", () => ({
  runDueGithubHealthChecks: vi.fn().mockResolvedValue({ checked: 0, skipped: 0, failed: 0 }),
}));

vi.mock("../../apps/control-plane-worker/src/integrations/linear-health.js", () => ({
  runDueLinearHealthChecks: vi.fn().mockResolvedValue({ checked: 0, skipped: 0, failed: 0 }),
}));

vi.mock("../../apps/control-plane-worker/src/session/cleanup.js", () => ({
  cleanupExpiredE2BRuntimes: vi.fn().mockResolvedValue({ scanned: 0, killed: 0, cleared: 0, errors: 0 }),
}));

vi.mock("../../apps/control-plane-worker/src/auth/db", () => ({
  deleteExpiredAuthSessions: vi.fn().mockResolvedValue(0),
}));

vi.mock("../../apps/control-plane-worker/src/webhooks/db", () => ({
  deleteExpiredSlackRepoDisambiguations: vi.fn().mockResolvedValue(0),
  deleteExpiredWebhookIdempotencyClaims: vi.fn().mockResolvedValue(0),
  isTransientD1StorageError: vi.fn().mockReturnValue(false),
}));

vi.mock("../../apps/control-plane-worker/src/memory/db", () => ({
  terminalizeExhaustedJobs: vi.fn().mockResolvedValue(0),
  getReenqueueableMemoryJobs: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../apps/control-plane-worker/src/constants/memory.js", () => ({
  MEMORY_JOB_STALE_THRESHOLD_MS: 60_000,
  MEMORY_JOB_MAX_ATTEMPTS: 3,
}));

const deleteIntegrationLifecycleEventsBeforeMock = vi.fn();
vi.mock("../../apps/control-plane-worker/src/integrations/lifecycle/db.js", () => ({
  deleteIntegrationLifecycleEventsBefore: deleteIntegrationLifecycleEventsBeforeMock,
}));

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

describe("scheduled handler -- integration lifecycle retention", () => {
  let scheduledHandler: ((ctrl: unknown, env: unknown, ctx: unknown) => Promise<void>) | undefined;

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T18:00:00.000Z"));
    deleteIntegrationLifecycleEventsBeforeMock.mockResolvedValue(0);
    const mod = (await import("../../apps/control-plane-worker/src/router")) as {
      default?: { scheduled?: (ctrl: unknown, env: unknown, ctx: unknown) => Promise<void> };
    };
    scheduledHandler = mod.default?.scheduled;
  });

  it("prunes passed, failed, and skipped lifecycle rows with status-tiered windows", async () => {
    const ctx = makeFakeCtx();
    await scheduledHandler?.({ cron: GC_CRON } as ScheduledController, makeFakeEnv(), ctx);
    await ctx.flush();

    const now = Date.now();
    expect(deleteIntegrationLifecycleEventsBeforeMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      now - 30 * 24 * 60 * 60 * 1000,
      12_000,
      "passed",
    );
    expect(deleteIntegrationLifecycleEventsBeforeMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      now - 90 * 24 * 60 * 60 * 1000,
      12_000,
      "failed",
    );
    expect(deleteIntegrationLifecycleEventsBeforeMock).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      now - 14 * 24 * 60 * 60 * 1000,
      12_000,
      "skipped",
    );
  });

  it("skips lifecycle retention pruning on the 5-minute tick", async () => {
    const ctx = makeFakeCtx();
    await scheduledHandler?.({ cron: "*/5 * * * *" } as ScheduledController, makeFakeEnv(), ctx);
    await ctx.flush();

    expect(deleteIntegrationLifecycleEventsBeforeMock).not.toHaveBeenCalled();
  });
});
