import { parseGithubRepoFullName } from "../../../../shared/github/repo-url";
import type { BootstrapResponse } from "../../../../shared/types/bootstrap";
import type { Repo } from "../types";

/**
 * Decide how the layout should treat a bootstrap payload's repos, separating the
 * three cases that drive distinct UI state: repos present (render inline),
 * deferred (cache miss/stale -> lazy-load, show loading not error), or a genuine
 * failure (show the error). `defaultRepoUrl` is surfaced so the caller threads
 * the bootstrap's own settings into selection instead of a stale closure.
 */
type BootstrapReposState =
  | { kind: "loaded"; repos: Repo[]; defaultRepoUrl: string | null }
  | { kind: "pending"; defaultRepoUrl: string | null }
  | { kind: "error" };

export function resolveBootstrapReposState(bootstrap: BootstrapResponse): BootstrapReposState {
  const defaultRepoUrl = bootstrap.settings?.defaultRepo ?? null;
  if (bootstrap.repos) return { kind: "loaded", repos: bootstrap.repos, defaultRepoUrl };
  if (bootstrap.reposPending) return { kind: "pending", defaultRepoUrl };
  return { kind: "error" };
}

/**
 * Reorder a repo list so that the user's default repo appears first.
 * Returns the reordered list and the default repo if found.
 *
 * If `defaultRepoUrl` is null/undefined or not found in the list,
 * returns the original list unchanged with `defaultRepo: null`.
 */
export function prioritizeDefaultRepo(
  repos: Repo[],
  defaultRepoUrl: string | null | undefined,
): { repos: Repo[]; defaultRepo: Repo | null } {
  if (!defaultRepoUrl) return { repos, defaultRepo: null };

  const idx = repos.findIndex((r) => r.fullName === defaultRepoUrl);
  if (idx < 0) return { repos, defaultRepo: null };
  if (idx === 0) return { repos, defaultRepo: repos[0] };

  const reordered = [repos[idx], ...repos.slice(0, idx), ...repos.slice(idx + 1)];
  return { repos: reordered, defaultRepo: reordered[0] };
}

export function parseRepoFullNameFromUrl(value: string): { owner: string; repo: string } | null {
  return parseGithubRepoFullName(value);
}
