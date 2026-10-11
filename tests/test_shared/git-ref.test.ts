import { describe, expect, it } from "vitest";

import { isSafeGitRef } from "../../shared/utils/git-ref.js";

describe("isSafeGitRef", () => {
  it.each([
    "main",
    "feature/add-widget",
    "josiah/arc-1043-durable-post-execution-outbox",
    "release-1.2.3",
    "a",
    "deep/nested/branch/name",
    "UPPER-case_Mixed.1",
  ])("accepts valid branch name %s", (ref) => {
    expect(isSafeGitRef(ref)).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["--upload-pack=touch /tmp/x", "leading dash flag injection"],
    ["-x", "leading dash"],
    ["a..b", "double dot"],
    ["a@{b", "reflog syntax"],
    ["@", "bare @"],
    ["HEAD", "HEAD shorthand"],
    ["a.", "trailing dot"],
    ["a.lock", "lock suffix"],
    ["a/b.lock/c", "lock suffix segment"],
    ["a//b", "double slash"],
    ["/a", "leading slash"],
    ["a/", "trailing slash"],
    ["a/.b", "dot-prefixed segment"],
    [".a", "leading dot"],
    ["a b", "space"],
    ["a\tb", "tab"],
    ["a\nb", "newline"],
    ["a" + String.fromCharCode(0) + "b", "NUL"],
    ["a" + String.fromCharCode(127) + "b", "DEL"],
    ["a~b", "tilde"],
    ["a^b", "caret"],
    ["a:b", "colon"],
    ["a?b", "question mark"],
    ["a*b", "asterisk"],
    ["a[b", "open bracket"],
    ["a\\b", "backslash"],
    ["a".repeat(251), "over length cap"],
  ])("rejects %s (%s)", (ref) => {
    expect(isSafeGitRef(ref)).toBe(false);
  });
});
