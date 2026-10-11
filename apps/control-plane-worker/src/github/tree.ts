import { tracedFetch } from "../observability/wrappers";
import { assertGithubOk } from "./errors.js";
import { GITHUB_API, githubHeaders } from "./pr.js";

export type GithubTreeEntry = {
  path: string;
  type: string;
  sha?: string;
};

export type GithubRecursiveTree = {
  tree: GithubTreeEntry[];
  truncated: boolean;
};

export async function fetchRepoTreeEntries(
  token: string,
  owner: string,
  repo: string,
  treeSha: string,
): Promise<GithubRecursiveTree> {
  const res = await tracedFetch(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
    { headers: githubHeaders(token) },
    "github.fetchRepoTree",
  );
  await assertGithubOk(res, "GitHub tree fetch");
  return (await res.json()) as GithubRecursiveTree;
}

export async function fetchRepoTree(token: string, owner: string, repo: string, branch: string): Promise<string[]> {
  const data = await fetchRepoTreeEntries(token, owner, repo, branch);
  if (data.truncated) throw new Error("Repository tree too large for file autocomplete");
  return data.tree
    .filter((e) => e.type === "blob" || e.type === "tree")
    .map((e) => e.path)
    .sort();
}
