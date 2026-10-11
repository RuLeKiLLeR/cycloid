import { describe, expect, it } from "vitest";

import { splitGitDiffByFile } from "../../apps/sandbox-bridge/src/utils/git-diff";

function textDiff(path: string, line: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,1 +1,2 @@",
    " existing",
    `+${line}`,
    "",
  ].join("\n");
}

describe("splitGitDiffByFile", () => {
  it("returns an empty map for empty diff output", () => {
    expect(splitGitDiffByFile("", ["a.ts"]).size).toBe(0);
  });

  it("splits a multi-file diff into standalone per-file chunks", () => {
    const combined = textDiff("src/safe.ts", "fine()") + textDiff("src/blocked.ts", "forbidden()");
    const chunks = splitGitDiffByFile(combined, ["src/safe.ts", "src/blocked.ts"]);

    expect([...chunks.keys()].sort()).toEqual(["src/blocked.ts", "src/safe.ts"]);
    expect(chunks.get("src/safe.ts")).toBe(textDiff("src/safe.ts", "fine()"));
    expect(chunks.get("src/blocked.ts")).toBe(textDiff("src/blocked.ts", "forbidden()"));
    expect(chunks.get("src/safe.ts")!.startsWith("diff --git ")).toBe(true);
    expect(chunks.get("src/blocked.ts")!.startsWith("diff --git ")).toBe(true);
  });

  it("never maps a chunk to a file the caller did not ask about", () => {
    const combined = textDiff("src/known.ts", "x") + textDiff("src/unrelated.ts", "y");
    const chunks = splitGitDiffByFile(combined, ["src/known.ts"]);

    expect([...chunks.keys()]).toEqual(["src/known.ts"]);
  });

  it("handles paths with spaces", () => {
    const path = "docs/file with space.md";
    const chunks = splitGitDiffByFile(textDiff(path, "x"), [path]);

    expect(chunks.get(path)).toBe(textDiff(path, "x"));
  });

  it("matches renamed files by their rename target", () => {
    const renameDiff = [
      "diff --git a/src/old-name.ts b/src/new-name.ts",
      "similarity index 90%",
      "rename from src/old-name.ts",
      "rename to src/new-name.ts",
      "index 1111111..2222222 100644",
      "--- a/src/old-name.ts",
      "+++ b/src/new-name.ts",
      "@@ -1,1 +1,2 @@",
      " existing",
      "+added",
      "",
    ].join("\n");

    const chunks = splitGitDiffByFile(renameDiff, ["src/new-name.ts"]);
    expect(chunks.get("src/new-name.ts")).toBe(renameDiff);
  });

  it("matches deleted files", () => {
    const deleteDiff = [
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-removed",
      "",
    ].join("\n");

    const chunks = splitGitDiffByFile(deleteDiff, ["src/gone.ts"]);
    expect(chunks.get("src/gone.ts")).toBe(deleteDiff);
  });

  it("matches binary file chunks", () => {
    const binaryDiff = [
      "diff --git a/assets/logo.png b/assets/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/assets/logo.png and b/assets/logo.png differ",
      "",
    ].join("\n");

    const chunks = splitGitDiffByFile(binaryDiff, ["assets/logo.png"]);
    expect(chunks.get("assets/logo.png")).toBe(binaryDiff);
  });

  it("decodes git-quoted headers so the real unicode path matches", () => {
    const quotedDiff = [
      'diff --git "a/docs/caf\\303\\251.md" "b/docs/caf\\303\\251.md"',
      "index 1111111..2222222 100644",
      '--- "a/docs/caf\\303\\251.md"',
      '+++ "b/docs/caf\\303\\251.md"',
      "@@ -1,1 +1,2 @@",
      " existing",
      "+added",
      "",
    ].join("\n");

    const chunks = splitGitDiffByFile(quotedDiff, ["docs/café.md"]);
    expect(chunks.get("docs/café.md")).toBe(quotedDiff);
  });

  it("decodes quoted rename targets in the chunk body", () => {
    const renameDiff = [
      'diff --git "a/docs/old caf\\303\\251.md" "b/docs/caf\\303\\251.md"',
      "similarity index 90%",
      'rename from "docs/old caf\\303\\251.md"',
      'rename to "docs/caf\\303\\251.md"',
      "index 1111111..2222222 100644",
      '--- "a/docs/old caf\\303\\251.md"',
      '+++ "b/docs/caf\\303\\251.md"',
      "@@ -1,1 +1,2 @@",
      " existing",
      "+added",
      "",
    ].join("\n");

    const chunks = splitGitDiffByFile(renameDiff, ["docs/café.md"]);
    expect(chunks.get("docs/café.md")).toBe(renameDiff);
  });

  it("decodes quoted paths with escaped quotes and tabs", () => {
    const path = 'docs/has"quote\tand tab.md';
    const quotedDiff = [
      'diff --git "a/docs/has\\"quote\\tand tab.md" "b/docs/has\\"quote\\tand tab.md"',
      "index 1111111..2222222 100644",
      '--- "a/docs/has\\"quote\\tand tab.md"',
      '+++ "b/docs/has\\"quote\\tand tab.md"',
      "@@ -1,1 +1,2 @@",
      " existing",
      "+added",
      "",
    ].join("\n");

    const chunks = splitGitDiffByFile(quotedDiff, [path]);
    expect(chunks.get(path)).toBe(quotedDiff);
  });
});
