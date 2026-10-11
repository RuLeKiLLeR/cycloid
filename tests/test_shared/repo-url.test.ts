import { describe, expect, it } from "vitest";

import { isValidGithubRepoSegment, parseGithubRepoFullName } from "../../shared/github/repo-url.js";

describe("parseGithubRepoFullName", () => {
  it("parses owner/repo shorthand", () => {
    expect(parseGithubRepoFullName("owner/repo")).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses SSH repo URLs with and without .git", () => {
    expect(parseGithubRepoFullName("git@github.com:owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGithubRepoFullName("git@github.com:owner/repo")).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses GitHub HTTPS URLs with and without .git", () => {
    expect(parseGithubRepoFullName("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGithubRepoFullName("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
  });

  it("returns null for invalid repo strings", () => {
    expect(parseGithubRepoFullName("not a repo")).toBeNull();
    expect(parseGithubRepoFullName("https://example.com/owner/repo")).toBeNull();
  });
});

describe("isValidGithubRepoSegment", () => {
  it.each(["trycycloid", "cycloid_2", "repo.name", "a-b-c", "A1"])("accepts %s", (value) => {
    expect(isValidGithubRepoSegment(value)).toBe(true);
  });

  it.each([
    ["", "empty"],
    [".", "dot"],
    ["..", "dot-dot"],
    ["a/../b", "slash traversal"],
    ["a/b", "slash"],
    ["a@b", "at sign"],
    ["a b", "space"],
    ["a%2Fb", "percent"],
    ["-foo", "leading hyphen"],
    ["---", "all hyphens"],
    ["a".repeat(101), "over length cap"],
  ])("rejects %s (%s)", (value) => {
    expect(isValidGithubRepoSegment(value)).toBe(false);
  });

  it.each([
    [["."], "array coercing to ."],
    [[".."], "array coercing to .."],
    [42, "number"],
    [null, "null"],
    [undefined, "undefined"],
    [{}, "object"],
  ])("rejects non-string %s (%s)", (value, _desc) => {
    expect(isValidGithubRepoSegment(value)).toBe(false);
  });
});
