import { describe, expect, it } from "vitest";

import { parseRepoArg as parseEgressRepoArg } from "../../apps/cli/src/commands/egress.js";
import { parseRepoArg as parseReposRepoArg } from "../../apps/cli/src/commands/repos.js";
import { parseRepoArg as parseTestCredsRepoArg } from "../../apps/cli/src/commands/test-creds.js";

const parsers = [
  ["egress", parseEgressRepoArg],
  ["repos", parseReposRepoArg],
  ["test-creds", parseTestCredsRepoArg],
] as const;

describe("CLI repository argument parsing", () => {
  it.each([
    ["owner/name", { owner: "owner", repo: "name" }],
    ["https://github.com/owner/name.git", { owner: "owner", repo: "name" }],
    ["git@github.com:owner/name.git", { owner: "owner", repo: "name" }],
  ])("accepts %s consistently", (value, expected) => {
    for (const [command, parse] of parsers) {
      const parsed = parse(value);
      expect({ owner: parsed.owner, repo: "repo" in parsed ? parsed.repo : parsed.name }, command).toEqual(expected);
    }
  });

  it.each(["", "/name", "owner/", "owner/name/extra"])('rejects "%s" consistently', (value) => {
    for (const [, parse] of parsers) expect(() => parse(value)).toThrow("repo must be owner/name or a GitHub URL");
  });

  it("rejects SSH remotes that are not hosted on GitHub", () => {
    for (const [, parse] of parsers) {
      expect(() => parse("git@gitlab.com:owner/name.git")).toThrow("repo must be owner/name or a GitHub URL");
    }
  });

  it("preserves egress's legacy shorthand .git normalization", () => {
    expect(parseEgressRepoArg("owner/name.git")).toEqual({ owner: "owner", repo: "name" });
  });
});
