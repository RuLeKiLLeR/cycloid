export const MALFORMED_SEARCH_BLOCKED_TRANSCRIPT_PREFIX =
  "Cycloid blocked this malformed search command before execution.";

const BASH_UNMATCHED_QUOTE_EOF_RE =
  /\/bin\/bash:\s+-c:\s+line\s+\d+:\s+unexpected EOF while looking for matching [`'"][`'"]?/i;

export function isMalformedSearchBlockedError(value: unknown): boolean {
  return typeof value === "string" && value.includes(MALFORMED_SEARCH_BLOCKED_TRANSCRIPT_PREFIX);
}

export function containsMalformedSearchBashEof(value: string): boolean {
  return BASH_UNMATCHED_QUOTE_EOF_RE.test(value);
}

export function sanitizeMalformedSearchBlockedText(
  value: string,
  replacement = MALFORMED_SEARCH_BLOCKED_TRANSCRIPT_PREFIX,
): string {
  return containsMalformedSearchBashEof(value) ? replacement : value;
}
