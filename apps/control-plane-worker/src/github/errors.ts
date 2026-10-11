export class GitHubRequestError extends Error {
  readonly detail: string | null;

  constructor(
    readonly operation: string,
    readonly status: number,
    detail?: string | null,
  ) {
    super(`${operation} failed (${status})${detail ? `: ${detail}` : ""}`);
    this.name = "GitHubRequestError";
    this.detail = detail ?? null;
  }
}

export async function assertGithubOk(response: Response, operation: string): Promise<void> {
  if (response.ok) return;
  throw new GitHubRequestError(operation, response.status, await response.text());
}
