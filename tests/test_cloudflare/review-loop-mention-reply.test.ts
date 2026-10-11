import { describe, expect, it } from "vitest";

import { mentionReplyTargetSourceIds } from "../../apps/control-plane-worker/src/services/review-loop-epochs";
import {
  resolveMentionReplyItem,
  resolveReviewLoopEpochOwnedReplyItem,
} from "../../apps/control-plane-worker/src/session/publish-service";

// A `mention` epoch's reply target is always one of its OWN authorized targets (the exact comment/review
// the user @-mentioned in). getPrReviewLoopWorklist has no producer that surfaces a human top-level
// `issue-comment:<id>` (its issue-comment lane is bot-allowlist-only), so the shared worklist lookup
// rejects every mention reply as "not in the current worklist". resolveMentionReplyItem admits the target
// directly from the mention's authorized target ids, mirroring the duplicate-group synthesis in
// resolveReviewLoopReplyItem.
describe("resolveMentionReplyItem (@cycloid mention reply target resolution)", () => {
  const prUrl = "https://github.com/acme/repo/pull/90";

  it("resolves a mention's authorized top-level issue-comment into a reply item", () => {
    const item = resolveMentionReplyItem({
      authorizedTargetSourceIds: ["issue-comment:4920600307"],
      targetSourceId: "issue-comment:4920600307",
      prUrl,
    });
    expect(item).not.toBeNull();
    expect(item!.sourceId).toBe("issue-comment:4920600307");
    // Top-level issue comment → a new top-level PR comment; the derived source anchor is used only in
    // the reply body's `Source:` line, and there is no review thread to resolve.
    expect(item!.sourceUrl).toBe(`${prUrl}#issuecomment-4920600307`);
    expect(item!.reviewThreadId).toBeNull();
  });

  it("resolves a mention's authorized inline review-comment into a reply item", () => {
    const item = resolveMentionReplyItem({
      authorizedTargetSourceIds: ["review-comment:6001"],
      targetSourceId: "review-comment:6001",
      prUrl,
    });
    expect(item).not.toBeNull();
    expect(item!.sourceId).toBe("review-comment:6001");
    expect(item!.sourceUrl).toBe(`${prUrl}#discussion_r6001`);
    expect(item!.reviewThreadId).toBeNull();
  });

  it("rejects a target that is NOT one of the mention's authorized targets (no arbitrary-comment replies)", () => {
    const item = resolveMentionReplyItem({
      authorizedTargetSourceIds: ["issue-comment:4920600307"],
      // A different, unrelated comment the agent must not be able to reply to via this mention epoch.
      targetSourceId: "issue-comment:9999999999",
      prUrl,
    });
    expect(item).toBeNull();
  });

  it("rejects an authorized target whose kind has no reply primitive (e.g. check-run-failure)", () => {
    const item = resolveMentionReplyItem({
      authorizedTargetSourceIds: ["check-run-failure:5"],
      targetSourceId: "check-run-failure:5",
      prUrl,
    });
    expect(item).toBeNull();
  });
});

// The reply allow-list must be the mention payload's TARGET sourceIds, not the broader triggeringSourceIds:
// a targeted review-comment mention folds the replied-to PARENT into triggering/handled for cross-epoch
// dedup while keeping it OUT of the authorized targets (it is context, not a reply target). Using the
// triggering set would let an untrusted mention steer a reply onto the parent the prompt never authorized.
describe("mentionReplyTargetSourceIds (authorized reply targets, parent excluded)", () => {
  it("returns only the payload target ids, excluding a context-only parent folded into triggeringSourceIds", () => {
    const targets = mentionReplyTargetSourceIds({
      // Parent (review-comment:6000) is folded into triggering for dedup but is NOT a reply target.
      triggeringSourceIds: ["review-comment:6000", "review-comment:6001"],
      terminalEvidence: [
        { type: "mention", mode: "targeted", sourceIds: ["review-comment:6001"], mentionText: "@cycloid fix" },
      ],
    });
    expect(targets).toEqual(["review-comment:6001"]);
  });

  it("falls back to triggeringSourceIds for a legacy payload that predates the sourceIds field", () => {
    const targets = mentionReplyTargetSourceIds({
      triggeringSourceIds: ["issue-comment:5001"],
      // Legacy mention evidence carried no `sourceIds` — mirror the dispatch's `?? triggeringSourceIds`.
      terminalEvidence: [{ type: "mention", mode: "directive", mentionText: "@cycloid whats my name" }],
    });
    expect(targets).toEqual(["issue-comment:5001"]);
  });

  it("falls back to triggeringSourceIds when the epoch carries no mention evidence at all", () => {
    const targets = mentionReplyTargetSourceIds({
      triggeringSourceIds: ["issue-comment:7001"],
      terminalEvidence: [],
    });
    expect(targets).toEqual(["issue-comment:7001"]);
  });
});

// A bot/human review epoch's reply target can fall out of the LIVE worklist refetch after the agent's
// own fix push flips the commented thread `isOutdated` (dropped as thread_outdated-unpromptable). The
// verdict reply for a just-addressed comment must still be postable: an id the epoch prompted (or was
// triggered by) is a legitimate reply target for the epoch's whole lifetime (PR #7656 — fix pushed 31s
// after the ChatGPT comment; the contractual reply was rejected "not in the current worklist" and the
// comment ended silently disposed). Generalizes the mention resolution above to non-mention epochs.
describe("resolveReviewLoopEpochOwnedReplyItem (prompted/triggering ids stay reply-targetable)", () => {
  const prUrl = "https://github.com/acme/repo/pull/91";

  it("resolves a prompted inline review-comment that the live worklist no longer surfaces", () => {
    const item = resolveReviewLoopEpochOwnedReplyItem({
      epoch: { promptedSourceIds: ["review-comment:3564601759"], triggeringSourceIds: ["review-comment:3564601759"] },
      targetSourceId: "review-comment:3564601759",
      prUrl,
    });
    expect(item).not.toBeNull();
    expect(item!.sourceId).toBe("review-comment:3564601759");
    expect(item!.sourceUrl).toBe(`${prUrl}#discussion_r3564601759`);
    // No live worklist item → no known review thread; the auto-resolve-thread step is skipped.
    expect(item!.reviewThreadId).toBeNull();
  });

  it("resolves a prompted review-body target (a bot review submission's decline reply)", () => {
    const item = resolveReviewLoopEpochOwnedReplyItem({
      epoch: { promptedSourceIds: ["review-body:4678328560"], triggeringSourceIds: ["human:4678328560"] },
      targetSourceId: "review-body:4678328560",
      prUrl,
    });
    expect(item).not.toBeNull();
    expect(item!.sourceUrl).toBe(`${prUrl}#pullrequestreview-4678328560`);
  });

  it("falls back to triggering ids ONLY for legacy epochs with no prompted ids recorded", () => {
    const item = resolveReviewLoopEpochOwnedReplyItem({
      epoch: { promptedSourceIds: [], triggeringSourceIds: ["issue-comment:777"] },
      targetSourceId: "issue-comment:777",
      prUrl,
    });
    expect(item).not.toBeNull();
    expect(item!.sourceUrl).toBe(`${prUrl}#issuecomment-777`);
  });

  it("rejects a triggering-only id when the epoch HAS prompted ids (never-shown feedback stays re-drivable)", () => {
    // `triggering − prompted` is late-folded or budget-dropped work the agent never saw; the reply
    // contract covers prompted ids only, and the carried item must stay answerable by a later epoch.
    const item = resolveReviewLoopEpochOwnedReplyItem({
      epoch: {
        promptedSourceIds: ["review-comment:1"],
        triggeringSourceIds: ["review-comment:1", "issue-comment:777"],
      },
      targetSourceId: "issue-comment:777",
      prUrl,
    });
    expect(item).toBeNull();
  });

  it("rejects an id the epoch neither prompted nor was triggered by (no arbitrary-comment replies)", () => {
    const item = resolveReviewLoopEpochOwnedReplyItem({
      epoch: { promptedSourceIds: ["review-comment:1"], triggeringSourceIds: ["review-comment:1"] },
      targetSourceId: "review-comment:2",
      prUrl,
    });
    expect(item).toBeNull();
  });

  it("rejects an owned id whose kind has no reply primitive (check-run-failure)", () => {
    const item = resolveReviewLoopEpochOwnedReplyItem({
      epoch: { promptedSourceIds: ["check-run-failure:5"], triggeringSourceIds: ["check-run-failure:5"] },
      targetSourceId: "check-run-failure:5",
      prUrl,
    });
    expect(item).toBeNull();
  });
});
