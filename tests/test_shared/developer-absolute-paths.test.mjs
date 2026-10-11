import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  findDeveloperAbsolutePaths,
  isAllowedAbsolutePath,
  isScannedRepoFile,
  scanRepoFiles,
} from "../../scripts/check-developer-absolute-paths.mjs";

describe("developer absolute path guard", () => {
  it("reports developer-specific macOS and Linux home paths", () => {
    const macDeveloperPath = `/${"Users"}/alice/dev/cycloid/scripts/check.js`;
    const linuxDeveloperPath = `/${"home"}/bob/work/project/out.txt`;

    expect(
      findDeveloperAbsolutePaths(
        [`Run ${macDeveloperPath} before committing.`, `The generated file was written to ${linuxDeveloperPath}.`].join(
          "\n",
        ),
        "docs/example.md",
      ),
    ).toEqual([
      {
        filePath: "docs/example.md",
        line: 1,
        column: 5,
        path: macDeveloperPath,
      },
      {
        filePath: "docs/example.md",
        line: 2,
        column: 35,
        path: linuxDeveloperPath,
      },
    ]);
  });

  it("allows placeholder and fixture home paths", () => {
    const content = [
      "Use /Users/<name>/dev/cycloid when documenting placeholders.",
      "Fixture paths such as /home/user/.ssh/id_rsa are allowed.",
      "Sandbox paths such as /home/sandbox/repo are allowed.",
      "CI paths such as /home/runner/work/cycloid are allowed.",
    ].join("\n");

    expect(findDeveloperAbsolutePaths(content, "tests/example.test.ts")).toEqual([]);
  });

  it("does not match URL path segments", () => {
    const content = [
      "See https://example.com/home/alice/docs for route documentation.",
      "See file:///home/alice/docs for a URL-shaped reference.",
    ].join("\n");

    expect(findDeveloperAbsolutePaths(content, "docs/example.md")).toEqual([]);
  });

  it("keeps the explicit allowed home account list narrow", () => {
    const localDeveloperPath = `/${"home"}/jparappally/dev/cycloid`;

    expect(isAllowedAbsolutePath("/home/user/.env")).toBe(true);
    expect(isAllowedAbsolutePath("/home/sandbox/repo")).toBe(true);
    expect(isAllowedAbsolutePath("/Users/runner/work/repo")).toBe(true);
    expect(isAllowedAbsolutePath(localDeveloperPath)).toBe(false);
  });

  it("excludes generated and fixture-only tracked files", () => {
    expect(isScannedRepoFile("apps/control-plane-worker/src/index.ts")).toBe(true);
    expect(isScannedRepoFile("tests/test_shared/fixtures/fixture.md")).toBe(false);
    expect(isScannedRepoFile("tests/test_sandbox-bridge/fixtures/claude-protocol/2.1.167/text-only.ndjson")).toBe(
      false,
    );
    expect(isScannedRepoFile("package-lock.json")).toBe(false);
  });

  it("skips tracked paths deleted from the working tree", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "developer-paths-"));
    try {
      writeFileSync(join(repoRoot, "kept.ts"), "const value = 1;\n");

      expect(scanRepoFiles(repoRoot, ["kept.ts", "deleted.ts"])).toEqual([]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
