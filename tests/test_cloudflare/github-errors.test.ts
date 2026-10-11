import { describe, expect, it } from "vitest";

import { assertGithubOk, GitHubRequestError } from "../../apps/control-plane-worker/src/github/errors";

describe("assertGithubOk", () => {
  it("resolves for successful responses", async () => {
    await expect(assertGithubOk(new Response("ok", { status: 200 }), "GitHub test")).resolves.toBeUndefined();
  });

  it("throws GitHubRequestError with status, label, and body detail", async () => {
    await expect(
      assertGithubOk(new Response("bad credentials", { status: 401 }), "GitHub repo lookup"),
    ).rejects.toThrow(GitHubRequestError);

    await expect(
      assertGithubOk(new Response("bad credentials", { status: 401 }), "GitHub repo lookup"),
    ).rejects.toMatchObject({
      operation: "GitHub repo lookup",
      status: 401,
      detail: "bad credentials",
      message: "GitHub repo lookup failed (401): bad credentials",
    });
  });
});
