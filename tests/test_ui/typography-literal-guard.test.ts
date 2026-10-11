import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const UI_SRC = join(__dirname, "../../apps/ui/src");

/**
 * Guards the type-scale codemod (token-enforce PR 2). Once `text-[Npx]` literals
 * were migrated onto the `--text-*` token utilities, this test fails the build if
 * any new arbitrary text-size literal reappears, so the scale can't silently drift
 * back to per-component pixel overrides.
 *
 * Allowlisted sizes are the section/page-heading literals that have no token
 * (kept intentionally as one-offs). If you add a new size here, you almost
 * certainly want a `--text-*` token + utility instead.
 */
const ALLOWED_TEXT_PX = new Set([22, 26, 30]);
// Built fresh per scan so the stateful `/g` lastIndex is never shared.
const textPxPattern = () => /text-\[(\d+)px\]/g;

function collectTsxFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectTsxFiles(full));
    } else if (/\.tsx$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe("typography literal guard", () => {
  const files = collectTsxFiles(UI_SRC);

  it("has UI source files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("uses --text-* token utilities instead of arbitrary text-[Npx] literals", () => {
    const violations: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      for (const match of source.matchAll(textPxPattern())) {
        const px = Number(match[1]);
        if (ALLOWED_TEXT_PX.has(px)) continue;
        const before = source.slice(0, match.index ?? 0);
        const line = before.split("\n").length;
        violations.push(`${relative(UI_SRC, file)}:${line}: ${match[0]}`);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Found ${violations.length} arbitrary text-[Npx] literal(s). Use a --text-* ` +
          `token utility (text-2xs/xs/sm/base/md/lg/xl/2xl/3xl) defined in App.css, ` +
          `or add a new token if the size is genuinely missing.\n\n` +
          violations.join("\n"),
      );
    }
  });
});
