import { describe, expect, it } from "vitest";

import { parseRepoFullNameFromUrl } from "../../apps/ui/src/utils/repos.js";

describe("parseRepoFullNameFromUrl", () => {
  it("parses shorthand, SSH, and HTTPS GitHub repo names", () => {
    expect(parseRepoFullNameFromUrl("owner/repo")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseRepoFullNameFromUrl("git@github.com:owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseRepoFullNameFromUrl("git@github.com:owner/repo")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseRepoFullNameFromUrl("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseRepoFullNameFromUrl("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
  });

  it("returns null for invalid repo strings", () => {
    expect(parseRepoFullNameFromUrl("not a repo")).toBeNull();
    expect(parseRepoFullNameFromUrl("https://example.com/owner/repo")).toBeNull();
  });
});
