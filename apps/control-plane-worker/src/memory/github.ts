// GitHub Git Data + Contents API helpers for memory PR creation (Workers-compatible).

import { GitHubRequestError } from "../github/errors.js";
import { GITHUB_API, githubHeaders } from "../github/pr.js";
import { tracedFetch } from "../observability/wrappers.js";

// ---------------------------------------------------------------------------
// Contents API: list, read, delete
// ---------------------------------------------------------------------------

interface GitHubFileEntry {
  name: string;
  path: string;
  sha: string;
  type: "file" | "dir";
}

/**
 * List entries in a directory on a specific branch.
 * Returns empty array if directory doesn't exist (404), unless
 * `options.allowNotFound` is false.
 * Throws on transient errors (403/429/500) to fail closed.
 */
export async function listDirectoryContents(
  token: string,
  owner: string,
  repo: string,
  dirPath: string,
  ref: string,
  options?: { allowNotFound?: boolean },
): Promise<GitHubFileEntry[]> {
  const response = await tracedFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${dirPath}?ref=${encodeURIComponent(ref)}`,
    { headers: githubHeaders(token) },
  );
  if (!response.ok) {
    const body = await response.text();
    if (response.status === 404 && options?.allowNotFound !== false) return [];
    throw new GitHubRequestError("GitHub list directory", response.status, body);
  }
  const data = (await response.json()) as GitHubFileEntry[];
  return Array.isArray(data) ? data.filter((f) => f.type === "file" || f.type === "dir") : [];
}

/**
 * Read a file's content from a specific ref (branch/sha).
 * Returns null if file doesn't exist (404).
 * Throws on transient errors (403/429/500) to fail closed.
 */
export async function getFileContent(
  token: string,
  owner: string,
  repo: string,
  filePath: string,
  ref: string,
): Promise<string | null> {
  const response = await tracedFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`,
    { headers: { ...githubHeaders(token), Accept: "application/vnd.github.raw+json" } },
  );
  if (response.status === 404) return null; // File doesn't exist
  if (!response.ok) {
    const body = await response.text();
    throw new GitHubRequestError("GitHub get file", response.status, body);
  }
  return response.text();
}

export async function getFileSha(
  token: string,
  owner: string,
  repo: string,
  filePath: string,
  ref: string,
): Promise<string | null> {
  const response = await tracedFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`,
    { headers: githubHeaders(token) },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text();
    throw new GitHubRequestError("GitHub get file sha", response.status, body);
  }
  const data = (await response.json()) as { sha?: string };
  if (!data.sha) throw new Error(`GitHub get file sha returned no sha for ${filePath}`);
  return data.sha;
}

/**
 * Delete a file on a specific branch via the Contents API.
 */
export async function deleteFile(
  token: string,
  owner: string,
  repo: string,
  params: { path: string; message: string; sha: string; branch: string },
): Promise<void> {
  const response = await tracedFetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${params.path}`, {
    method: "DELETE",
    headers: githubHeaders(token),
    body: JSON.stringify({
      message: params.message,
      sha: params.sha,
      branch: params.branch,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub delete file failed (${response.status}): ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Git refs
// ---------------------------------------------------------------------------

/**
 * Get the SHA of a git ref (e.g. "heads/main").
 */
export async function getRefSha(token: string, owner: string, repo: string, ref: string): Promise<string> {
  const response = await tracedFetch(`${GITHUB_API}/repos/${owner}/${repo}/git/ref/${ref}`, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub get ref failed (${response.status}): ${body}`);
  }
  const data = (await response.json()) as { object: { sha: string } };
  return data.object.sha;
}

/**
 * Create or reset a git ref (branch).
 * If the ref already exists, force-updates it to the given SHA so retries
 * start from a clean base instead of reusing stale commits.
 */
export async function createOrResetRef(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  sha: string,
): Promise<void> {
  const createResponse = await tracedFetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({ ref, sha }),
  });
  if (createResponse.ok) return;

  const body = await createResponse.text();
  if (createResponse.status === 422 && body.includes("Reference already exists")) {
    // Force-update the existing ref to the new SHA
    const shortRef = ref.replace(/^refs\//, "");
    const updateResponse = await tracedFetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs/${shortRef}`, {
      method: "PATCH",
      headers: githubHeaders(token),
      body: JSON.stringify({ sha, force: true }),
    });
    if (!updateResponse.ok) {
      const updateBody = await updateResponse.text();
      throw new Error(`GitHub update ref failed (${updateResponse.status}): ${updateBody}`);
    }
    return;
  }
  throw new Error(`GitHub create ref failed (${createResponse.status}): ${body}`);
}

export async function getCommitTreeSha(token: string, owner: string, repo: string, commitSha: string): Promise<string> {
  const response = await tracedFetch(`${GITHUB_API}/repos/${owner}/${repo}/git/commits/${commitSha}`, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub get commit failed (${response.status}): ${body}`);
  }
  const data = (await response.json()) as { tree?: { sha?: string } };
  if (!data.tree?.sha) throw new Error(`GitHub get commit returned no tree sha for ${commitSha}`);
  return data.tree.sha;
}

export type GitTreeEntryInput =
  | { path: string; mode: "100644"; type: "blob"; content: string; sha?: never }
  | { path: string; mode: "100644"; type: "blob"; sha: null; content?: never };

export async function createTree(
  token: string,
  owner: string,
  repo: string,
  input: { baseTree: string; tree: readonly GitTreeEntryInput[] },
): Promise<string> {
  const response = await tracedFetch(`${GITHUB_API}/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({
      base_tree: input.baseTree,
      tree: input.tree,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub create tree failed (${response.status}): ${body}`);
  }
  const data = (await response.json()) as { sha?: string };
  if (!data.sha) throw new Error("GitHub create tree returned no sha");
  return data.sha;
}

export async function createCommit(
  token: string,
  owner: string,
  repo: string,
  input: { message: string; tree: string; parents: readonly string[] },
): Promise<string> {
  const response = await tracedFetch(`${GITHUB_API}/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({
      message: input.message,
      tree: input.tree,
      parents: input.parents,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub create commit failed (${response.status}): ${body}`);
  }
  const data = (await response.json()) as { sha?: string };
  if (!data.sha) throw new Error("GitHub create commit returned no sha");
  return data.sha;
}

export async function updateRef(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  input: { sha: string; force?: boolean },
): Promise<void> {
  const response = await tracedFetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs/${ref}`, {
    method: "PATCH",
    headers: githubHeaders(token),
    body: JSON.stringify({ sha: input.sha, force: input.force ?? false }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub update ref failed (${response.status}): ${body}`);
  }
}

/**
 * Delete a git ref (branch). Silently succeeds if the ref doesn't exist.
 */
export async function deleteRef(token: string, owner: string, repo: string, ref: string): Promise<void> {
  const response = await tracedFetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs/${ref}`, {
    method: "DELETE",
    headers: githubHeaders(token),
  });
  if (!response.ok && response.status !== 422) {
    // 422 = ref doesn't exist, which is fine
    const body = await response.text();
    throw new Error(`GitHub delete ref failed (${response.status}): ${body}`);
  }
}

/**
 * Create or update a file via the GitHub Contents API.
 * This creates a commit automatically on the specified branch.
 */
export async function createOrUpdateFile(
  token: string,
  owner: string,
  repo: string,
  params: {
    path: string;
    message: string;
    content: string; // Raw content (will be base64-encoded)
    branch: string;
  },
): Promise<void> {
  // Check if file already exists to get its SHA (needed for update)
  let existingSha: string | undefined;
  const getResponse = await tracedFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${params.path}?ref=${encodeURIComponent(params.branch)}`,
    { headers: githubHeaders(token) },
  );
  if (getResponse.ok) {
    const existing = (await getResponse.json()) as { sha: string };
    existingSha = existing.sha;
  }

  const body: Record<string, string> = {
    message: params.message,
    content: utf8ToBase64(params.content),
    branch: params.branch,
  };
  if (existingSha) {
    body.sha = existingSha;
  }

  const response = await tracedFetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${params.path}`, {
    method: "PUT",
    headers: githubHeaders(token),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub create/update file failed (${response.status}): ${errorBody}`);
  }
}

/** Encode a UTF-8 string to base64 (Workers-compatible, handles non-Latin1 chars). */
function utf8ToBase64(str: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
