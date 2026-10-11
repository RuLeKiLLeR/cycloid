import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSessionExportData = vi.fn();
const mockGetSessionState = vi.fn();
const mockGetSessionView = vi.fn();

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  getSessionExportData: (...args: unknown[]) => mockGetSessionExportData(...args),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  getSessionView: (...args: unknown[]) => mockGetSessionView(...args),
}));

import { buildSessionDebugSummary } from "../../apps/control-plane-worker/src/services/session-debug";
import type { Env, SessionState } from "../../apps/control-plane-worker/src/types";

function makeEnv(rows: Record<string, unknown>[]): Env {
  return {
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn(async () => ({ results: rows })),
        })),
      })),
    } as unknown as D1Database,
  } as Env;
}

function makeSessionState(): SessionState {
  return {
    sessionId: "sess-1",
    ownerUserId: "user-1",
    businessId: "biz-1",
    status: "active",
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:01:00.000Z",
    closedAt: null,
    lastEventId: null,
    title: "Debug summary",
    model: "gpt-5.4",
    repoOwner: "acme",
    repoName: "widgets",
  };
}

describe("buildSessionDebugSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionState.mockResolvedValue(makeSessionState());
    mockGetSessionExportData.mockResolvedValue({
      prompts: [
        {
          id: "p-1",
          status: "failed",
          createdAt: "2026-05-12T00:00:00.000Z",
          startedAt: null,
          completedAt: "2026-05-12T00:00:01.000Z",
        },
      ],
      events: [],
    });
    mockGetSessionView.mockResolvedValue({
      ok: true,
      payload: {
        session: {
          phase: "failed",
          spawnDurationMs: 1234,
          sandboxStatus: "ready",
          publishStatus: "failed",
          publishStage: "verifying",
          publishError: "GitHub token leaked at /workspace/repo/.git/config",
          prUrl: null,
          prDraft: false,
          prManualReviewReason: "needs review",
          verification: {
            verified: false,
            verdict: "INCONCLUSIVE",
            status: "manual_review_required",
            publishMode: "draft",
            explanation: "Could not verify safely",
            manualReviewReason: "manual check requested",
            caveats: ["No browser evidence"],
          },
          runtimeProvenance: {
            runtime: {
              provider: "e2b",
              sandboxId: "sandbox-1",
              templateId: "template-1",
            },
            bootMode: "fresh_clone",
            sandboxImageVersion: "image-1",
          },
        },
      },
    });
  });

  it("returns expanded session and prompt debug fields with redaction", async () => {
    const summary = await buildSessionDebugSummary(
      makeEnv([
        {
          prompt_id: "p-1",
          outcome: "failed",
          error_code: "spawn_timeout",
          error_details_json: JSON.stringify({
            message: "Timeout before bridge startup",
            responseBodyPreview: "Provider response with customer repo text",
            stack: "Error: Timeout\n    at /workspace/repo/file.ts:1:1",
          }),
          dd_trace_id: null,
          bt_span_id: null,
        },
      ]),
      "sess-1",
      null,
      null,
      50,
    );

    expect(summary?.session.publish).toEqual({
      status: "failed",
      stage: "verifying",
      error: "[redacted]",
    });
    expect(summary?.session.pullRequest).toEqual({
      url: null,
      state: null,
      manualReviewReason: "needs review",
    });
    expect(summary?.session.verification).toEqual({
      verdict: "INCONCLUSIVE",
      verified: false,
      status: "manual_review_required",
      publishMode: "draft",
      details: {
        explanation: "Could not verify safely",
        manualReviewReason: "manual check requested",
        caveats: ["No browser evidence"],
      },
    });
    expect(summary?.session.taskOutcome).toEqual({ outcome: null, badSessionReason: null });
    expect(summary?.prompts[0]?.traces.btSpanMissingReason).toBe("pre_bridge_failure");
    expect(summary?.prompts[0]?.errorDetails).toEqual({
      message: "Timeout before bridge startup",
      redacted: true,
    });
    expect(JSON.stringify(summary)).not.toContain("/workspace/repo");
    expect(JSON.stringify(summary)).not.toContain("GitHub token");
    expect(JSON.stringify(summary)).not.toContain("Provider response");
  });
});
