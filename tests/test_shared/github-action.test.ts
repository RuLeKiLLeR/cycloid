import { describe, expect, it } from "vitest";

import { parseGithubActionArgv } from "../../shared/github-action.js";

describe("parseGithubActionArgv", () => {
  it.each([
    [["pr", "close", "12"], { kind: "close", prNumber: 12 }],
    [
      ["pr", "reopen", "https://github.com/acme/repo/pull/12", "--repo=ACME/repo"],
      { kind: "reopen", prNumber: 12, repo: "ACME/repo" },
    ],
    [
      ["pr", "edit", "12", "--title", "New title", "--repo", "acme/repo"],
      { kind: "edit_title", prNumber: 12, title: "New title", repo: "acme/repo" },
    ],
  ])("accepts %j", (argv, operation) => expect(parseGithubActionArgv(argv)).toEqual({ ok: true, operation }));

  it.each([
    [[], "Only gh"],
    [["pr", "merge", "1"], "Unsupported"],
    [["pr", "checkout", "1"], "Unsupported"],
    [["pr", "close", "1", "--repo", "a/b", "extra"], "Exactly"],
    [["pr", "edit", "1"], "Title-only"],
    [["pr", "edit", "1", "--body", "x"], "Unsupported flag"],
    [["pr", "edit", "1", "--comment", "x"], "Unsupported flag"],
    [["pr", "edit", "1", "--label", "bug"], "Unsupported flag"],
    [["pr", "close", "https://github.com/a/b/issues/1"], "target"],
    [["pr", "close", "1", "--repo", "a/b", "--repo", "c/d"], "repeated"],
  ])("rejects %j", (argv, message) =>
    expect(parseGithubActionArgv(argv)).toMatchObject({ ok: false, message: expect.stringContaining(message) }),
  );
});
