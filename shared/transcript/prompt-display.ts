// Derives display-safe prompt text for the session/transcript view.
//
// Slack-, GitHub-, and Linear-triggered prompts are wrapped with agent-facing
// scaffolding before being sent to the model: `<user_content>` blocks, the
// "untrusted user input" guardrail, "Previous Slack message", "Current Slack
// message author:", "Repository:", issue-section labels, etc. (see
// `shared/utils/prompt-safety.ts` and `apps/control-plane-worker/src/webhooks/prompts.ts`).
//
// The clean user text is normally carried in `replyToText`, but prompts stored
// before that wiring (or via a path that fell back to the wrapped prompt) leak
// the full scaffolding into the UI. This helper guarantees a wrapper-free
// string for display: it prefers a clean `replyToText`, and otherwise recovers
// the user's text by stripping the known scaffolding from the raw prompt.

// Multi-line `<user_content>` / `<instruction_content>` blocks (and their inner
// quoted context). The backreference keeps open/close tags matched.
const WRAPPED_CONTENT_BLOCK_RE = /<(user_content|instruction_content)\b[^>]*>[\s\S]*?<\/\1>/gi;

// Whole lines that are pure scaffolding and never part of the user's message.
// Patterns are intentionally specific (e.g. the full guardrail sentence) so a
// user message that merely starts a line with "IMPORTANT:" is not stripped.
const SCAFFOLDING_LINE_PATTERNS: RegExp[] = [
  /^IMPORTANT: The content above is /i,
  /^Previous Slack message\b/i,
  /^Current Slack message author:/i,
  /^Thread context(?:\s*\([^)]*\))?\s*[.:]/i,
  // Synthetic bootstrap prefix only: a single-token repo URL/ref value. A
  // user's prose line like "Repository: our monorepo is huge" has spaces and
  // is left intact.
  /^Repository:\s+\S+$/i,
  /^Issue (?:title|body|description|metadata)\s*:/i,
  /^Triggering comment\s*:/i,
  /^Review body\s*:/i,
  /^Recent comments\s*:/i,
  /^<\/?(?:user_content|instruction_content)\b/i,
];

// Markers whose presence means the text is wrapped scaffolding rather than a
// raw user message.
const SCAFFOLDING_MARKERS: RegExp[] = [
  /<\/?(?:user_content|instruction_content)\b/i,
  /^IMPORTANT: The content above is /im,
  /^Previous Slack message\b/im,
  /^Current Slack message author:/im,
  /^Repository:\s+\S+$/im,
  /^\[cycloid:review-loop\b/im,
];

export function promptContainsScaffolding(text: string): boolean {
  return SCAFFOLDING_MARKERS.some((pattern) => pattern.test(text));
}

export function stripPromptScaffolding(text: string): string {
  const withoutBlocks = text.replace(WRAPPED_CONTENT_BLOCK_RE, "");
  const kept = withoutBlocks
    .split(/\r?\n/)
    .filter((line) => !SCAFFOLDING_LINE_PATTERNS.some((pattern) => pattern.test(line.trim())));
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function derivePromptDisplayText(prompt: { prompt: string; replyToText?: string | null }): string {
  // Review-loop prompts (`[cycloid:review-loop epoch=…]`) are fully-structured, system-generated
  // agent directives whose footer is agent-only machinery — never human-facing. Prefer the clean
  // human summary stored on the turn at enqueue. Fall back to verbatim only for legacy turns
  // enqueued before summaries existed, where `replyToText` was defaulted to the full agent prompt
  // (state.ts `replyToText ?? prompt`); those cannot be run through the scaffolding stripper, which
  // would gut their action items and `Repository:` line, so they are displayed verbatim.
  if (prompt.prompt.trimStart().startsWith("[cycloid:review-loop")) {
    const reply = prompt.replyToText?.trim();
    if (reply && reply !== prompt.prompt.trim() && !promptContainsScaffolding(reply)) return reply;
    return prompt.prompt.trim();
  }

  const reply = prompt.replyToText?.trim();
  if (reply && !promptContainsScaffolding(reply)) return reply;

  // Only strip when the prompt actually carries scaffolding, so a plain
  // multi-line prompt whose line happens to match a scaffolding prefix is
  // never partially dropped.
  if (promptContainsScaffolding(prompt.prompt)) {
    const recovered = stripPromptScaffolding(prompt.prompt);
    if (recovered) return recovered;
  }

  // Nothing recoverable: prefer a present replyToText over the raw prompt.
  return reply || prompt.prompt.trim();
}

// For consumers that fed the RAW prompt to an LLM/analyzer (memory ingestion, Slack narration) and
// only need review-loop turns rewritten to their footer-free human summary: transform review-loop
// turns via `derivePromptDisplayText`, but return every other prompt byte-identical. Running a
// non-review-loop bootstrap prompt through the full deriver would hand it to `stripPromptScaffolding`
// (its `replyToText` defaults to the raw wrapped prompt on bootstrap, so it is not preferred), which
// deletes the `<user_content>` body where the real ticket/webhook text lives — degrading the analyzer
// input. Marker-gating keeps the review-loop footer out of those LLMs without touching anything else.
export function deriveReviewLoopSummaryOrRaw(prompt: { prompt: string; replyToText?: string | null }): string {
  if (!prompt.prompt.trimStart().startsWith("[cycloid:review-loop")) return prompt.prompt;
  return derivePromptDisplayText(prompt);
}
