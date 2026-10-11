import { deriveFirstLineTitle } from "../constants/sessions";
import { type MarkdownFence, nextMarkdownFence } from "./markdown-fence.js";

const PROMPT_METADATA_LINE_PATTERNS = [
  /^Repository:/i,
  /^Head SHA:/i,
  /^Base Branch:/i,
  /^verify\s*=\s*(?:true|false)$/i,
  /^\[cycloid:review-loop\b/i,
  /^Review-loop (?:worklist|action items)\s*:/i,
  /^Linear Issue:/i,
  /^GitHub Issue:/i,
  /^Issue URL:/i,
  /^Issue title\s*:/i,
  /^Issue body\s*:/i,
  /^Issue description\s*:/i,
  /^Issue metadata\s*:/i,
  /^Recent comments\s*:/i,
  /^Triggering comment\s*:/i,
  /^Thread context(?:\s*\([^)]*\))?\s*[.:]/i,
  /^<\/?user_content\b/i,
] as const;

function cleanPromptTitleLine(line: string): string {
  return line.replace(/^[-*]\s+/, "").replace(/^\[[ xX]\]\s+/, "");
}

export function isPromptMetadataLine(line: string): boolean {
  return PROMPT_METADATA_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

export function derivePromptTitleCandidate(promptText: string): string | null {
  let fence: MarkdownFence | null = null;
  for (const rawLine of promptText.split(/\r?\n/)) {
    // Skip fenced code blocks: pasted code, error logs, or docs must not seed the
    // title with a fence marker (```typescript) or a line from inside the block.
    const nextFence = nextMarkdownFence(fence, rawLine);
    if (fence || nextFence) {
      fence = nextFence;
      continue;
    }
    const line = rawLine.trim();
    if (!line) continue;
    const cleanedLine = cleanPromptTitleLine(line);
    if (isPromptMetadataLine(cleanedLine)) continue;
    const title = deriveFirstLineTitle(cleanedLine);
    if (title) return title;
  }
  return null;
}

// A Linear/Jira ticket key (e.g. `ENG-9001`, `A1-123`) at the very start of a line.
// The prefix class mirrors TICKET_KEY_SHAPE (`[A-Z][A-Z0-9]*`) so alphanumeric project
// keys are recognized consistently with the Linear URL extractor; the leading anchor
// keeps this a thin fallback. The intent-aware judgement (mid-sentence keys, ignoring
// referenced tickets and look-alikes like `UTF-8`) is the LLM's job. Case-sensitive
// because ticket keys are uppercase and the title checks that consume the prefix are too.
const LEADING_TICKET_KEY_PATTERN = /^([A-Z][A-Z0-9]*-\d+)\b/;

/**
 * Deterministic fallback ticket-key extractor: returns a key only when it LEADS
 * the first non-metadata content line of the prompt (e.g. `ENG-9001: fix x`).
 * This is the outage-safe path behind the LLM extraction — it intentionally does
 * not hunt mid-sentence keys or filter acronym look-alikes; the LLM handles those.
 */
export function extractLeadingTicketKey(promptText: string): string | null {
  let fence: MarkdownFence | null = null;
  for (const rawLine of promptText.split(/\r?\n/)) {
    // Skip fenced code blocks so a leading pasted-code block does not shadow a
    // real ticket key that leads the first prose line after it.
    const nextFence = nextMarkdownFence(fence, rawLine);
    if (fence || nextFence) {
      fence = nextFence;
      continue;
    }
    const line = rawLine.trim();
    if (!line) continue;
    const cleanedLine = cleanPromptTitleLine(line);
    if (isPromptMetadataLine(cleanedLine)) continue;
    const match = cleanedLine.match(LEADING_TICKET_KEY_PATTERN);
    return match ? match[1] : null;
  }
  return null;
}
