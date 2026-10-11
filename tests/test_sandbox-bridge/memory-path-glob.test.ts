import { describe, expect, it } from "vitest";

import { memoryPathSpecificity } from "../../apps/sandbox-bridge/src/services/memory-dynamic-tool.js";
import type { Memory } from "../../apps/sandbox-bridge/src/services/memory-ranking.js";
import {
  memoryGlobMatches,
  memoryPathMatches,
  normalizeMemoryPath,
} from "../../apps/sandbox-bridge/src/utils/memory-enforcement.js";

function memory(appliesTo?: string[]): Memory {
  return { applies_to: appliesTo } as unknown as Memory;
}

describe("normalizeMemoryPath", () => {
  it("folds backslashes, case, leading ./, and trailing / to one canonical form", () => {
    expect(normalizeMemoryPath("Src\\Foo.TS")).toBe("src/foo.ts");
    expect(normalizeMemoryPath("./src/foo.ts")).toBe("src/foo.ts");
    expect(normalizeMemoryPath("src/")).toBe("src");
    expect(normalizeMemoryPath("././src//")).toBe("src");
  });

  it("returns empty string for blank input", () => {
    expect(normalizeMemoryPath("")).toBe("");
    expect(normalizeMemoryPath("   ")).toBe("");
  });
});

describe("memoryGlobMatches - single * stays within one path segment", () => {
  it("matches a direct child with the required suffix", () => {
    expect(memoryGlobMatches("routes/*.ts", "routes/auth.ts")).toBe(true);
    expect(memoryGlobMatches("src/*.ts", "src/foo.ts")).toBe(true);
  });

  it("does not cross a slash", () => {
    expect(memoryGlobMatches("routes/*.ts", "routes/sessions/platform-llm-parser.ts")).toBe(false);
    expect(memoryGlobMatches("src/*.ts", "src/subdir/bar.ts")).toBe(false);
  });

  it("honors the suffix after the wildcard", () => {
    expect(memoryGlobMatches("routes/*.ts", "routes/auth.js")).toBe(false);
  });
});

describe("memoryGlobMatches - ** is recursive", () => {
  it("matches any descendant for a trailing /** and not the bare directory", () => {
    expect(memoryGlobMatches("apps/**", "apps/x")).toBe(true);
    expect(memoryGlobMatches("apps/**", "apps/x/y.ts")).toBe(true);
    expect(memoryGlobMatches("apps/**", "apps")).toBe(false);
  });

  it("treats /**/ as zero or more full segments", () => {
    expect(memoryGlobMatches("src/**/*.ts", "src/foo.ts")).toBe(true);
    expect(memoryGlobMatches("src/**/*.ts", "src/a/b/foo.ts")).toBe(true);
    expect(memoryGlobMatches("src/**/*.ts", "other/foo.ts")).toBe(false);
  });

  it("supports a leading **/", () => {
    expect(memoryGlobMatches("**/*.ts", "foo.ts")).toBe(true);
    expect(memoryGlobMatches("**/*.ts", "a/b.ts")).toBe(true);
    expect(memoryGlobMatches("**/*.ts", "a/b.js")).toBe(false);
  });

  it("supports ** between literals", () => {
    expect(memoryGlobMatches("foo/**/bar", "foo/bar")).toBe(true);
    expect(memoryGlobMatches("foo/**/bar", "foo/x/y/bar")).toBe(true);
    expect(memoryGlobMatches("foo/**/bar", "foo/x/baz")).toBe(false);
  });
});

describe("memoryGlobMatches - plain paths and blanks", () => {
  it("matches exact and directory-prefix for wildcard-free patterns", () => {
    expect(memoryGlobMatches("src/foo.ts", "src/foo.ts")).toBe(true);
    expect(memoryGlobMatches("src", "src/foo.ts")).toBe(true);
    expect(memoryGlobMatches("src", "srcfoo.ts")).toBe(false);
  });

  it("normalizes both arguments before comparing", () => {
    expect(memoryGlobMatches("./Src/*.TS", "src/foo.ts")).toBe(true);
  });

  it("never matches a blank pattern", () => {
    expect(memoryGlobMatches("", "src/foo.ts")).toBe(false);
    expect(memoryGlobMatches("   ", "src/foo.ts")).toBe(false);
  });
});

describe("memoryPathMatches", () => {
  it("reproduces the ARC-1553 examples", () => {
    expect(memoryPathMatches(memory(["routes/*.ts"]), "routes/sessions/platform-llm-parser.ts")).toBe(false);
    expect(memoryPathMatches(memory(["routes/*.ts"]), "routes/auth.js")).toBe(false);
    expect(memoryPathMatches(memory(["routes/*.ts"]), "routes/auth.ts")).toBe(true);
  });

  it("treats missing or empty applies_to as unrestricted", () => {
    expect(memoryPathMatches(memory(undefined), "anything.ts")).toBe(true);
    expect(memoryPathMatches(memory([]), "anything.ts")).toBe(true);
  });

  it("ignores blank applies_to entries", () => {
    expect(memoryPathMatches(memory([""]), "anything.ts")).toBe(false);
    expect(memoryPathMatches(memory(["   "]), "anything.ts")).toBe(false);
  });
});

describe("memoryPathSpecificity - exact scores, parity with legacy ranking", () => {
  it("scores a mid-* pattern above zero (the reported bug)", () => {
    expect(memoryPathSpecificity(memory(["src/*.ts"]), "src/foo.ts")).toBe(3);
  });

  it("keeps a more specific glob above a broad one", () => {
    const specific = memoryPathSpecificity(memory(["apps/foo/*"]), "apps/foo/bar.ts");
    const broad = memoryPathSpecificity(memory(["apps/**"]), "apps/foo/bar.ts");
    expect(specific).toBe(6);
    expect(broad).toBe(3);
    expect(specific).toBeGreaterThan(broad);
  });

  it("rewards an exact literal path and a plain directory prefix", () => {
    expect(memoryPathSpecificity(memory(["apps/foo/bar.ts"]), "apps/foo/bar.ts")).toBe(30);
    expect(memoryPathSpecificity(memory(["apps"]), "apps/foo/bar.ts")).toBe(3);
  });

  it("scores a non-matching or wildcard-only pattern zero", () => {
    expect(memoryPathSpecificity(memory(["routes/*.ts"]), "routes/sessions/x.ts")).toBe(0);
    expect(memoryPathSpecificity(memory(["**"]), "apps/foo/bar.ts")).toBe(0);
  });
});
