// Unit tests for the review-loop NOISE GATE classifier (D4). FAIL-OPEN is the load-bearing property:
// only a KNOWN bot's confident "no findings" output (or an empty commented review) is gated; a body
// carrying real feedback, an unknown/custom bot, or a human is NEVER gated (a false gate silently drops
// real customer feedback — far worse than one wasted prompt).
import { describe, expect, it } from "vitest";

import { classifyReviewLoopNoise } from "../../apps/control-plane-worker/src/github/review-loop-noise-gate";

/**
 * A "near miss" = a KNOWN bot whose body matched a no-findings phrase but was NOT gated because residual
 * content survived the strip. It is still forwarded (fail-open); we only surface it for telemetry so we
 * can size how often the residual heuristic can't finish the job. `residualLength` lets a metric separate
 * likely footer-chrome misses (small) from genuinely-appended real feedback (large).
 */
function expectNearMiss(verdict: ReturnType<typeof classifyReviewLoopNoise>): void {
  expect(verdict.gated).toBe(false);
  const nearMiss = verdict.gated === false ? verdict.nearMiss : undefined;
  expect(nearMiss).toBeDefined();
  expect(nearMiss?.residualLength).toBeGreaterThan(0);
}

describe("classifyReviewLoopNoise", () => {
  // ── the exhibit + each bot's no-findings template is GATED ──────────────────────────────────
  it("gates the prod exhibit — Strix 'no security issues found'", () => {
    const verdict = classifyReviewLoopNoise({ botKey: "known:strix", body: "No security issues found." });
    expect(verdict).toEqual({ gated: true, reason: "no_findings" });
  });

  it.each([
    ["known:strix", "No security issues found in this PR."],
    ["known:strix", "Strix security scan complete — no vulnerabilities detected."],
    ["known:greptile", "No issues found."],
    ["known:greptile", "No comments"],
    ["known:coderabbit", "**Actionable comments posted: 0**"],
    ["known:coderabbit", "Nothing to flag here."],
    ["known:chatgpt-codex", "No issues found. LGTM"],
    ["known:cursor-bugbot", "No bugs found."],
  ])("gates a known-bot no-findings template (%s)", (botKey, body) => {
    expect(classifyReviewLoopNoise({ botKey, body })).toEqual({ gated: true, reason: "no_findings" });
  });

  // ── the SAME bot with real findings is NOT gated ────────────────────────────────────────────
  it.each([
    ["known:strix", "No SQL-injection issues found, but the auth check in login.ts should validate the token expiry."],
    ["known:greptile", "Consider extracting this into a helper; also there is a null-deref risk on line 42."],
    ["known:coderabbit", "Actionable comments posted: 3\n- fix the race in worker.ts\n- ..."],
    ["known:strix", "Found a high-severity path traversal in fileHandler.ts — sanitize the input."],
  ])("does NOT gate a known bot that carries actual findings (%s)", (botKey, body) => {
    expect(classifyReviewLoopNoise({ botKey, body })).toEqual({ gated: false });
  });

  // ── unknown / custom bot / human are NEVER gated (fail-open) ────────────────────────────────
  it("does NOT gate a custom bot even with a no-findings body", () => {
    expect(classifyReviewLoopNoise({ botKey: "custom:some-bot", body: "No issues found." })).toEqual({ gated: false });
  });

  it("does NOT gate an unknown / null bot key", () => {
    expect(classifyReviewLoopNoise({ botKey: null, body: "No issues found." })).toEqual({ gated: false });
    expect(classifyReviewLoopNoise({ botKey: "known:not-a-real-bot", body: "No issues found." })).toEqual({
      gated: false,
    });
  });

  it("does NOT gate an arbitrary short body that lacks a no-findings phrase", () => {
    expect(classifyReviewLoopNoise({ botKey: "known:strix", body: "Please rebase onto main." })).toEqual({
      gated: false,
    });
  });

  // ── residual guard: a no-findings phrase + a SHORT real note must NOT gate (fail-open) ───────
  // These are also NEAR MISSES: the phrase matched but real content survived, so they are forwarded AND
  // reported for telemetry (residualLength > 0).
  it("does NOT gate a no-findings phrase that carries a short appended note (reports near-miss)", () => {
    // Regression for the residual-threshold fail-open hole: even a brief actionable note survives.
    expectNearMiss(classifyReviewLoopNoise({ botKey: "known:greptile", body: "No issues found, but fix null check" }));
    expectNearMiss(classifyReviewLoopNoise({ botKey: "known:strix", body: "No issues found. nit: rename x" }));
  });

  it("does NOT gate an unanchored 'review complete' that is followed by real feedback (reports near-miss)", () => {
    expectNearMiss(
      classifyReviewLoopNoise({ botKey: "known:greptile", body: "Greptile review complete. Minor: foo.ts" }),
    );
  });

  it("gates a lone 'Review complete.' from a known bot", () => {
    expect(classifyReviewLoopNoise({ botKey: "known:greptile", body: "Review complete." })).toEqual({
      gated: true,
      reason: "no_findings",
    });
  });

  it("tolerates markdown/HTML wrapping around a no-findings phrase", () => {
    expect(
      classifyReviewLoopNoise({ botKey: "known:strix", body: "<p><strong>No issues found</strong> ✅</p>" }),
    ).toEqual({ gated: true, reason: "no_findings" });
  });

  // ── real bot comment FOOTERS (links/attribution/timestamp) must not defeat the gate ──────────
  // Regression for the prod exhibit that shipped un-gated: the D4 unit tests fed a stripped body,
  // but the real Strix comment carries a `<sub>` footer + a "Reviewed by [Strix](url)" attribution
  // line whose URLs/UUIDs/commit-sha survived the residual strip (158 residual chars → fail-open).
  it("gates the REAL Strix 'no security issues found' comment including its footer", () => {
    const realStrixBody = [
      "<!-- strix-pr-review:master -->",
      "## Strix Security Review",
      "",
      "No security issues found.",
      "",
      "<sub>Updated for `b569221`.</sub>",
      "",
      "---",
      "*Reviewed by [Strix](https://strix.ai)*",
      "<sub>[Re-run review](https://app.strix.ai/api/pr-reviews/rerun?review_id=f1a6221c-5f19-47e5-a476-854ca0761e73) · [Configure security review settings](https://app.strix.ai/repositories/5981f357-ede7-478d-9267-e13c4988f700)</sub>",
    ].join("\n");
    expect(classifyReviewLoopNoise({ botKey: "known:strix", body: realStrixBody })).toEqual({
      gated: true,
      reason: "no_findings",
    });
  });

  it("gates a no-findings body whose footer attribution is NOT wrapped in <sub>", () => {
    const body = [
      "No issues found.",
      "",
      "---",
      "Reviewed by Greptile · Updated for `abc1234` · https://greptile.com",
    ].join("\n");
    expect(classifyReviewLoopNoise({ botKey: "known:greptile", body })).toEqual({
      gated: true,
      reason: "no_findings",
    });
  });

  it("does NOT strip an all-letter word that merely looks hex (no digit) — fail-open (reports near-miss)", () => {
    // The commit-sha strip requires a digit so a real all-letter word survives as residual.
    expectNearMiss(classifyReviewLoopNoise({ botKey: "known:strix", body: "No issues found. defaced" }));
  });

  it("still does NOT gate a footer'd no-findings comment that carries real feedback (reports near-miss)", () => {
    // Stripping footer chrome must not swallow an actual finding embedded above the footer.
    const body = [
      "## Strix Security Review",
      "",
      "No security issues found, but sanitize the path in fileHandler.ts.",
      "",
      "<sub>Updated for `b569221`.</sub>",
      "*Reviewed by [Strix](https://strix.ai)*",
    ].join("\n");
    expectNearMiss(classifyReviewLoopNoise({ botKey: "known:strix", body }));
  });

  // ── near-miss telemetry contract ─────────────────────────────────────────────────────────────
  it("reports a near-miss with a small residualLength for an un-strippable footer (would-be noise)", () => {
    // A known bot's no-findings comment whose footer chrome we can't fully strip is forwarded, but the
    // residual is small (footer-sized) — the signal that this was a likely miss the regex couldn't gate.
    const verdict = classifyReviewLoopNoise({
      botKey: "known:greptile",
      body: "No issues found. Powered by Acme Review Engine v2.",
    });
    expect(verdict.gated).toBe(false);
    const nearMiss = verdict.gated === false ? verdict.nearMiss : undefined;
    expect(nearMiss?.residualLength).toBeGreaterThan(0);
    expect(nearMiss?.residualLength).toBeLessThan(40);
  });

  it("does NOT report a near-miss for a GATED body", () => {
    const verdict = classifyReviewLoopNoise({ botKey: "known:strix", body: "No security issues found." });
    expect(verdict).toEqual({ gated: true, reason: "no_findings" });
    expect(verdict.gated === false ? verdict.nearMiss : "n/a").toBe("n/a");
  });

  it("does NOT report a near-miss when no no-findings phrase matched (not a candidate)", () => {
    // A real-findings comment or a non-known bot is not a near-miss — only phrase-matched-but-forwarded is.
    expect(classifyReviewLoopNoise({ botKey: "known:strix", body: "Please rebase onto main." })).toEqual({
      gated: false,
    });
    expect(classifyReviewLoopNoise({ botKey: "custom:some-bot", body: "No issues found." })).toEqual({ gated: false });
  });

  // ── in-progress / placeholder bot comments are GATED ─────────────────────────────────────────
  // A "still working" placeholder is exactly as unactionable as a "no findings" message: it can never
  // produce completion evidence, so it must never be dispatched to the agent. The prod exhibit: Strix
  // posts ONE mutable comment that starts as "Security review in progress." (later edited in place with
  // the real findings); the no-findings-only gate forwarded the placeholder to the RLA (PR #7112).
  it("gates the prod exhibit — Strix 'Security review in progress.' placeholder", () => {
    const verdict = classifyReviewLoopNoise({ botKey: "known:strix", body: "Security review in progress." });
    expect(verdict).toEqual({ gated: true, reason: "in_progress" });
  });

  it("gates the REAL Strix in-progress placeholder including its footer (prod PR #7112)", () => {
    const realStrixInProgress = [
      "<!-- strix-pr-review:master -->",
      "## Strix Security Review",
      "",
      "Security review in progress.",
      "",
      "<sub>Updated for `9c9371f`.</sub>",
      "",
      "---",
      "*Reviewed by [Strix](https://strix.ai)*",
      "<sub>[Configure security review settings](https://app.strix.ai/repositories/5981f357-ede7-478d-9267-e13c4988f700)</sub>",
    ].join("\n");
    expect(classifyReviewLoopNoise({ botKey: "known:strix", body: realStrixInProgress })).toEqual({
      gated: true,
      reason: "in_progress",
    });
  });

  it.each([
    ["known:strix", "Review in progress"],
    ["known:greptile", "Analysis in progress…"],
    ["known:coderabbit", "Review in progress."],
    ["known:strix", "Security scan running."],
    ["known:greptile", "Review started."],
  ])("gates a known-bot in-progress placeholder (%s)", (botKey, body) => {
    expect(classifyReviewLoopNoise({ botKey, body })).toEqual({ gated: true, reason: "in_progress" });
  });

  // ── in-progress + real feedback / non-known author are NOT gated (fail-open) ──────────────────
  it("does NOT gate an in-progress phrase that carries real feedback (reports near-miss)", () => {
    expectNearMiss(
      classifyReviewLoopNoise({
        botKey: "known:strix",
        body: "Security review in progress, but the auth check in login.ts already validates the wrong field — fix the token expiry.",
      }),
    );
  });

  it("does NOT gate a custom/unknown bot with an in-progress body", () => {
    expect(classifyReviewLoopNoise({ botKey: "custom:some-bot", body: "Review in progress." })).toEqual({
      gated: false,
    });
    expect(classifyReviewLoopNoise({ botKey: null, body: "Review in progress." })).toEqual({ gated: false });
  });

  it("never gates the QA verifier key (a QA verdict is never no-findings noise) (A4)", () => {
    // known:cycloid-qa is not a user-configurable known-bot id, so knownBotIdFromKey returns null →
    // NOT_GATED. Even a body that trips a no-findings phrase must survive: an app_breaks verdict is real work.
    expect(classifyReviewLoopNoise({ botKey: "known:cycloid-qa", body: "No issues found." })).toEqual({
      gated: false,
    });
    expect(classifyReviewLoopNoise({ botKey: "known:cycloid-qa", body: "## Cycloid QA\n\nThe app breaks." })).toEqual({
      gated: false,
    });
  });
});
