import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const UI_SRC = join(__dirname, "../../apps/ui/src");
const MAIN_ENTRYPOINT = join(UI_SRC, "main.tsx");
const AUTHENTICATED_ENTRYPOINT = join(UI_SRC, "authenticated-app.tsx");

/**
 * Shared modules frozen for browser import (Phase 0).
 *
 * Existing violations are exempted via eslint-disable-next-line comments.
 * This test ensures no new un-exempted imports appear.
 */
const FROZEN_PATTERNS = [
  /from\s+["'].*shared\/constants\/models/,
  /from\s+["'].*shared\/constants\/integration-helpers/,
  /from\s+["'].*shared\/constants\/integrations/,
];

const DISABLE_COMMENT = "eslint-disable-next-line no-restricted-imports";

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (/\.[tj]sx?$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe("UI import boundary freeze", () => {
  const files = collectTsFiles(UI_SRC);

  it("has UI source files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("every frozen-module import has an eslint-disable comment", () => {
    const violations: string[] = [];

    for (const file of files) {
      const lines = readFileSync(file, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isFrozen = FROZEN_PATTERNS.some((pat) => pat.test(line));
        if (!isFrozen) continue;

        // For multi-line imports, the `from "..."` is on a later line.
        // Walk backwards to find the import/export statement start, then check the line above it.
        let importStart = i;
        while (importStart > 0 && !/^\s*(import|export)\s/.test(lines[importStart])) {
          importStart--;
        }
        const prev = importStart > 0 ? lines[importStart - 1] : "";
        if (!prev.includes(DISABLE_COMMENT)) {
          const rel = relative(UI_SRC, file);
          violations.push(`${rel}:${importStart + 1}: ${lines[importStart].trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Found ${violations.length} frozen-module import(s) without eslint-disable comment.\n` +
          "Add '// eslint-disable-next-line no-restricted-imports -- pre-existing: remove in Phase N' " +
          "above each import, or replace the import with a server-provided DTO.\n\n" +
          violations.join("\n"),
      );
    }
  });

  it("frozen-module imports are accounted for in the inventory", () => {
    // Track exact count of exempted frozen imports to catch unexpected additions.
    // Update this count only when intentionally adding or removing an exemption.
    const EXPECTED_EXEMPTED_COUNT = 3;

    let exemptedCount = 0;
    for (const file of files) {
      const lines = readFileSync(file, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isFrozen = FROZEN_PATTERNS.some((pat) => pat.test(line));
        if (!isFrozen) continue;

        let importStart = i;
        while (importStart > 0 && !/^\s*(import|export)\s/.test(lines[importStart])) {
          importStart--;
        }
        const prev = importStart > 0 ? lines[importStart - 1] : "";
        if (prev.includes(DISABLE_COMMENT)) {
          exemptedCount++;
        }
      }
    }

    expect(exemptedCount).toBe(EXPECTED_EXEMPTED_COUNT);
  });

  it("keeps authenticated route modules out of the public bootstrap entrypoint", () => {
    const source = readFileSync(MAIN_ENTRYPOINT, "utf-8");
    const forbiddenRouteMarkers = [
      "HomePage",
      "SessionPage",
      "SettingsPage",
      "EvalsPage",
      "GeneralSettings",
      "IntegrationsSettings",
      "CliTokensSettings",
      "BusinessIntegrationsSettings",
      "./App.css",
      "./components/Layout",
      "./pages/",
      "./components/settings/",
    ];

    for (const marker of forbiddenRouteMarkers) {
      expect(source).not.toContain(marker);
    }

    expect(source).toContain('import("./authenticated-app")');
  });

  it("authenticated app entrypoint imports the Tailwind stylesheet", () => {
    // Regression guard for the prod CSS breakage caused when App.css was
    // dropped from main.tsx (correctly, to slim the public shell) but never
    // re-added to the authenticated bundle. Without this import the signed-in
    // app renders with no Tailwind utilities.
    const source = readFileSync(AUTHENTICATED_ENTRYPOINT, "utf-8");
    expect(source).toMatch(/import\s+["']\.\/App\.css["']/);
  });
});
