import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const UI_SRC = join(__dirname, "../../apps/ui/src");

const LEGACY_FILES_WITH_ARBITRARY_CONTROL_HEIGHTS = new Set([
  "authenticated-app.tsx",
  "components/Layout.tsx",
  "components/StaleChunkRecoveryPrompt.tsx",
  "components/Toggle.tsx",
  "pages/PendingSignupsAdminPage.tsx",
  "pages/SupportViewAdminPage.tsx",
]);

const arbitraryControlHeightPattern = /\b(?:min-h|md:min-h)-\[(?:32|36|40|44)px\]/g;

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

describe("control height guard", () => {
  const files = collectTsxFiles(UI_SRC);

  it("has UI source files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("keeps new control-height work on .control-sm/md/lg utilities", () => {
    const violations: string[] = [];

    for (const file of files) {
      const relativePath = relative(UI_SRC, file);
      if (LEGACY_FILES_WITH_ARBITRARY_CONTROL_HEIGHTS.has(relativePath)) continue;

      const source = readFileSync(file, "utf-8");
      for (const match of source.matchAll(arbitraryControlHeightPattern)) {
        const before = source.slice(0, match.index ?? 0);
        const line = before.split("\n").length;
        violations.push(`${relativePath}:${line}: ${match[0]}`);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Found ${violations.length} arbitrary control height(s). Use .control-sm, ` +
          `.control-md, .control-lg, or .control-textarea from App.css instead.\n\n` +
          violations.join("\n"),
      );
    }
  });
});
