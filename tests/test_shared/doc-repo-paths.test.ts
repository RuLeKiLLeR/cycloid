import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");

describe("codebase map repo paths", () => {
  it("references paths that exist", () => {
    const markdown = readFileSync(resolve(repoRoot, "docs/codebase-map.md"), "utf8");
    const paths = Array.from(
      markdown.matchAll(/`((?:apps|shared|scripts|infra|docs|\.github)\/[^`]+)`/g),
      (match) => match[1],
    ).flatMap((raw) => raw.split(",").map((part) => part.trim()));
    const failures = paths.filter((path) => !existsSync(resolve(repoRoot, path)));

    expect(failures).toEqual([]);
  });
});
