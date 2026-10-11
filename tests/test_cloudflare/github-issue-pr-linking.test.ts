import { describe, expect, it } from "vitest";

import { appendGithubIssueLink } from "../../apps/control-plane-worker/src/session/pr-body";

const SAMPLE_CONTEXT = {
  owner: "acme",
  repo: "repo",
  issueNumber: 73,
};

describe("appendGithubIssueLink", () => {
  it("prepends the GitHub issue closing reference to the PR body", () => {
    const result = appendGithubIssueLink("## Changes\nSome diff", SAMPLE_CONTEXT);
    expect(result).toBe("Closes acme/repo#73\n\n## Changes\nSome diff");
  });

  it("returns the body unchanged when no GitHub issue context is present", () => {
    const body = "## Changes\nSome diff";
    expect(appendGithubIssueLink(body)).toBe(body);
  });

  it("returns the body unchanged when the repo owner is missing", () => {
    const body = "## Changes\nSome diff";
    expect(appendGithubIssueLink(body, { owner: "", repo: "repo", issueNumber: 73 })).toBe(body);
  });

  it("deduplicates when the exact closing reference is already present", () => {
    const body = "Closes acme/repo#73\n\n## Changes\nSome diff";
    expect(appendGithubIssueLink(body, SAMPLE_CONTEXT)).toBe(body);
  });

  it("preserves existing Linear links when both link types are present", () => {
    const body = "Resolves [ARC-123](https://linear.app/cycloid/issue/ARC-123/foo)\n\n## Changes\nSome diff";
    const result = appendGithubIssueLink(body, SAMPLE_CONTEXT);
    expect(result).toContain("Closes acme/repo#73");
    expect(result).toContain("Resolves [ARC-123]");
  });
});
