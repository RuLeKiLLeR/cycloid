import { describe, expect, it, vi } from "vitest";

import { buildDynamicToolsBehavioralGuidance } from "../../apps/sandbox-bridge/src/constants/bridge";
import type { FirstPartyDynamicToolExecuteContext } from "../../apps/sandbox-bridge/src/services/first-party-dynamic-tools";
import { executeFirstPartyDynamicToolCall } from "../../apps/sandbox-bridge/src/services/first-party-dynamic-tools";
import type { execRepoGit } from "../../apps/sandbox-bridge/src/services/git/exec";
import {
  executeGitSyncDynamicToolCallWithDeps,
  GIT_SYNC_DYNAMIC_TOOL_NAME,
} from "../../apps/sandbox-bridge/src/services/git-sync-dynamic-tool";

const ENV = {
  CONTROL_PLANE_URL: "https://api.test",
  SESSION_ID: "sess-1",
  SANDBOX_AUTH_TOKEN: "sandbox-auth",
  REPO_OWNER: "acme",
  REPO_NAME: "widgets",
  BRANCH: "main",
} as const;

type ExecGit = typeof execRepoGit;

function context(extra: Partial<FirstPartyDynamicToolExecuteContext> = {}): FirstPartyDynamicToolExecuteContext {
  return { env: { ...ENV }, cwd: "/workspace/repo", ...extra };
}

function makeExecGit(responses: Record<string, string> = {}): ExecGit {
  return vi.fn(async (args: string[]) => responses[args.join(" ")] ?? "") as unknown as ExecGit;
}

function call(
  args: unknown,
  execGit: ExecGit,
  extra: Partial<FirstPartyDynamicToolExecuteContext> = {},
  recordSelfPush: (
    context: FirstPartyDynamicToolExecuteContext,
    input: { pushedHead: string; branch: string },
  ) => Promise<boolean> = vi.fn(async () => true),
) {
  return executeGitSyncDynamicToolCallWithDeps(args, context(extra), {
    execGit,
    fetchCloneToken: vi.fn(async () => "clone-token"),
    recordSelfPush,
  });
}

describe("cycloid.git_sync dynamic tool", () => {
  it("exports the expected tool name", () => {
    expect(GIT_SYNC_DYNAMIC_TOOL_NAME).toBe("git_sync");
  });

  it("is registered with shared input validation", async () => {
    await expect(
      executeFirstPartyDynamicToolCall("cycloid", "git_sync", { operation: "bad" }, context()),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "invalid_input",
    });
  });

  it("adds session-static guidance for authenticated fetch and force-with-lease recovery", () => {
    const guidance = buildDynamicToolsBehavioralGuidance(new Set(["cycloid.git_sync"]));

    expect(guidance).toContain("Use `cycloid.git_sync`");
    expect(guidance).toContain("raw `git fetch` or `git push` cannot perform");
    expect(guidance).toContain("ordinary `git fetch`");
    expect(guidance).toContain('"operation": "force_push_current_branch"');
    expect(guidance).toContain("`--force-with-lease`");
  });

  it("force-pushes only the current branch with force-with-lease", async () => {
    const execGit = makeExecGit({
      "branch --show-current": "feature/fix-conflict\n",
      "rev-parse --verify refs/remotes/origin/feature/fix-conflict": "def456\n",
      "rev-parse --verify HEAD": "fedcba\n",
      "merge-base --is-ancestor def456 HEAD": "",
    });

    await expect(call({ operation: "force_push_current_branch" }, execGit)).resolves.toEqual({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            ok: true,
            operation: "force_push_current_branch",
            baseBranch: "main",
            branch: "feature/fix-conflict",
            remoteHeadBefore: "def456",
            pushedHead: "fedcba",
            pushRecorded: true,
          }),
        },
      ],
    });

    expect(execGit).toHaveBeenCalledWith(
      ["fetch", "origin", "+refs/heads/feature/fix-conflict:refs/remotes/origin/feature/fix-conflict"],
      expect.objectContaining({ cwd: "/workspace/repo" }),
    );
    expect(execGit).toHaveBeenCalledWith(
      [
        "push",
        "--no-verify",
        "-u",
        "origin",
        "HEAD:refs/heads/feature/fix-conflict",
        "--force-with-lease=refs/heads/feature/fix-conflict:def456",
      ],
      expect.objectContaining({ cwd: "/workspace/repo" }),
    );
    expect(execGit).toHaveBeenCalledWith(
      ["update-ref", "refs/remotes/origin/feature/fix-conflict", "refs/heads/feature/fix-conflict"],
      expect.objectContaining({ cwd: "/workspace/repo" }),
    );
  });

  it("records the self-push (head about to be pushed) BEFORE the actual git push", async () => {
    const order: string[] = [];
    const execGit = vi.fn(async (args: string[]) => {
      if (args[0] === "push") order.push("push");
      const responses: Record<string, string> = {
        "branch --show-current": "feature/fix-conflict\n",
        "rev-parse --verify refs/remotes/origin/feature/fix-conflict": "def456\n",
        "rev-parse --verify HEAD": "fedcba\n",
        "merge-base --is-ancestor def456 HEAD": "",
      };
      return responses[args.join(" ")] ?? "";
    }) as unknown as ExecGit;
    const recordSelfPush = vi.fn(async (_context, input: { pushedHead: string; branch: string }) => {
      order.push("record");
      expect(input).toEqual({ pushedHead: "fedcba", branch: "feature/fix-conflict" });
      return true;
    });

    const result = await call({ operation: "force_push_current_branch" }, execGit, {}, recordSelfPush);

    expect(result.success).toBe(true);
    expect(recordSelfPush).toHaveBeenCalledTimes(1);
    // The record must land before the push so the synchronize webhook can never beat it.
    expect(order).toEqual(["record", "push"]);
  });

  it("still force-pushes when the self-push record fails (record is best-effort, surfaced in the payload)", async () => {
    const execGit = makeExecGit({
      "branch --show-current": "feature/fix-conflict\n",
      "rev-parse --verify refs/remotes/origin/feature/fix-conflict": "def456\n",
      "rev-parse --verify HEAD": "fedcba\n",
      "merge-base --is-ancestor def456 HEAD": "",
    });
    const recordSelfPush = vi.fn(async () => false);

    const result = await call({ operation: "force_push_current_branch" }, execGit, {}, recordSelfPush);

    expect(result.success).toBe(true);
    expect(result.contentItems?.[0]?.text).toContain('"pushRecorded":false');
    expect(execGit).toHaveBeenCalledWith(
      expect.arrayContaining(["push"]),
      expect.objectContaining({ cwd: "/workspace/repo" }),
    );
  });

  it("refuses to force-push the base branch", async () => {
    const execGit = makeExecGit({
      "branch --show-current": "main\n",
    });

    await expect(call({ operation: "force_push_current_branch" }, execGit)).resolves.toMatchObject({
      success: false,
      errorCode: "blocked",
      contentItems: [{ text: "Git sync failed: Refusing to force-push protected branch 'main'." }],
    });
    expect(execGit).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]), expect.anything());
    expect(execGit).toHaveBeenLastCalledWith(
      ["remote", "set-url", "origin", "https://github.com/acme/widgets.git"],
      expect.objectContaining({ cwd: "/workspace/repo" }),
    );
  });

  it("uses the trusted session base branch for protected-branch refusal", async () => {
    const execGit = makeExecGit({
      "branch --show-current": "develop\n",
    });

    await expect(
      call({ operation: "force_push_current_branch", baseBranch: "main" }, execGit, {
        env: { ...ENV, BRANCH: "develop" },
      }),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "blocked",
      contentItems: [{ text: "Git sync failed: Refusing to force-push protected branch 'develop'." }],
    });
    expect(execGit).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]), expect.anything());
  });

  it("refuses to force-push when the fetched remote head is not in local HEAD history", async () => {
    const execGit = vi.fn(async (args: string[]) => {
      const key = args.join(" ");
      if (key === "branch --show-current") return "feature/fix-conflict\n";
      if (key === "rev-parse --verify refs/remotes/origin/feature/fix-conflict") return "unseen123\n";
      if (key === "merge-base --is-ancestor unseen123 HEAD") throw new Error("not an ancestor");
      return "";
    }) as unknown as ExecGit;

    await expect(call({ operation: "force_push_current_branch" }, execGit)).resolves.toMatchObject({
      success: false,
      errorCode: "blocked",
      contentItems: [
        {
          text: "Git sync failed: Refusing to force-push because the remote branch contains commits not present in local HEAD.",
        },
      ],
    });
    expect(execGit).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]), expect.anything());
  });

  it("preserves error classification when token acquisition fails before a token exists", async () => {
    const execGit = makeExecGit();

    const result = await executeGitSyncDynamicToolCallWithDeps({ operation: "force_push_current_branch" }, context(), {
      execGit,
      fetchCloneToken: vi.fn(async () => {
        throw new Error("Git sync is not configured for this session.");
      }),
    });

    expect(result).toMatchObject({
      success: false,
      errorCode: "not_connected",
      contentItems: [{ text: "Git sync failed: Git sync is not configured for this session." }],
    });
  });
});
