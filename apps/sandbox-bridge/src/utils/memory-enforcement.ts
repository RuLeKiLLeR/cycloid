import { existsSync } from "fs";
import { join } from "path";

import { execRepoGitSync } from "../services/git/exec.js";
import type { Memory } from "../services/memory-ranking.js";

export function isGitWorktree(repoPath: string): boolean {
  if (!existsSync(join(repoPath, ".git"))) return false;
  try {
    return (
      execRepoGitSync(["rev-parse", "--is-inside-work-tree"], {
        cwd: repoPath,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "true"
    );
  } catch {
    return false;
  }
}

/**
 * Normalize a memory `applies_to` pattern or a repo file path to a single canonical form so
 * matching and scoring never diverge: trim, backslash -> slash, strip leading `./`, strip
 * trailing `/`, lowercase. Blank/whitespace-only input returns "".
 */
export function normalizeMemoryPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Match a file path against a single `applies_to` glob with proper path-segment semantics:
 * - a single `*` matches within one path segment (never crosses `/`) and honors any suffix,
 * - `**` matches recursively across `/` (`/**/ ` = zero or more full segments, trailing `; /**`
 *   = any descendant, preserving the legacy prefix behavior),
 * - a wildcard-free pattern matches the file exactly or as a directory prefix.
 * `?`, `[`, `]` are treated literally (out of scope for the recall glob contract).
 * Both arguments are normalized internally, so callers cannot feed inconsistent inputs.
 */
export function memoryGlobMatches(pattern: string, filePath: string): boolean {
  const np = normalizeMemoryPath(pattern);
  const nf = normalizeMemoryPath(filePath);
  if (!np) return false;
  if (!np.includes("*")) return nf === np || nf.startsWith(`${np}/`);
  try {
    return globPatternToRegex(np).test(nf);
  } catch {
    return false;
  }
}

/**
 * Translate a normalized whole-path glob (single `*` vs recursive `**`) into an anchored regex.
 * Uses bounded `[^/]+/` runs for intermediate `**` segments to keep matching linear (ReDoS-safe).
 */
function globPatternToRegex(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*") {
      const isDouble = pattern[i + 1] === "*";
      if (isDouble) {
        const before = pattern[i - 1];
        const after = pattern[i + 2];
        if (before === "/" && after === "/") {
          // `/**/` -> collapse the leading slash we already emitted into zero-or-more segments.
          out = out.replace(/\/$/, "");
          out += "/(?:[^/]+/)*";
          i += 3; // consume `**/`
          continue;
        }
        if (after === "/" && before === undefined) {
          out += "(?:[^/]+/)*"; // leading `**/`
          i += 3;
          continue;
        }
        // trailing `/**` (or bare `**`) -> match any descendants.
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*"; // single-segment `*`
      i += 1;
      continue;
    }
    out += escapeRegexChar(char);
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

function escapeRegexChar(char: string): string {
  // Escape regex-special chars; `/` needs none and must stay bare so the `/**/` slash-collapse works.
  return /[.+^${}()|[\]\\?]/.test(char) ? `\\${char}` : char;
}

export function memoryPathMatches(memory: Memory, filePath: string): boolean {
  const targets = memory.applies_to ?? [];
  if (targets.length === 0) return true;
  return targets.some((target) => memoryGlobMatches(target, filePath));
}

export function memoryForbiddenPatternMatches(memory: Memory, diffText: string): boolean {
  const patterns = [...(memory.triggers?.forbidden_patterns ?? []), ...(memory.triggers?.command_patterns ?? [])];
  const addedText = addedDiffText(diffText);
  if (!addedText) return false;
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(addedText);
    } catch {
      return false;
    }
  });
}

function addedDiffText(diffText: string): string {
  return diffText
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

export function memoryBlockReason(memory: Memory): string {
  return (
    memory.content
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? memory.id
  );
}
