// The `notify_qa_issue` live side-effect: a NON-BLOCKING QA-issue DM (verification came back
// run_limit/stopped/failed on a fresh run). Rides notifyUserBlocked's DM transport, sets no
// blocked_reason, fires no loud/ops fanout. Driven through the live sink (buildLiveSideEffectSink)
// exactly as the spine dispatches a committed bag — the repo's established executor-test pattern.
import { describe, expect, it, vi } from "vitest";

import { BlockerKind } from "../../../apps/control-plane-worker/src/enums/blocker";
import type { FsmRecord, SideEffectKind } from "../../../apps/control-plane-worker/src/session/fsm/types";

const mocks = vi.hoisted(() => ({
  getSessionState: vi.fn(),
  closeSessionState: vi.fn(),
  notifyUserBlocked: vi.fn(async () => "sent"),
  syncFsmLabelsForPr: vi.fn(async () => ({ added: [], removed: [] })),
}));

vi.mock("../../../apps/control-plane-worker/src/session/state", () => ({
  getSessionState: mocks.getSessionState,
  closeSessionState: mocks.closeSessionState,
}));
vi.mock("../../../apps/control-plane-worker/src/session/notify-user-blocked", () => ({
  notifyUserBlocked: mocks.notifyUserBlocked,
}));
vi.mock("../../../apps/control-plane-worker/src/services/fsm-label-sync", () => ({
  syncFsmLabelsForPr: mocks.syncFsmLabelsForPr,
}));
import type { SideEffectDispatch } from "../../../apps/control-plane-worker/src/session/fsm/apply-event";
import { buildLiveSideEffectSink } from "../../../apps/control-plane-worker/src/session/fsm/live-side-effects";
import type { Env } from "../../../apps/control-plane-worker/src/types";

// Production env so the DM path is not slack-suppressed; emit stub keeps DD out of the test.
const ENV = { WORKER_ENV: "production" } as unknown as Env;

// A REVIEW self-loop dispatch carrying notify_qa_issue (as transition.ts emits for a fresh infra terminal).
function reviewDispatch(overrides: Record<string, unknown> = {}): SideEffectDispatch {
  const record = {
    sessionId: "sid-qa",
    version: 12,
    state: "REVIEW",
    prUrl: "https://github.com/acme/repo/pull/9",
    headSha: "h9",
    blockedReason: null,
    ...overrides,
  } as unknown as FsmRecord;
  return {
    mode: "live",
    sessionId: "sid-qa",
    version: 12,
    from: "REVIEW",
    to: "REVIEW",
    event: { type: "verification.stopped", runId: 5 },
    sideEffects: [{ kind: "notify_qa_issue" as SideEffectKind }],
    resultingRecord: record,
  } as SideEffectDispatch;
}

function dispatchOne(dispatch: SideEffectDispatch): Promise<void> {
  return buildLiveSideEffectSink(ENV, { emit: async () => {} }).dispatch(dispatch) as Promise<void>;
}

describe("notify_qa_issue executor", () => {
  it("sends the QA-issue DM via notifyUserBlocked with NO blocked_reason coupling", async () => {
    mocks.getSessionState.mockResolvedValue({ ownerUserId: 501, callbackContext: null });
    mocks.notifyUserBlocked.mockResolvedValue("sent");
    const dispatch = reviewDispatch();
    await dispatchOne(dispatch);
    expect(mocks.notifyUserBlocked).toHaveBeenCalledTimes(1);
    expect(mocks.notifyUserBlocked.mock.calls[0][1]).toMatchObject({ kind: BlockerKind.VerificationIssue });
    // The record's blocked_reason stays null — this DM never blocks.
    expect(dispatch.resultingRecord.blockedReason).toBeNull();
  });

  it("no-ops when the owner has no resolvable Slack target (fail-closed, best-effort)", async () => {
    mocks.getSessionState.mockResolvedValue({ ownerUserId: 501, callbackContext: null });
    mocks.notifyUserBlocked.mockResolvedValue("skipped_no_slack");
    await expect(dispatchOne(reviewDispatch())).resolves.toBeUndefined();
    expect(mocks.notifyUserBlocked).toHaveBeenCalled();
  });

  it("skips the DM entirely (no notifyUserBlocked) when the session has no resolvable owner", async () => {
    mocks.getSessionState.mockResolvedValue(null);
    mocks.notifyUserBlocked.mockClear();
    await dispatchOne(reviewDispatch());
    expect(mocks.notifyUserBlocked).not.toHaveBeenCalled();
  });
});
