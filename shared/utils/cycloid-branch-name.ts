import { parseLeadingSkillCommands } from "../skills/index.js";

const DEFAULT_BRANCH_SLUG = "session-work";
const MAX_BRANCH_SLUG_LENGTH = 48;
const SESSION_SUFFIX_LENGTH = 12;
export const COLLISION_SUFFIX_LENGTH = 4;
const MIN_WORD_BOUNDARY_TRUNCATED_SLUG_LENGTH = 24;
const MIN_HIGH_ENTROPY_SEGMENT_LENGTH = 8;

const SENSITIVE_HINT_PATTERN =
  /\b(?:api[-_\s]?key|auth|bearer|credential|customer|database\s+url|db\s+url|email|incident|password|prod(?:uction)?\s+url|secret|token)\b/i;
const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/\S+|www\.\S+/gi;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const LONG_OPAQUE_TOKEN_PATTERN = /\b[a-z0-9_-]{16,}\b/gi;
const CONVERSATIONAL_PREFIX_PATTERN =
  /^(?:please|pls|can\s+you|could\s+you|would\s+you|hey|hi|help\s+me|i\s+want\s+to|i'd\s+like\s+to|we\s+need\s+to|let's|lets|go\s+ahead\s+and|implement\s+(?:linear\s+)?ticket|make(?:\s+the)?|just)\b[\s,.:;-]*/i;
const TRAILING_POLITENESS_PATTERN = /[\s,.:;-]*\bfor\s+me\b[\s,.:;-]*$/i;

export function buildCycloidBranchBaseNameFromSafeHint(safeHint?: string): string {
  const slug = sanitizeBranchSlug(safeHint, MAX_BRANCH_SLUG_LENGTH) || DEFAULT_BRANCH_SLUG;
  return slug;
}

export function buildCycloidBranchDisambiguator(sessionId: string): string {
  return buildSessionSuffix(sessionId) || "session";
}

export function buildCycloidBranchCollisionSuffix(sessionId: string, salt = 0): string {
  const hash = hashBranchSuffixInput(`${sessionId}:${salt}`);
  return hash.toString(16).padStart(8, "0").slice(0, COLLISION_SUFFIX_LENGTH);
}

export function appendCollisionSuffix(base: string, suffix: string): string {
  const suffixSlug = sanitizeBranchSlug(suffix, COLLISION_SUFFIX_LENGTH);
  const baseBudget = Math.max(0, MAX_BRANCH_SLUG_LENGTH - suffixSlug.length - 1);
  const baseSlug = sanitizeBranchSlug(base, baseBudget);
  if (!suffixSlug) return baseSlug || DEFAULT_BRANCH_SLUG;
  if (!baseSlug) return suffixSlug;
  return `${baseSlug}-${suffixSlug}`;
}

/**
 * Prepend an already-validated, lowercased ticket key to a sanitized branch hint
 * so Linear auto-links the PR by branch name (e.g. `arc-746-fix-the-thing`). This
 * is the toggle-independent linking lever; the bridge later appends its own
 * collision suffix, so the slug budget here is the full {@link MAX_BRANCH_SLUG_LENGTH}.
 *
 * The caller owns ticket-key validation (control-plane `ticket-key.ts`); `shared/`
 * must not import app code, so this helper does NOT shape-check the key. Pass a
 * lowercased, shape-valid key.
 *
 * Behavior:
 * - empty/falsy key -> returns the sanitized hint unchanged (no prefix).
 * - hint already begins with the key segment -> no double-prefix.
 * - the key is preserved when clamping; the concept tail is what gets truncated.
 */
export function prependTicketKeyToBranchHint(key: string | undefined, safeHint: string | undefined): string {
  const keySlug = sanitizeBranchSlug(key);
  const hintSlug = sanitizeBranchSlug(safeHint);
  if (!keySlug) return hintSlug;
  if (!hintSlug) return keySlug.slice(0, MAX_BRANCH_SLUG_LENGTH).replace(/-+$/g, "");

  const dedupedHintSlug = removeTicketKeySlugSegments(hintSlug, keySlug);
  if (!dedupedHintSlug) return keySlug.slice(0, MAX_BRANCH_SLUG_LENGTH).replace(/-+$/g, "");

  // sanitizeBranchSlug truncates the END, so the leading key survives and only the
  // concept tail is dropped when the combined slug exceeds the max length.
  return sanitizeBranchSlug(`${keySlug}-${dedupedHintSlug}`, MAX_BRANCH_SLUG_LENGTH);
}

function removeTicketKeySlugSegments(hintSlug: string, keySlug: string): string {
  const keySegments = keySlug.split("-").filter(Boolean);
  if (keySegments.length === 0) return hintSlug;

  const hintSegments = hintSlug.split("-").filter(Boolean);
  const dedupedSegments: string[] = [];
  for (let index = 0; index < hintSegments.length;) {
    const matchesKey = keySegments.every((segment, offset) => hintSegments[index + offset] === segment);
    if (matchesKey) {
      index += keySegments.length;
      continue;
    }
    dedupedSegments.push(hintSegments[index]);
    index += 1;
  }

  return dedupedSegments.join("-");
}

export function buildSafeCycloidBranchHint(value: string | undefined): string {
  if (!value) return "";

  const taskText = parseLeadingSkillCommands(value).prompt.trim();
  if (!taskText || SENSITIVE_HINT_PATTERN.test(taskText)) return "";

  const redactedTaskText = redactUnsafeBranchHintSegments(taskText).trim();
  if (!redactedTaskText) return "";

  const strippedTaskText = stripConversationalFiller(redactedTaskText);
  if (!strippedTaskText || SENSITIVE_HINT_PATTERN.test(strippedTaskText)) return "";

  const redacted = redactUnsafeBranchHintSegments(strippedTaskText);

  return sanitizeBranchSlug(redacted, MAX_BRANCH_SLUG_LENGTH);
}

function redactUnsafeBranchHintSegments(value: string): string {
  return value
    .replace(URL_PATTERN, " ")
    .replace(EMAIL_PATTERN, " ")
    .replace(UUID_PATTERN, " ")
    .replace(LONG_OPAQUE_TOKEN_PATTERN, " ");
}

function stripConversationalFiller(value: string): string {
  let stripped = value.trim();
  let previous: string;
  do {
    previous = stripped;
    stripped = stripped.replace(CONVERSATIONAL_PREFIX_PATTERN, "").replace(TRAILING_POLITENESS_PATTERN, "").trim();
  } while (stripped && stripped !== previous);

  return stripped || value.trim();
}

export function sanitizeBranchSlug(value: string | undefined, maxLength = MAX_BRANCH_SLUG_LENGTH): string {
  if (!value) return "";

  const sanitized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (sanitized.length <= maxLength) return sanitized;

  const truncated = sanitized.slice(0, maxLength).replace(/-+$/g, "");
  if (sanitized.charAt(maxLength) === "-") return truncated;

  const lastBoundaryIndex = truncated.lastIndexOf("-");
  if (lastBoundaryIndex === -1) return truncated;

  const wordBoundaryTruncated = truncated.slice(0, lastBoundaryIndex).replace(/-+$/g, "");
  if (wordBoundaryTruncated.length < MIN_WORD_BOUNDARY_TRUNCATED_SLUG_LENGTH) return truncated;

  return wordBoundaryTruncated;
}

function buildSessionSuffix(sessionId: string): string {
  const sanitized = sanitizeBranchSlug(sessionId, Math.max(sessionId.length * 2, SESSION_SUFFIX_LENGTH));
  const segments = sanitized.split("-").filter(Boolean);
  const lastSegment = segments.length > 0 ? segments[segments.length - 1] : "";
  if (lastSegment.length >= MIN_HIGH_ENTROPY_SEGMENT_LENGTH) {
    return lastSegment.slice(-SESSION_SUFFIX_LENGTH);
  }
  return sanitized.slice(-SESSION_SUFFIX_LENGTH);
}

function hashBranchSuffixInput(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
