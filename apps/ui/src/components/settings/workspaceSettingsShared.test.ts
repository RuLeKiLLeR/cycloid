import { describe, expect, it } from "vitest";

import { parseRepoFullName } from "./workspaceSettingsShared";

describe("parseRepoFullName", () => {
  it("splits a valid owner/name pair", () => {
    expect(parseRepoFullName("acme/widgets")).toEqual({ repoOwner: "acme", repoName: "widgets" });
  });

  it("rejects values without exactly one slash", () => {
    expect(parseRepoFullName("acme")).toBeNull();
    expect(parseRepoFullName("acme/widgets/extra")).toBeNull();
  });

  it("rejects empty owner or name segments", () => {
    expect(parseRepoFullName("/widgets")).toBeNull();
    expect(parseRepoFullName("acme/")).toBeNull();
    expect(parseRepoFullName("")).toBeNull();
  });
});
