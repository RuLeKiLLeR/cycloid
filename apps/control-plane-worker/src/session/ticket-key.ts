import type { PromptState } from "../types";
import { extractLeadingTicketKey } from "./prompt-text.js";

/**
 * Canonical shape of a Linear/Jira ticket key (e.g. `ENG-9001`): an uppercase
 * letter-led prefix, a hyphen, and digits. Single source of truth for "is this a
 * ticket key" across the title path — keep validators referencing this, not
 * ad-hoc regexes.
 */
export const TICKET_KEY_SHAPE = /^[A-Z][A-Z0-9]*-\d+$/;

/** A trimmed, shape-valid ticket key, or null. Case-sensitive: keys are uppercase. */
export function normalizeTicketKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && TICKET_KEY_SHAPE.test(trimmed) ? trimmed : null;
}

/**
 * Resolve the ticket key a session's PR title should carry, preferring the
 * intent-aware LLM extraction, then the deterministic signals that survive an
 * LLM outage:
 *   1. `llmTicketKey` — the platform-LLM's read of which ticket the task is FOR.
 *   2. `linearIdentifier` — the key the Linear integration parsed from a URL.
 *   3. a bare key leading the first line of P0 — the thin regex fallback.
 * Every source is shape-validated so a hallucinated/malformed value never lands
 * in a PR title.
 */
export function resolveSessionTicketKey(input: {
  llmTicketKey?: string | null;
  linearIdentifier?: string | null;
  prompts: PromptState[];
}): string | null {
  return (
    normalizeTicketKey(input.llmTicketKey) ??
    normalizeTicketKey(input.linearIdentifier) ??
    (input.prompts.length > 0 ? extractLeadingTicketKey(input.prompts[0].prompt) : null)
  );
}
