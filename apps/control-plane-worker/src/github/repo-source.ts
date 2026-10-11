import { tracedFetch } from "../observability/wrappers";
import { GITHUB_API, githubHeaders } from "./pr";

export type RepoSourceErrorCode =
  "ref_not_found" | "source_file_missing" | "source_file_not_text" | "repo_source_unavailable";

export class RepoSourceError extends Error {
  constructor(
    readonly code: RepoSourceErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "RepoSourceError";
  }
}

export async function resolveRepoCommitSha(token: string, owner: string, repo: string, ref: string): Promise<string> {
  const response = await tracedFetch(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`,
    { headers: githubHeaders(token) },
  );
  if (response.status === 404) {
    throw new RepoSourceError("ref_not_found", "GitHub ref was not found", 404);
  }
  if (!response.ok) {
    throw new RepoSourceError("repo_source_unavailable", "Unable to resolve GitHub ref", 503);
  }
  const data = (await response.json()) as { sha?: unknown };
  if (typeof data.sha !== "string" || !/^[0-9a-f]{40}$/i.test(data.sha)) {
    throw new RepoSourceError("ref_not_found", "GitHub ref did not resolve to a commit", 404);
  }
  return data.sha;
}

export async function fetchRepoTextFileAtCommit(
  token: string,
  owner: string,
  repo: string,
  path: string,
  commitSha: string,
): Promise<string> {
  const encodedPath = path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const response = await tracedFetch(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(commitSha)}`,
    { headers: githubHeaders(token) },
  );
  if (response.status === 404) {
    throw new RepoSourceError("source_file_missing", `Sandbox layer source file was not found: ${path}`, 404);
  }
  if (!response.ok) {
    throw new RepoSourceError("repo_source_unavailable", "Unable to fetch sandbox layer source file", 503);
  }
  const data = (await response.json()) as { content?: unknown; encoding?: unknown; type?: unknown };
  if (data.type !== "file" || data.encoding !== "base64" || typeof data.content !== "string") {
    throw new RepoSourceError("source_file_not_text", `Sandbox layer source path is not a text file: ${path}`, 400);
  }
  try {
    const binary = atob(data.content.replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RepoSourceError("source_file_not_text", `Sandbox layer source file is not valid UTF-8: ${path}`, 400);
  }
}
