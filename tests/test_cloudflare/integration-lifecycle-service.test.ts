import { beforeEach, describe, expect, it, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    info: loggerMocks.info,
    warn: loggerMocks.warn,
    error: loggerMocks.error,
  }),
}));

vi.mock("../../apps/control-plane-worker/src/observability/run-with-sentry-tag", () => ({
  runWithSentryTag: vi.fn(async (_operation: string, fn: () => Promise<unknown>) => {
    await fn().catch(() => undefined);
  }),
}));

import {
  mapReasonCodeToBusinessMessage,
  mapReasonCodeToUserMessage,
  sanitizeLifecycleDetails,
  writeIntegrationLifecycleEvent,
  writeIntegrationLifecycleEvents,
} from "../../apps/control-plane-worker/src/integrations/lifecycle/service";
import { INTEGRATION_LIFECYCLE_STAGE, INTEGRATION_LIFECYCLE_STATUS } from "../../shared/enums/integration-lifecycle";

describe("integration lifecycle service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    loggerMocks.info.mockReset();
    loggerMocks.warn.mockReset();
    loggerMocks.error.mockReset();
  });

  it("drops disallowed and nested detail fields", () => {
    const json = sanitizeLifecycleDetails({
      repoOwner: "trycycloid",
      repoName: "cycloid",
      requestId: "req-1",
      provider: "slack",
      webhookDeliveryId: "evt-123",
      ignored: "nope",
      nested: { nope: true },
      attempts: [1, 2, 3],
    });

    expect(json).toBe(
      JSON.stringify({
        repoOwner: "trycycloid",
        repoName: "cycloid",
        requestId: "req-1",
        provider: "slack",
        webhookDeliveryId: "evt-123",
      }),
    );
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      { event: "integration_lifecycle_detail_key_dropped", key: "ignored" },
      "Dropped unsupported lifecycle detail key",
    );
  });

  it("records sanitized lifecycle events", async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;

    await writeIntegrationLifecycleEvent(db, {
      integrationId: "github",
      stage: INTEGRATION_LIFECYCLE_STAGE.PROVIDER_PROBE_PASSED,
      status: INTEGRATION_LIFECYCLE_STATUS.FAILED,
      reasonCode: "repo_access_denied",
      message: "boom",
      details: {
        repoOwner: "trycycloid",
        repoName: "cycloid",
        ignored: "drop-me",
      },
    });

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT OR IGNORE INTO integration_lifecycle_events"));
    expect(bind.mock.calls[0][9]).toBe(JSON.stringify({ repoOwner: "trycycloid", repoName: "cycloid" }));
  });

  it("records multiple lifecycle events with one D1 batch", async () => {
    const statements: unknown[] = [];
    const bind = vi.fn((...params: unknown[]) => {
      const statement = { params };
      statements.push(statement);
      return statement;
    });
    const prepare = vi.fn(() => ({ bind }));
    const batch = vi.fn(async () => statements.map(() => ({ success: true })));
    const db = { prepare, batch } as unknown as D1Database;

    await writeIntegrationLifecycleEvents(db, [
      {
        integrationId: "github",
        stage: INTEGRATION_LIFECYCLE_STAGE.PROVIDER_PROBE_PASSED,
        status: INTEGRATION_LIFECYCLE_STATUS.PASSED,
        message: "github ready",
        details: { repoOwner: "trycycloid", ignored: "drop-me" },
      },
      {
        integrationId: "linear",
        stage: INTEGRATION_LIFECYCLE_STAGE.PROVIDER_PROBE_PASSED,
        status: INTEGRATION_LIFECYCLE_STATUS.SKIPPED,
        message: "linear skipped",
        details: { repoName: "cycloid" },
      },
    ]);

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledWith(statements);
    expect(bind.mock.calls[0][9]).toBe(JSON.stringify({ repoOwner: "trycycloid" }));
    expect(bind.mock.calls[1][9]).toBe(JSON.stringify({ repoName: "cycloid" }));
  });

  it("logs a structured warning when lifecycle persistence fails", async () => {
    const run = vi.fn(async () => {
      throw new Error("d1 down");
    });
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;

    await expect(
      writeIntegrationLifecycleEvent(db, {
        integrationId: "github",
        stage: INTEGRATION_LIFECYCLE_STAGE.PROVIDER_PROBE_PASSED,
        status: INTEGRATION_LIFECYCLE_STATUS.FAILED,
        reasonCode: "repo_access_denied",
        message: "boom",
      }),
    ).rejects.toThrow("d1 down");

    expect(loggerMocks.warn).toHaveBeenCalledWith(
      {
        event: "integration_lifecycle_write_failed",
        integration_id: "github",
        stage: "provider_probe_passed",
        status: "failed",
        error_class: "Error",
      },
      "Failed to persist integration lifecycle event",
    );
  });

  it("maps GitHub reason codes to actionable user messages", () => {
    expect(
      mapReasonCodeToUserMessage("github", "repo_access_denied", {
        owner: "trycycloid",
        name: "cycloid",
      }),
    ).toContain("trycycloid/cycloid");
    expect(mapReasonCodeToUserMessage("github", "token_missing")).toContain("Reconnect GitHub");
  });

  it("maps non-GitHub reason codes to provider-aware messages", () => {
    expect(mapReasonCodeToUserMessage("slack", "workspace_not_installed")).toContain("Slack workspace");
    expect(mapReasonCodeToUserMessage("sentry", "token_missing")).toContain("Connect Sentry");
    expect(mapReasonCodeToBusinessMessage("openai", "token_missing")).toContain("member needs to reconnect OpenAI");
  });
});
