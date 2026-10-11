// Delimiter-aware markdown fenced-code-block state machine.
// Tracks the opening marker char and length so a fence closes only on the SAME
// marker (``` vs ~~~) with a run at least as long as the opener. A boolean
// `inFence` toggle over a shared regex is NOT equivalent: a `~~~` line would
// wrongly close a backtick fence, and a triple-backtick line would wrongly close
// a four-backtick fence. Line-leading fences only (a marker mid-line is ignored),
// matching CommonMark's fenced-code rules for the cases this repo parses.

export type MarkdownFence = {
  marker: "`" | "~";
  length: number;
};

/** The fence a line opens/closes, or null when the line is not a fence marker. */
export function markdownFenceForLine(line: string): MarkdownFence | null {
  const marker = line.trim().match(/^(`{3,}|~{3,})/)?.[1];
  if (!marker) return null;
  return { marker: marker[0] as "`" | "~", length: marker.length };
}

/**
 * Whether `line` is a valid CLOSING fence for the open `fence`. Per CommonMark a
 * closing fence must use the same marker char, be at least as long as the opener,
 * AND carry no info string — only optional trailing whitespace after the marker
 * run. So `` ```typescript `` or `~~~ts` appearing inside an already-open fence is
 * content (an info-string line cannot close a fence), not a close; only a bare
 * `` ``` ``/`~~~` run ends the block.
 */
function isClosingFenceLine(fence: MarkdownFence, line: string): boolean {
  const trimmed = line.trim();
  const run = trimmed.match(/^(`{3,}|~{3,})/)?.[1];
  if (!run || run[0] !== fence.marker || run.length < fence.length) return false;
  return trimmed.slice(run.length).trim().length === 0;
}

/**
 * Advance fence state for one line. Given the current open fence (or null) and a
 * line, returns the fence state after that line: opens a new fence on a marker
 * when none is open, closes (returns null) only on a valid closing fence (see
 * {@link isClosingFenceLine}), and otherwise leaves the state unchanged.
 */
export function nextMarkdownFence(fence: MarkdownFence | null, line: string): MarkdownFence | null {
  if (!fence) return markdownFenceForLine(line);
  return isClosingFenceLine(fence, line) ? null : fence;
}
