// Review-loop NOISE GATE (D4, per-review-triage design). A pure classifier that recognizes a known
// review bot's purely-informational message — either "no findings" OR a "still in progress" placeholder —
// so the worklist builder can drop it BEFORE it becomes an agent prompt (an unactionable item can never
// produce completion evidence). Two prod exhibits: Strix "no security issues found" was prompted 4×, and
// Strix's "Security review in progress." placeholder (posted on ONE mutable comment it later edits in
// place with the real findings) was dispatched to the RLA as if it were feedback (PR #7112).
//
// FAIL-OPEN is the load-bearing rule: a false "noise" classification silently drops real customer
// feedback (far worse than one wasted prompt), so we gate ONLY when we are confident:
//   1. The author is a KNOWN review bot (custom bots and humans are never gated).
//   2. A no-findings OR in-progress phrase matched AND, after stripping that phrase + boilerplate/filler,
//      NOTHING remains — any leftover content word (a real note appended to a placeholder line, e.g.
//      "No issues found, but fix the null check") keeps the item.
//
// Pure over its inputs (no GitHub/DB), so it is fully unit-testable — the same discipline as
// `classifyReviewActionable` (session/fsm/review-producer.ts).

import { PR_REVIEW_KNOWN_BOT_ID_SET, type PrReviewKnownBotId } from "../../../../shared/constants/pr-review-bots.js";

/** The reason a bot output was gated — a BOUNDED enum safe for a Datadog metric `group_by`. */
export type ReviewLoopNoiseReason = "no_findings" | "in_progress";

export interface ReviewLoopNoiseInput {
  /** The matched bot's stable key from `matchReviewLoopBot` (`known:<id>` | `custom:<login>`), or null. */
  botKey: string | null | undefined;
  /** The comment/review body as posted (raw). */
  body: string | null | undefined;
}

/**
 * A NEAR MISS: a known bot whose body matched a no-findings phrase but was NOT gated because residual
 * content survived the strip, so it is still forwarded (fail-open). Surfaced for telemetry only — it lets
 * us size how often the deterministic residual heuristic can't finish the job (the input that decides
 * whether a semantic/LLM tie-breaker is worth adding). `residualLength` separates a likely footer-chrome
 * miss (small) from a genuinely-appended real finding (large).
 */
export interface ReviewLoopNoiseNearMiss {
  residualLength: number;
}

export type ReviewLoopNoiseVerdict =
  { gated: true; reason: ReviewLoopNoiseReason } | { gated: false; nearMiss?: ReviewLoopNoiseNearMiss };

const NOT_GATED: ReviewLoopNoiseVerdict = { gated: false };

/**
 * The residual alphanumeric content that may remain after a no-findings phrase + boilerplate/filler is
 * stripped and we still treat the body as pure noise: NONE. Any leftover content word (e.g. the "fix the
 * null check" in "No issues found, but fix the null check") keeps the item — the fail-open contract. Real
 * bot no-findings outputs strip to empty via the phrase patterns + the boilerplate/filler set + footer
 * stripping (see `toPlainText` for `<sub>`/URL removal and `HEX_IDENTIFIER_RE` for sha/uuid tokens) — the
 * un-stripped footer (links, "Reviewed by <bot>", "Updated for <sha>") is exactly what shipped un-gated.
 */
const NOISE_RESIDUAL_MAX = 0;

/**
 * Known-bot no-findings phrasings (lowercased plain text; no flags — the input is pre-lowercased). Tight
 * on purpose: each must read as "this bot found nothing." The residual check below is the real guard
 * against gating a body that pairs one of these with actual feedback.
 */
const NO_FINDINGS_PATTERNS: readonly RegExp[] = [
  // "no security issues found" (the exhibit), "no issues", "no vulnerabilities detected", etc.
  /no (?:security |critical |major |significant |new )?(?:issues?|problems?|bugs?|vulnerabilit(?:y|ies)|findings?|concerns?|errors?)(?: were| have been)?(?: found| detected| identified| observed| noted| flagged)?/,
  /no actionable (?:comments?|items?|findings?|feedback)/,
  /actionable comments? posted:?\s*0/,
  /(?:found )?nothing (?:to (?:flag|report|address|fix)|of concern)/,
  /no changes? (?:requested|needed|required|suggested)/,
  // Anchored on word boundaries so it matches the phrase itself, not "review complete" embedded in a
  // longer sentence; the empty-residual guard is the real protection, this is defense-in-depth.
  /\breview complete[d]?\b/,
  /no comments\b/,
  /looks good(?: to me)?/,
  /^lgtm$/,
];

/**
 * Known-bot "still working" placeholder phrasings (lowercased plain text; no flags). A bot that posts a
 * not-done-yet placeholder — Strix posts ONE mutable comment that begins "Security review in progress." and
 * is edited in place once the review finishes — is exactly as unactionable as a no-findings message. Tight
 * on purpose and, like NO_FINDINGS_PATTERNS, backstopped by the empty-residual guard: an in-progress line
 * that also carries real feedback ("...in progress, but fix the auth check") survives with residual and is
 * forwarded. Each alternative self-consumes to empty against the boilerplate set (`review`/`security`/
 * `scan`/`analysis` are already stripped there); `in progress` covers the "<noun> in progress" family.
 */
const IN_PROGRESS_PATTERNS: readonly RegExp[] = [
  /\bin progress\b/,
  /\b(?:review(?:ing)?|analysis|analyzing|scan(?:ning)?|audit)\s+(?:is\s+|are\s+)?(?:currently\s+)?(?:started|running|underway|queued|pending)\b/,
];

/** Every noise phrase stripped before measuring the residual — a body is pure noise only if nothing but
 * a placeholder phrase (no-findings or in-progress) + boilerplate/filler remains. */
const NOISE_PHRASE_PATTERNS: readonly RegExp[] = [...NO_FINDINGS_PATTERNS, ...IN_PROGRESS_PATTERNS];

/**
 * Words removed before measuring the residual: bot names, generic review nouns, common stopwords, and
 * benign trailing acknowledgments (here/there/lgtm/ok) that carry no feedback. A content word NOT in
 * this set survives the strip and, with NOISE_RESIDUAL_MAX = 0, keeps the item (fail-open).
 */
const BOILERPLATE_RESIDUAL_RE =
  /\b(?:strix|greptile|coderabbit|cursor|bugbot|codex|chatgpt|review(?:ed)?|summary|security|scan(?:ned)?|analysis|complete[d]?|pr|this|the|in|for|of|a|an|is|was|were|been|have|has|no|here|there|lgtm|ok|okay|by|updated)\b/g;

/**
 * Commit-SHA / UUID-segment / hex identifiers that appear in bot footers (e.g. Strix's "Updated for
 * `b569221`"). They are never actionable prose, but survive `BOILERPLATE_RESIDUAL_RE` (which is a word
 * list) and so would keep an otherwise-empty body from gating. Requiring ≥7 chars AND ≥1 digit avoids
 * eating all-letter words that happen to be hex (e.g. "defaced") — a false strip risks a false gate,
 * so we fail toward keeping. Applied on the space-separated `plain` where token boundaries still exist.
 */
const HEX_IDENTIFIER_RE = /\b(?=[0-9a-f]*[0-9])[0-9a-f]{7,}\b/g;

function knownBotIdFromKey(botKey: string | null | undefined): PrReviewKnownBotId | null {
  if (!botKey || !botKey.startsWith("known:")) return null;
  const id = botKey.slice("known:".length);
  return PR_REVIEW_KNOWN_BOT_ID_SET.has(id) ? (id as PrReviewKnownBotId) : null;
}

/** Collapse markup/whitespace to a lowercased plain-text form for phrase matching. */
function toPlainText(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, " ") // html comments
    .replace(/<sub>[\s\S]*?<\/sub>/gi, " ") // <sub> footer metadata (timestamp / re-run / configure links)
    .replace(/<[^>]+>/g, " ") // html tags
    .replace(/https?:\/\/[^\s)]+/gi, " ") // urls (bare + markdown-link targets) — footer chrome, never feedback
    .replace(/[*_`>#~]/g, " ") // markdown emphasis / quote / heading / code markers
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Residual content after removing every noise phrase (no-findings + in-progress) + boilerplate. Small ⇒ pure noise. */
function noiseResidual(plain: string): string {
  let residual = plain;
  for (const pattern of NOISE_PHRASE_PATTERNS) {
    residual = residual.replace(new RegExp(pattern.source, "g"), " ");
  }
  residual = residual.replace(HEX_IDENTIFIER_RE, " ").replace(BOILERPLATE_RESIDUAL_RE, " ");
  return residual.replace(/[^a-z0-9]+/g, "").trim();
}

/**
 * Classify a bot output as gate-able noise. Returns `{ gated: false }` for anything uncertain —
 * unknown/custom bot, human author, or a body that carries residual content beyond a no-findings phrase.
 */
export function classifyReviewLoopNoise(input: ReviewLoopNoiseInput): ReviewLoopNoiseVerdict {
  const botId = knownBotIdFromKey(input.botKey);
  if (!botId) return NOT_GATED; // fail-open: only KNOWN review bots are ever gated.

  const plain = input.body ? toPlainText(input.body) : "";
  if (!plain) return NOT_GATED;

  // Text templates: require a no-findings OR in-progress phrase AND that nothing meaningful remains after
  // stripping it. no-findings takes reason precedence when both match (the more common, more specific case).
  const matchedNoFindings = NO_FINDINGS_PATTERNS.some((pattern) => pattern.test(plain));
  const matchedInProgress = IN_PROGRESS_PATTERNS.some((pattern) => pattern.test(plain));
  if (!matchedNoFindings && !matchedInProgress) return NOT_GATED;
  const residualLength = noiseResidual(plain).length;
  // A phrase matched but content survived → keep it (real feedback present), and record the residual as a
  // NEAR MISS so the telemetry can distinguish footer-chrome misses (small) from genuine appended findings
  // (large). This is the only not-gated path that is a candidate for a future tie-break.
  if (residualLength > NOISE_RESIDUAL_MAX) return { gated: false, nearMiss: { residualLength } };
  return { gated: true, reason: matchedNoFindings ? "no_findings" : "in_progress" };
}
