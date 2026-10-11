import { describe, expect, it } from "vitest";

import { checkWorkflowRouting } from "../../apps/sandbox-bridge/src/utils/workflow-routing.js";

describe("checkWorkflowRouting", () => {
  it("returns null for non-bash tools", () => {
    expect(checkWorkflowRouting("apply_patch", { patch: "irrelevant" })).toBeNull();
  });

  it("returns null when the bash command is allowed", () => {
    expect(checkWorkflowRouting("bash", { command: "ls -la" })).toBeNull();
  });

  it("blocks git push via the bash parser", () => {
    const violation = checkWorkflowRouting("bash", { command: "git push origin main" });
    expect(violation).not.toBeNull();
    expect(violation?.blockedCommands.some((d) => d.actionKey === "git.push")).toBe(true);
  });

  it("blocks permanently-blocked git commands wrapped in subshell/brace/exec (ARC-1550)", () => {
    for (const command of [
      "(git commit --no-verify -m 'x')",
      "{ git commit --no-verify; }",
      "exec git commit --no-verify",
    ]) {
      const violation = checkWorkflowRouting("bash", { command });
      expect(violation, command).not.toBeNull();
      expect(
        violation?.blockedCommands.some((d) => d.actionKey === "git.commit.no_verify"),
        command,
      ).toBe(true);
      expect(
        violation?.blockedCommands.some((d) => d.reasonKey === "hook_bypass_blocked"),
        command,
      ).toBe(true);
    }
  });

  it("blocks git push wrapped in a subshell", () => {
    const violation = checkWorkflowRouting("bash", { command: "(git push origin main)" });
    expect(violation?.blockedCommands.some((d) => d.actionKey === "git.push")).toBe(true);
  });

  it("does not block command -v git introspection", () => {
    expect(checkWorkflowRouting("bash", { command: "command -v git" })).toBeNull();
  });

  it("does not enforce review-loop blocks when reviewLoopMode is off", () => {
    expect(checkWorkflowRouting("bash", { command: "gh api repos/foo/bar" })).toBeNull();
  });

  it("blocks raw gh api when reviewLoopMode is on", () => {
    const violation = checkWorkflowRouting("bash", { command: "gh api repos/foo/bar" }, { reviewLoopMode: true });
    expect(violation).not.toBeNull();
    expect(violation?.blockedCommands[0].actionKey).toBe("review_loop.gh_api");
  });

  it("allows broker-supported title-only gh pr edit when reviewLoopMode is on", () => {
    expect(
      checkWorkflowRouting("bash", { command: 'gh pr edit 123 --title "Compliant title"' }, { reviewLoopMode: true }),
    ).toBeNull();
  });

  it("blocks unsupported gh pr edit when reviewLoopMode is on and points to the broker", () => {
    const violation = checkWorkflowRouting(
      "bash",
      { command: "gh pr edit 123 --base release" },
      { reviewLoopMode: true },
    );
    expect(violation?.blockedCommands[0].actionKey).toBe("review_loop.gh_pr_edit");
    expect(violation?.blockedCommands[0].message).toContain("Cycloid brokers");
  });

  it("blocks an unsupported gh pr edit combined with a broker-supported title edit", () => {
    const violation = checkWorkflowRouting(
      "bash",
      { command: 'gh pr edit 123 --title "Compliant title" && gh pr edit 123 --base release' },
      { reviewLoopMode: true },
    );
    expect(violation?.blockedCommands[0].actionKey).toBe("review_loop.gh_pr_edit");
  });

  it("blocks gh pr review and gh issue comment when reviewLoopMode is on", () => {
    const review = checkWorkflowRouting("bash", { command: "gh pr review --approve" }, { reviewLoopMode: true });
    const comment = checkWorkflowRouting("bash", { command: "gh issue comment 5 --body hi" }, { reviewLoopMode: true });
    expect(review?.blockedCommands[0].actionKey).toBe("review_loop.gh_review_comment");
    expect(comment?.blockedCommands[0].actionKey).toBe("review_loop.gh_review_comment");
  });

  it("blocks git remote set-url when reviewLoopMode is on", () => {
    const violation = checkWorkflowRouting(
      "bash",
      { command: "git remote set-url origin https://example.com" },
      { reviewLoopMode: true },
    );
    expect(violation?.blockedCommands[0].actionKey).toBe("review_loop.git_remote_set_url");
  });

  it("blocks curl-based GitHub mutations when reviewLoopMode is on", () => {
    const violation = checkWorkflowRouting(
      "bash",
      { command: "curl -X POST https://api.github.com/repos/foo/bar/pulls -d '{}'" },
      { reviewLoopMode: true },
    );
    expect(violation?.blockedCommands[0].actionKey).toBe("review_loop.github_http_mutation");
  });

  it("does not block read-only curl to GitHub even with reviewLoopMode on", () => {
    expect(
      checkWorkflowRouting("bash", { command: "curl https://api.github.com/repos/foo/bar" }, { reviewLoopMode: true }),
    ).toBeNull();
  });
});
