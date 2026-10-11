/**
 * Split combined `git diff` output into standalone per-file chunks keyed by
 * the changed file's current (b-side) path.
 *
 * Each chunk starts at its own `diff --git ` header so it remains a valid
 * input for `git apply -R`. Chunks are matched against the caller's known
 * file list rather than blindly parsed: a chunk maps to a file when its
 * header's b-side path (including quoted paths and rename targets) matches.
 * Chunks that match no known file are dropped, so callers can never act on
 * a file they did not ask about.
 */
export function splitGitDiffByFile(diffText: string, files: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (!diffText) return result;

  const chunks = diffText.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "));
  for (const chunk of chunks) {
    const file = matchChunkToFile(chunk, files);
    if (file && !result.has(file)) result.set(file, chunk);
  }
  return result;
}

function matchChunkToFile(chunk: string, files: string[]): string | null {
  const headerEnd = chunk.indexOf("\n");
  const header = headerEnd === -1 ? chunk : chunk.slice(0, headerEnd);
  const body = headerEnd === -1 ? "" : chunk.slice(headerEnd + 1);

  // Git octal-escapes and quotes paths with non-ASCII or control characters
  // (`... "b/docs/caf\303\251.md"`). Decode the quoted b-side so callers can
  // pass the real path.
  const decodedHeaderTarget = decodeQuotedBPath(header);

  for (const file of files) {
    // Plain header: `diff --git a/<old> b/<file>`. Matching the b-side suffix
    // covers same-path edits, deletions, and rename targets, including paths
    // with spaces (git leaves those unquoted in the header).
    if (header.endsWith(` b/${file}`)) return file;
    if (decodedHeaderTarget === file) return file;
  }

  // Fallback for headers the suffix check cannot disambiguate: explicit
  // rename-target or +++ lines in the chunk body.
  const decodedBodyTargets = new Set<string>();
  for (const line of body.split("\n")) {
    if (line.startsWith('+++ "') || line.startsWith('rename to "')) {
      const decoded = decodeQuotedBPath(line);
      if (decoded) decodedBodyTargets.add(decoded);
    }
  }
  for (const file of files) {
    if (body.includes(`\nrename to ${file}\n`) || body.includes(`\n+++ b/${file}\n`) || decodedBodyTargets.has(file)) {
      return file;
    }
  }
  return null;
}

/**
 * Extract and decode the trailing git-quoted path from a header-style line
 * (`diff --git "a/x" "b/y"`, `+++ "b/y"`, `rename to "y"`). Returns the
 * decoded path with any leading `b/` stripped, or null when the line does
 * not end in a quoted path.
 */
function decodeQuotedBPath(line: string): string | null {
  const match = line.match(/"((?:[^"\\]|\\.)*)"$/);
  if (!match) return null;
  const decoded = decodeGitEscapes(match[1]);
  return decoded.startsWith("b/") ? decoded.slice(2) : decoded;
}

const GIT_ESCAPE_MAP: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '"': 0x22,
  "\\": 0x5c,
};

function decodeGitEscapes(raw: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== "\\") {
      bytes.push(raw.charCodeAt(index));
      continue;
    }
    const next = raw[index + 1];
    if (next >= "0" && next <= "7") {
      let length = 1;
      while (length < 3 && raw[index + 1 + length] >= "0" && raw[index + 1 + length] <= "7") length++;
      bytes.push(parseInt(raw.slice(index + 1, index + 1 + length), 8));
      index += length;
    } else {
      bytes.push(GIT_ESCAPE_MAP[next] ?? next.charCodeAt(0));
      index += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
