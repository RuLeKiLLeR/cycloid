import { execFileSync } from "node:child_process";

import { parseGithubRepoFullName } from "../../../shared/github/repo-url.js";
import { stringifyError } from "../../../shared/utils/errors.js";
import { CliError } from "./errors.js";

export type RepoRef = { owner: string; repo: string };

export function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    throw new CliError("user", `git ${args.join(" ")} failed: ${stringifyError(err)}`);
  }
}

export function currentRepo(): RepoRef {
  const parsed = parseGithubRepoFullName(git(["remote", "get-url", "origin"]));
  if (!parsed) throw new CliError("user", "origin remote must point at a GitHub repository");
  return { owner: parsed.owner, repo: parsed.repo };
}
