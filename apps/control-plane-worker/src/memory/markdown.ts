// Pure markdown parsing helpers for memory/convention operations.
// No side effects — these operate on strings only.

const FENCE_RE = /^(`{3,}|~{3,})/;
const HEADING_RE = /^(#+)\s+(.*)/;
const HEADING_PREFIX_RE = /^(#+)\s/;

/**
 * Insert content at the end of a markdown section (identified by heading text).
 * Returns null if the heading is not found — callers must handle the miss explicitly.
 * Skips lines inside fenced code blocks (``` / ~~~) when scanning for headings.
 */
export function insertIntoSection(fileContent: string, sectionHeading: string, newContent: string): string | null {
  const lines = fileContent.split("\n");
  const normalizedTarget = sectionHeading.trim().toLowerCase();

  let inFence = false;

  // Find the section heading (skip fenced code blocks)
  let headingIndex = -1;
  let headingLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = lines[i].match(HEADING_RE);
    if (match && match[2].trim().toLowerCase() === normalizedTarget) {
      headingIndex = i;
      headingLevel = match[1].length;
      break;
    }
  }

  if (headingIndex === -1) {
    return null; // Heading not found — caller decides how to handle
  }

  // Find the end of this section (next heading at same or higher level, skip fences)
  inFence = false;
  let insertIndex = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = lines[i].match(HEADING_PREFIX_RE);
    if (match && match[1].length <= headingLevel) {
      insertIndex = i;
      break;
    }
  }

  // Remove trailing blank lines before the insertion point
  const before = lines.slice(0, insertIndex);
  const after = lines.slice(insertIndex);
  while (before.length > 0 && before[before.length - 1].trim() === "") {
    before.pop();
  }

  return [...before, "", newContent, "", ...after].join("\n");
}

/** Extract heading texts from markdown, skipping content inside fenced code blocks. */
export function extractMarkdownHeadings(content: string): string[] {
  const headings: string[] = [];
  let inFence = false;
  for (const line of content.split("\n")) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = line.match(HEADING_RE);
    if (match) {
      headings.push(match[2].trim());
    }
  }
  return headings;
}

/**
 * Extract a specific section's content from a markdown file.
 * Returns null if the heading is not found.
 */
export function extractSection(content: string, sectionHeading: string): string | null {
  const lines = content.split("\n");
  const normalizedTarget = sectionHeading.trim().toLowerCase();

  let inFence = false;
  let headingIndex = -1;
  let headingLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = lines[i].match(HEADING_RE);
    if (match && match[2].trim().toLowerCase() === normalizedTarget) {
      headingIndex = i;
      headingLevel = match[1].length;
      break;
    }
  }

  if (headingIndex === -1) return null;

  // Find section end
  inFence = false;
  let endIndex = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = lines[i].match(HEADING_PREFIX_RE);
    if (match && match[1].length <= headingLevel) {
      endIndex = i;
      break;
    }
  }

  return lines.slice(headingIndex, endIndex).join("\n").trim();
}
