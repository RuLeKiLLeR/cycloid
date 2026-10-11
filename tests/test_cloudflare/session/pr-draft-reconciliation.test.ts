import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListSessionIdsByWebhookRef = vi.hoisted(() => vi.fn());
const mockUpdateSessionPrDraftState = vi.hoisted(() => vi.fn());
const mockUpdateSessionPrMetadataDraft = vi.hoisted(() => vi.fn());

vi.mock("../../../apps/control-plane-worker/src/webhooks/db", () => ({
  SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR: "github_pr_url",
  listSessionIdsByWebhookRef: mockListSessionIdsByWebhookRef,
}));

vi.mock("../../../apps/control-plane-worker/src/session/state", () => ({
  updateSessionPrDraftState: mockUpdateSessionPrDraftState,
}));

vi.mock("../../../apps/control-plane-worker/src/session/pr-metadata-db", () => ({
  updateSessionPrMetadataDraft: mockUpdateSessionPrMetadataDraft,
}));

import { reconcilePrDraftStateForPr } from "../../../apps/control-plane-worker/src/session/pr-draft-reconciliation";

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
} as unknown as Parameters<typeof reconcilePrDraftStateForPr>[0]["logger"];

describe("reconcilePrDraftStateForPr", () => {
  beforeEach(() => {
    mockListSessionIdsByWebhookRef.mockReset();
    mockUpdateSessionPrDraftState.mockReset();
    mockUpdateSessionPrMetadataDraft.mockReset();
    mockUpdateSessionPrMetadataDraft.mockResolvedValue(undefined);
    (logger.error as ReturnType<typeof vi.fn>).mockClear();
    (logger.warn as ReturnType<typeof vi.fn>).mockClear();
  });

  it("marks every session attached to a ready PR as non-draft", async () => {
    mockListSessionIdsByWebhookRef.mockResolvedValue(["implementation-session", "verification-session"]);
    mockUpdateSessionPrDraftState
      .mockResolvedValueOnce({ ok: true, status: 200, payload: { ok: true, updated: true } })
      .mockResolvedValueOnce({ ok: true, status: 200, payload: { ok: true, updated: false, reason: "no_pr" } });

    const result = await reconcilePrDraftStateForPr({
      env: { DB: {} } as never,
      logger,
      prUrl: "https://github.com/acme/widgets/pull/42",
      draft: false,
    });

    expect(mockListSessionIdsByWebhookRef).toHaveBeenCalledWith(
      {},
      "github_pr_url",
      "https://github.com/acme/widgets/pull/42",
    );
    expect(mockUpdateSessionPrDraftState).toHaveBeenNthCalledWith(
      1,
      { DB: {} },
      "implementation-session",
      { prUrl: "https://github.com/acme/widgets/pull/42", draft: false, manualReviewReason: null },
      null,
    );
    expect(mockUpdateSessionPrDraftState).toHaveBeenNthCalledWith(
      2,
      { DB: {} },
      "verification-session",
      { prUrl: "https://github.com/acme/widgets/pull/42", draft: false, manualReviewReason: null },
      null,
    );
    expect(mockUpdateSessionPrMetadataDraft).toHaveBeenCalledOnce();
    expect(mockUpdateSessionPrMetadataDraft).toHaveBeenCalledWith(
      {},
      {
        sessionId: "implementation-session",
        prUrl: "https://github.com/acme/widgets/pull/42",
        prDraft: false,
      },
    );
    expect(result).toEqual({ sessionCount: 2, updated: 1, skipped: 1, failed: 0 });
  });

  it("counts failed session updates without stopping sibling reconciliation", async () => {
    mockListSessionIdsByWebhookRef.mockResolvedValue(["session-a", "session-b"]);
    mockUpdateSessionPrDraftState
      .mockResolvedValueOnce({ ok: false, status: 500, payload: null, error: "boom" })
      .mockResolvedValueOnce({ ok: true, status: 200, payload: { ok: true, updated: true } });

    const result = await reconcilePrDraftStateForPr({
      env: { DB: {} } as never,
      logger,
      prUrl: "https://github.com/acme/widgets/pull/42",
      draft: true,
      manualReviewReason: "Manual review required.",
      requestId: "req-1",
    });

    expect(mockUpdateSessionPrDraftState).toHaveBeenNthCalledWith(
      2,
      { DB: {} },
      "session-b",
      {
        prUrl: "https://github.com/acme/widgets/pull/42",
        draft: true,
        manualReviewReason: "Manual review required.",
      },
      "req-1",
    );
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(result).toEqual({ sessionCount: 2, updated: 1, skipped: 0, failed: 1 });
  });
});
