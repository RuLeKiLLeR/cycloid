import { tracedFetch } from "../observability/wrappers";
import type { Env } from "../types";
import { assertGithubOk } from "./errors";
import { createInstallationToken } from "./octokit";
import { GITHUB_API, githubHeaders } from "./pr";

export type GithubIssueCommentReactionContent =
  "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";

export const GITHUB_QA_STARTED_REACTION: GithubIssueCommentReactionContent = "eyes";
export const GITHUB_QA_FINISHED_REACTION: GithubIssueCommentReactionContent = "+1";
export const GITHUB_REVIEW_ACK_REACTION: GithubIssueCommentReactionContent = "eyes";

export async function postIssueComment(
  env: Env,
  installationId: number,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<number> {
  const token = await createInstallationToken(env, installationId);
  const response = await tracedFetch(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: githubHeaders(token),
      body: JSON.stringify({ body }),
    },
    "github.postIssueComment",
  );

  await assertGithubOk(response, "GitHub issue comment creation");

  const data = (await response.json()) as { id: number };
  return data.id;
}

export async function postIssueCommentReaction(
  env: Env,
  installationId: number,
  owner: string,
  repo: string,
  commentId: number,
  content: GithubIssueCommentReactionContent,
): Promise<void> {
  const token = await createInstallationToken(env, installationId);
  const response = await tracedFetch(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}/reactions`,
    {
      method: "POST",
      headers: githubHeaders(token),
      body: JSON.stringify({ content }),
    },
    "github.postIssueCommentReaction",
  );

  await assertGithubOk(response, "GitHub issue comment reaction creation");
}

export async function postReviewCommentReaction(
  env: Env,
  installationId: number,
  owner: string,
  repo: string,
  commentId: number,
  content: GithubIssueCommentReactionContent,
): Promise<void> {
  const token = await createInstallationToken(env, installationId);
  const response = await tracedFetch(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/comments/${commentId}/reactions`,
    {
      method: "POST",
      headers: githubHeaders(token),
      body: JSON.stringify({ content }),
    },
    "github.postReviewCommentReaction",
  );

  await assertGithubOk(response, "GitHub review comment reaction creation");
}
