import { describe, expect, it } from "vitest";

import { qaCommentVerdictActionable } from "../../apps/control-plane-worker/src/github/pr-review-bots";
import {
  containsManagedQaCommentMarker,
  extractManagedQaCommentVerdict,
  qaCommentMarker,
  qaCommentMarkerSearch,
} from "../../apps/control-plane-worker/src/github/verification-comment-marker";

const target = { owner: "acme", repo: "web", prNumber: 42 };

describe("qaCommentMarker verdict field", () => {
  it("embeds the verdict and stays discoverable by the head-agnostic search prefix", () => {
    const body = `${qaCommentMarker("acme", "web", 42, "deadbeef", "app_breaks")}\n\n## Cycloid QA`;
    // The #6939 search prefix (`… pr=42 head=`) must remain a prefix of the extended marker so the
    // existing publisher-side "find my managed comment" lookup keeps working unchanged.
    expect(body.includes(qaCommentMarkerSearch("acme", "web", 42))).toBe(true);
    expect(containsManagedQaCommentMarker(body, target)).toBe(true);
  });

  it("round-trips every verdict value", () => {
    for (const verdict of ["app_breaks", "pass", "none"] as const) {
      const body = qaCommentMarker("acme", "web", 42, "sha", verdict);
      expect(extractManagedQaCommentVerdict(body, target)).toBe(verdict);
    }
  });

  it("returns null when no managed marker for this PR is present", () => {
    expect(extractManagedQaCommentVerdict("plain comment", target)).toBeNull();
    // A marker for a DIFFERENT pr must not leak its verdict into this target.
    const other = qaCommentMarker("acme", "web", 99, "sha", "app_breaks");
    expect(extractManagedQaCommentVerdict(other, target)).toBeNull();
  });

  it("tolerates a legacy #6939 marker with no verdict field (defaults to none)", () => {
    // Comments published by #6939 before this field existed carry `… head=sha -->` with no verdict.
    const legacy = "<!-- cycloid-qa:v1 owner=acme repo=web pr=42 head=sha -->\n## Cycloid QA";
    expect(containsManagedQaCommentMarker(legacy, target)).toBe(true);
    expect(extractManagedQaCommentVerdict(legacy, target)).toBe("none");
  });

  it("does not read a stray verdict= out of the body when a malformed marker omits its closing -->", () => {
    // A truncated/malformed marker (no `-->`) must not let the fallback slice run into the comment body and
    // pick up an unrelated `verdict=app_breaks` token far downstream — the bounded scan window forbids it.
    const malformed = `<!-- cycloid-qa:v1 owner=acme repo=web pr=42 head=sha${" ".repeat(600)}\n\nverdict=app_breaks in prose`;
    expect(containsManagedQaCommentMarker(malformed, target)).toBe(true);
    expect(extractManagedQaCommentVerdict(malformed, target)).toBe("none");
  });

  it("treats a stopped/unverifiable session's synthesized INCONCLUSIVE (→ app_breaks marker) as actionable", () => {
    // A stopped or malformed QA session is synthesized as INCONCLUSIVE and rendered with a `verdict=app_breaks`
    // marker (see verification-comment.test.ts "stopped structured verifier result"). That is deliberate,
    // pre-A4, LOCKED behavior: an unconfirmed verdict must SURFACE to the review loop, not silently pass. Lock
    // the intake-side consequence — the stopped-shaped comment is actionable, exactly like a real app_breaks.
    const stoppedBody = `${qaCommentMarker("acme", "web", 42, "head-from-github", "app_breaks")}\n## Cycloid QA\n\nQA Tester session stopped before it could report a verdict.`;
    expect(qaCommentVerdictActionable(extractManagedQaCommentVerdict(stoppedBody, target))).toBe(true);
    // A clean pass stays inert.
    const passBody = qaCommentMarker("acme", "web", 42, "sha", "pass");
    expect(qaCommentVerdictActionable(extractManagedQaCommentVerdict(passBody, target))).toBe(false);
  });
});
