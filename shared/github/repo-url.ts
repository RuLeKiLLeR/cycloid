export type GithubRepoFullName = {
  owner: string;
  repo: string;
};

// GitHub owner/repo names cannot begin with a hyphen, and `.`/`..` are
// path-traversal in any URL or filesystem use even though the charset allows them.
const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const MAX_REPO_SEGMENT_LENGTH = 100;

/**
 * Validates a single GitHub owner or repo path segment. Takes `unknown` and
 * acts as a type guard so a non-string (e.g. a JSON array from a request body)
 * is rejected at the source rather than coerced through the regex.
 */
export function isValidGithubRepoSegment(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value || value.length > MAX_REPO_SEGMENT_LENGTH) return false;
  if (value === "." || value === "..") return false;
  return REPO_SEGMENT_PATTERN.test(value);
}

export function parseGithubRepoFullName(value: string): GithubRepoFullName | null {
  const shorthand = value.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (shorthand) return { owner: shorthand[1], repo: shorthand[2] };

  const ssh = value.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };

  const https = value.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (https) return { owner: https[1], repo: https[2] };

  return null;
}
