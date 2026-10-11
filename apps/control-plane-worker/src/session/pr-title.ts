const CYCLOID_PR_TITLE_PREFIX_RE = /^\[ARC\]\s*/;

/** Fallback title used when a session/proposed title has no usable content. */
export const DEFAULT_SESSION_PR_TITLE = "Changes from Cycloid";

/** GitHub caps issue/PR titles at 256 characters. */
export const MAX_PR_TITLE_LENGTH = 256;

export function normalizeSessionPrTitle(title: string): string {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) return DEFAULT_SESSION_PR_TITLE;
  return trimmedTitle.replace(CYCLOID_PR_TITLE_PREFIX_RE, "").trim() || DEFAULT_SESSION_PR_TITLE;
}

/**
 * Prefix a PR title with a ticket key in the bare `KEY description` form that
 * ticket-prefix title checks require (e.g. `ENG-9001 Fix the dashboard`).
 *
 * Idempotent and self-normalizing: any standalone occurrence of the key — at the
 * start OR mid-string (extraction may find a key mid-sentence), in any case, with
 * a `:`, whitespace, or spaced-`-` separator — is removed before the canonical
 * `KEY ` form is prepended, so the key is never doubled (`work on ENG-9001` →
 * `ENG-9001 work on`, not `ENG-9001 work on ENG-9001`). Returns the title
 * unchanged when `key` is null; a title that is only the key falls back to the
 * default description; the result is clamped to GitHub's title length limit.
 */
export function applyTicketKeyPrefix(title: string, key: string | null): string {
  if (!key) return title;
  // Validated keys carry no regex metacharacters, but escape defensively so the
  // safety of this dynamic regex does not silently depend on the key shape.
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Strip every standalone occurrence of the key plus a trailing `:`/space or
  // spaced-`-` separator. The `-` must be space-flanked so a `KEY-qualifier`
  // token (e.g. `ENG-9001-rc1`) is not silently eaten — its hyphen survives the
  // strip and is then cleaned off the front below (`ENG-9001-rc1` -> `rc1`).
  const occurrence = new RegExp(`\\b${escaped}\\b(?:\\s*:\\s*|\\s+-\\s+|\\s+)?`, "gi");
  const description = title
    .trim()
    .replace(occurrence, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Drop a leading separator fragment left when the key abutted a `-qualifier`
    // or a markdown bullet, so the description doesn't start with `-`/`:`.
    .replace(/^[-:\s]+/, "");
  const prefixed = description ? `${key} ${description}` : `${key} ${DEFAULT_SESSION_PR_TITLE}`;
  return prefixed.length > MAX_PR_TITLE_LENGTH ? prefixed.slice(0, MAX_PR_TITLE_LENGTH).trimEnd() : prefixed;
}

export type ValidatedProposedPrTitle = { ok: true; title: string } | { ok: false; error: string };

/**
 * Validate an agent-proposed PR title before it reaches GitHub.
 *
 * Order matters: strip control characters, collapse whitespace, trim, then
 * reject empty / over-length input BEFORE normalization. `normalizeSessionPrTitle`
 * maps empty and `[ARC]`-prefix-only input to `DEFAULT_SESSION_PR_TITLE`, so
 * normalizing first would silently turn a bad title into the fallback instead of
 * rejecting it.
 */
export function validateProposedPrTitle(raw: unknown): ValidatedProposedPrTitle {
  if (typeof raw !== "string") {
    return { ok: false, error: "PR title must be a string." };
  }
  // Control chars (incl. newlines/tabs) collapse to spaces; runs of whitespace fold to one.
  const stripped = raw
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) {
    return { ok: false, error: "PR title must not be empty." };
  }
  if (stripped.length > MAX_PR_TITLE_LENGTH) {
    return { ok: false, error: `PR title must not exceed ${MAX_PR_TITLE_LENGTH} characters.` };
  }
  // Reject only when stripping the `[ARC]` prefix leaves no content at all
  // (e.g. `[ARC]` on its own). A real title that merely carries the prefix,
  // including `[ARC] Changes from Cycloid`, keeps its content and is valid.
  const withoutPrefix = stripped.replace(CYCLOID_PR_TITLE_PREFIX_RE, "").trim();
  if (!withoutPrefix) {
    return { ok: false, error: "PR title must contain content beyond the Cycloid prefix." };
  }
  return { ok: true, title: normalizeSessionPrTitle(stripped) };
}

export type PrTitleReconcileAction =
  | { kind: "adopt_baseline"; baseline: string }
  | { kind: "skip_manual_rename" }
  | { kind: "apply"; title: string }
  | { kind: "noop" };

/**
 * Decide how a republish should reconcile the resolved PR title against the
 * live GitHub title, honoring "human rename wins". Pure decision; the caller
 * performs the GitHub PATCH and persists the new baseline.
 *
 * - `lastApplied == null` (legacy/untracked PR): adopt the live title as the
 *   baseline and change nothing this publish.
 * - live title already equals the resolved title (regardless of the baseline):
 *   adopt it as the baseline and change nothing. This self-heals a stale
 *   baseline left by a crash between a successful title PATCH and its
 *   `pr_title_last_applied` persist — without it, the live title (== resolved)
 *   would forever read as a "human rename" and freeze all future updates. It is
 *   also harmless when a human happened to rename to the resolved title, since
 *   the outcome is identical.
 * - live title diverged from what Cycloid last applied: a human renamed it to
 *   something else, so skip.
 * - tracked and unchanged by humans: apply the resolved title only when it
 *   actually differs from the live title.
 */
export function decidePrTitleReconcileAction(
  liveTitle: string,
  lastApplied: string | null,
  resolvedTitle: string,
): PrTitleReconcileAction {
  if (lastApplied == null) return { kind: "adopt_baseline", baseline: liveTitle };
  if (liveTitle === resolvedTitle) {
    // Already what we'd apply. Sync the baseline (self-heal) and do not PATCH.
    return liveTitle === lastApplied ? { kind: "noop" } : { kind: "adopt_baseline", baseline: liveTitle };
  }
  if (liveTitle !== lastApplied) return { kind: "skip_manual_rename" };
  return { kind: "apply", title: resolvedTitle };
}
