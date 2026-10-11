import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkToolProtection,
  checkToolSafety,
  extractPaths,
  isProtectedPath,
  isToolAllowedInReviewLoopSession,
} from "../../apps/sandbox-bridge/src/utils/protection.js";
import { PLAN_AGENT_NAME } from "../../shared/agent/constants.js";

describe("isProtectedPath", () => {
  it("blocks .env files", () => {
    expect(isProtectedPath(".env")).toBe(true);
    expect(isProtectedPath(".env.local")).toBe(true);
    expect(isProtectedPath(".env.production")).toBe(true);
    expect(isProtectedPath("/app/.env")).toBe(true);
    expect(isProtectedPath("path/to/.env.test")).toBe(true);
  });

  it("blocks .ssh directory paths", () => {
    expect(isProtectedPath(".ssh/id_rsa")).toBe(true);
    expect(isProtectedPath("/home/user/.ssh/config")).toBe(true);
    expect(isProtectedPath(".ssh/authorized_keys")).toBe(true);
  });

  it("blocks .gnupg directory paths", () => {
    expect(isProtectedPath(".gnupg/secring.gpg")).toBe(true);
    expect(isProtectedPath("/home/user/.gnupg/trustdb.gpg")).toBe(true);
  });

  it("blocks .aws/credentials", () => {
    expect(isProtectedPath(".aws/credentials")).toBe(true);
    expect(isProtectedPath("/home/user/.aws/credentials")).toBe(true);
  });

  it("blocks SSH key files", () => {
    expect(isProtectedPath("id_rsa")).toBe(true);
    expect(isProtectedPath("id_ed25519")).toBe(true);
    expect(isProtectedPath("/home/user/.ssh/id_rsa")).toBe(true);
    expect(isProtectedPath("path/id_ed25519")).toBe(true);
  });

  it("blocks certificate and key files", () => {
    expect(isProtectedPath("server.pem")).toBe(true);
    expect(isProtectedPath("private.key")).toBe(true);
    expect(isProtectedPath("/etc/ssl/server.pem")).toBe(true);
  });

  it("blocks bare hidden-file .key and .pem (no stem before the dot)", () => {
    expect(isProtectedPath(".key")).toBe(true);
    expect(isProtectedPath(".pem")).toBe(true);
    expect(isProtectedPath("/etc/.key")).toBe(true);
  });

  it("blocks secrets and credentials files", () => {
    expect(isProtectedPath("secrets.json")).toBe(true);
    expect(isProtectedPath("secrets.yaml")).toBe(true);
    expect(isProtectedPath("secrets.yml")).toBe(true);
    expect(isProtectedPath("credentials.json")).toBe(true);
    expect(isProtectedPath("credentials.yaml")).toBe(true);
  });

  it("blocks .npmrc and .pypirc", () => {
    expect(isProtectedPath(".npmrc")).toBe(true);
    expect(isProtectedPath(".pypirc")).toBe(true);
    expect(isProtectedPath("/home/user/.npmrc")).toBe(true);
  });

  it("allows safe paths", () => {
    expect(isProtectedPath("src/index.ts")).toBe(false);
    expect(isProtectedPath("README.md")).toBe(false);
    expect(isProtectedPath("package.json")).toBe(false);
    expect(isProtectedPath("src/environment.ts")).toBe(false);
  });

  it("handles Windows-style paths", () => {
    expect(isProtectedPath("C:\\Users\\user\\.ssh\\id_rsa")).toBe(true);
    expect(isProtectedPath("C:\\Users\\user\\.env")).toBe(true);
  });

  // ARC-843: .env pattern must anchor to start-of-string or path separator,
  // so JS property accessors like process.env.X aren't matched as env files.
  it("does not block JS property accessors that contain .env", () => {
    expect(isProtectedPath("process.env.SCREENSHOT")).toBe(false);
    expect(isProtectedPath("process.env")).toBe(false);
    expect(isProtectedPath("config.env.dev")).toBe(false);
    expect(isProtectedPath("foo.env")).toBe(false);
    expect(isProtectedPath("foo.env.bar")).toBe(false);
  });

  it("allows .env template variants that are safe to commit", () => {
    expect(isProtectedPath(".env.example")).toBe(false);
    expect(isProtectedPath(".env.template")).toBe(false);
    expect(isProtectedPath(".env.sample")).toBe(false);
    expect(isProtectedPath("/app/.env.example")).toBe(false);
  });
});

describe("extractPaths", () => {
  it("extracts paths from apply_patch metadata and patch bodies", () => {
    expect(
      extractPaths("apply_patch", {
        path: "/app/.env, /workspace/repo/src/index.ts",
        patch: "*** Update File: secrets.json\n@@\n-old\n+new\n",
      }),
    ).toEqual(["/app/.env", "/workspace/repo/src/index.ts", "secrets.json"]);
  });

  it("extracts generic path fields from non-apply_patch tools", () => {
    expect(extractPaths("read", { file_path: "/app/.env" })).toEqual(["/app/.env"]);
    expect(extractPaths("custom_tool", { path: ["/home/user/.ssh/id_rsa", "src/index.ts"] })).toEqual([
      "/home/user/.ssh/id_rsa",
      "src/index.ts",
    ]);
  });

  it("extracts paths from bash commands", () => {
    const paths = extractPaths("bash", { command: "cat /home/user/.ssh/id_rsa" });
    expect(paths).toContain("/home/user/.ssh/id_rsa");
  });

  it("extracts bash redirection targets without spaces", () => {
    const paths = extractPaths("bash", {
      command:
        "echo x >../other-repo/leak.txt && echo y 2>/tmp/errors.txt && echo z >&2 && echo a >|/tmp/force.txt && : <>/tmp/rw.txt && echo b >&/tmp/all.txt && unknown >logfile",
    });

    expect(paths).toContain("../other-repo/leak.txt");
    expect(paths).toContain("/tmp/errors.txt");
    expect(paths).toContain("/tmp/force.txt");
    expect(paths).toContain("/tmp/rw.txt");
    expect(paths).toContain("/tmp/all.txt");
    expect(paths).toContain("logfile");
    expect(paths).not.toContain(">../other-repo/leak.txt");
    expect(paths).not.toContain(">&2");
  });

  it("returns empty array for tools without paths", () => {
    expect(extractPaths("unknown_tool", {})).toEqual([]);
  });
});

describe("checkToolProtection", () => {
  it("returns protected path when found", () => {
    expect(checkToolProtection("apply_patch", { path: ".env" })).toBe(".env");
    expect(checkToolProtection("apply_patch", { patch: "*** Update File: .ssh/config\n@@\n-old\n+new\n" })).toBe(
      ".ssh/config",
    );
    expect(checkToolProtection("read", { file_path: "/home/user/.ssh/id_rsa" })).toBe("/home/user/.ssh/id_rsa");
  });

  it("blocks bash character-class variants that could expand to protected paths", () => {
    for (const command of [
      "cat .[]e]nv",
      "cat .[]e]n[]v]",
      "cat .[!x]nv",
      "cat .[^x]nv",
      "cat .[[:alpha:]]nv",
      "cat ~/.[]s]sh/id_[]r]sa",
    ]) {
      const path = command.slice(4);
      expect(checkToolProtection("bash", { command }), command).toBe(path);
    }
  });

  it("returns null for safe paths", () => {
    expect(checkToolProtection("apply_patch", { path: "src/index.ts" })).toBeNull();
    expect(checkToolProtection("apply_patch", { patch: "*** Update File: package.json\n@@\n-old\n+new\n" })).toBeNull();
  });
});

describe("checkToolSafety", () => {
  it("allows read-only bash in plan mode", () => {
    expect(
      checkToolSafety(
        "bash",
        { command: "git status --short && rg planMode apps/control-plane-worker/src | head" },
        { agentProfile: PLAN_AGENT_NAME },
      ),
    ).toBeNull();
  });

  it("unwraps `bash -lc` wrappers so read-only research is allowed in plan mode", () => {
    // Codex runs every shell call as `bash -lc "<inner>"`. Without unwrapping,
    // the guard judges the `/bin/bash` wrapper (never allowlisted) and blocks
    // 100% of commands — the plan agent could read nothing.
    for (const command of [
      `/bin/bash -lc "cat package.json"`,
      `/bin/bash -lc "ls -la"`,
      `/bin/bash -lc "sed -n '1,220p' README.md"`,
      `bash -lc "git status --short"`,
      `/bin/bash -lc "git branch"`,
      `/bin/bash -lc "git remote -v"`,
    ]) {
      expect(checkToolSafety("bash", { command }, { agentProfile: PLAN_AGENT_NAME })).toBeNull();
    }
  });

  it("allows quoted regex metacharacters (alternation / anchors) in plan mode", () => {
    for (const command of [
      "rg -n 'dev:full|/api/health' package.json README.md",
      `/bin/bash -lc "rg -n 'export$' src"`,
      "grep -E 'foo|bar' file",
    ]) {
      expect(checkToolSafety("bash", { command }, { agentProfile: PLAN_AGENT_NAME })).toBeNull();
    }
  });

  it("blocks side effects smuggled inside a `bash -lc` wrapper in plan mode", () => {
    for (const command of [
      `/bin/bash -lc "npm install"`,
      `/bin/bash -lc "sed -i 's/a/b/' f"`,
      `/bin/bash -lc "cat x > y"`,
      `/bin/bash -lc "echo $(rm -rf x)"`,
      `/bin/bash -lc "git branch -D main"`,
      `/bin/bash -lc "git remote add evil https://x/r.git"`,
      `/bin/bash -lc "ls && rm -rf x"`,
    ]) {
      expect(checkToolSafety("bash", { command }, { agentProfile: PLAN_AGENT_NAME })).toMatchObject({
        kind: "blocked_tool",
        reasonKey: "plan_mode_read_only",
      });
    }
  });

  it("blocks mutating bash in plan mode", () => {
    const violation = checkToolSafety(
      "bash",
      { command: "npm test && git status --short" },
      { agentProfile: PLAN_AGENT_NAME },
    );

    expect(violation).toMatchObject({
      kind: "blocked_tool",
      reasonKey: "plan_mode_read_only",
      errorCode: "policy_block",
    });
  });

  it("blocks a multi-line bash whose first line is read-only in plan mode", () => {
    // The whitelist is start-anchored; without newline splitting `ls` would
    // shield `npm install` / `sed -i` on the following lines.
    expect(
      checkToolSafety(
        "bash",
        { command: "ls\nnpm install\nsed -i 's/x/y/' src/app.ts" },
        { agentProfile: PLAN_AGENT_NAME },
      ),
    ).toMatchObject({ kind: "blocked_tool", reasonKey: "plan_mode_read_only" });
  });

  it("blocks in-place / deleting / executing forms of allowlisted commands in plan mode", () => {
    for (const command of [
      "sed -i 's/a/b/' src/app.ts",
      "sed -i.bak 's/a/b/' src/app.ts",
      "find . -name '*.ts' -delete",
      "find . -type f -exec rm {} +",
    ]) {
      expect(checkToolSafety("bash", { command }, { agentProfile: PLAN_AGENT_NAME })).toMatchObject({
        kind: "blocked_tool",
        reasonKey: "plan_mode_read_only",
      });
    }
  });

  it("still allows read-only find/sed research in plan mode", () => {
    expect(
      checkToolSafety("bash", { command: "find . -name '*.ts' -type f" }, { agentProfile: PLAN_AGENT_NAME }),
    ).toBeNull();
    expect(
      checkToolSafety("bash", { command: "sed -n '1,40p' src/app.ts" }, { agentProfile: PLAN_AGENT_NAME }),
    ).toBeNull();
  });

  it("lets Codex plan bash with a read-only OS sandbox pass non-allowlisted reads and writes through", () => {
    const codexPlan = { agentProfile: PLAN_AGENT_NAME, hasReadOnlyOsSandbox: true };

    for (const command of [
      "git diff -- README.md",
      "tree -L 2",
      "awk '{print $1}' README.md",
      "node -e \"require('fs').readFileSync('README.md')\"",
      "echo x > README.md",
    ]) {
      expect(checkToolSafety("bash", { command }, codexPlan), command).toBeNull();
    }
  });

  it("keeps the bash allowlist when the caller lacks a read-only OS sandbox", () => {
    for (const options of [
      { agentProfile: PLAN_AGENT_NAME },
      { agentProfile: PLAN_AGENT_NAME, hasReadOnlyOsSandbox: false },
    ]) {
      expect(checkToolSafety("bash", { command: "git diff -- README.md" }, options)).toBeNull();
      expect(checkToolSafety("bash", { command: "tree -L 2" }, options)).toMatchObject({
        kind: "blocked_tool",
        reasonKey: "plan_mode_read_only",
      });
      expect(checkToolSafety("bash", { command: "echo x > README.md" }, options)).toMatchObject({
        kind: "blocked_tool",
        reasonKey: "plan_mode_read_only",
      });
    }
  });

  it("blocks protected reads hidden in interpreters even with a read-only OS sandbox", () => {
    for (const command of [
      "node -e \"require('fs').readFileSync('.env')\"",
      "node -e \"console.log(require('fs').readFileSync('.'+'env','utf8'))\"",
      "python -c \"open('/home/user/.ssh/id_rsa').read()\"",
      "awk 'BEGIN { while ((getline < \".env\") > 0) print }'",
      'bash -lc "bash -lc \\"node -e \'require(\\\\\\"fs\\\\\\").readFileSync(\\\\\\".env\\\\\\").toString()\'\\""',
      "cat .e*",
    ]) {
      expect(
        checkToolSafety("bash", { command }, { agentProfile: PLAN_AGENT_NAME, hasReadOnlyOsSandbox: true }),
        command,
      ).toMatchObject({
        kind: "blocked_tool",
        reasonKey: "plan_mode_read_only",
      });
    }
  });

  it("blocks bash character-class protected-path variants with a read-only OS sandbox", () => {
    const codexPlan = { agentProfile: PLAN_AGENT_NAME, hasReadOnlyOsSandbox: true };

    for (const command of [
      "cat .[]e]nv",
      "cat .[]e]n[]v]",
      "cat .[!x]nv",
      "cat .[^x]nv",
      "cat .[[:alpha:]]nv",
      "cat ~/.[]s]sh/id_[]r]sa",
    ]) {
      expect(checkToolSafety("bash", { command }, codexPlan), command).toMatchObject({
        kind: "protected_path",
      });
    }
  });

  it("allows awk regex programs that only mention protected-looking extensions", () => {
    const codexPlan = { agentProfile: PLAN_AGENT_NAME, hasReadOnlyOsSandbox: true };

    expect(checkToolSafety("bash", { command: "awk '{if (/\\.key/) print}' README.md" }, codexPlan)).toBeNull();
    expect(checkToolSafety("bash", { command: "awk '/\\.pem/{print}' README.md" }, codexPlan)).toBeNull();
  });

  it("blocks invalid protected path globs without throwing", () => {
    const codexPlan = { agentProfile: PLAN_AGENT_NAME, hasReadOnlyOsSandbox: true };

    // A balanced but JS-invalid class like `[nz-a]` (out-of-order range)
    // throws in JS but bash still globs `.e[nz-a]v` -> `.env`, so it must be
    // blocked, not skipped.
    for (const command of ["cat .e[nz-a]v", "head .e[nz-a]v"]) {
      expect(checkToolSafety("bash", { command }, codexPlan), command).toMatchObject({
        kind: "protected_path",
      });
    }

    // Balanced, JS-valid character-class globs still glob-match protected paths.
    expect(checkToolSafety("bash", { command: "cat .en[v]" }, codexPlan)).toMatchObject({
      kind: "protected_path",
    });

    // A JS-valid class that cannot match any protected candidate is still
    // allowed - fail-closed is scoped to unconvertible components, not every
    // bracket regex.
    expect(checkToolSafety("bash", { command: "rg -n '[0-9]+' src" }, codexPlan)).toBeNull();
  });

  it("allows regex/search args that contain bracket syntax but are not file paths", () => {
    const codexPlan = { agentProfile: PLAN_AGENT_NAME, hasReadOnlyOsSandbox: true };

    for (const command of ["rg -n '([^/]+)' src", "grep -E 'clamp\\(([^/)]*)/' -r apps"]) {
      expect(checkToolSafety("bash", { command }, codexPlan), command).toBeNull();
    }
  });

  it("blocks protected file-selection globs passed via search glob flags", () => {
    const codexPlan = { agentProfile: PLAN_AGENT_NAME, hasReadOnlyOsSandbox: true };

    for (const command of [
      "rg secret -g '.[!x]nv' .",
      "rg secret --glob=.[]e]nv .",
      "rg secret --glob='.[[:alpha:]]nv' .",
    ]) {
      expect(checkToolSafety("bash", { command }, codexPlan), command).toMatchObject({
        kind: "blocked_tool",
        reasonKey: "plan_mode_read_only",
      });
    }
  });

  it("allows safe file-selection globs passed via search glob flags", () => {
    const codexPlan = { agentProfile: PLAN_AGENT_NAME, hasReadOnlyOsSandbox: true };

    expect(checkToolSafety("bash", { command: "rg -n '([^/]+)' -g 'src/*.ts' ." }, codexPlan)).toBeNull();
  });

  it("fails closed on a single call instead of throwing when a safety check errors internally", () => {
    const violation = checkToolSafety(
      "sometool",
      {},
      {
        agentProfile: PLAN_AGENT_NAME,
        getPlanModeToolDisposition: () => {
          throw new Error("boom");
        },
      },
    );
    expect(violation).toMatchObject({
      kind: "blocked_tool",
      tool: "sometool",
      reasonKey: "tool_safety_internal_error",
    });
    expect(violation && violation.kind === "blocked_tool" ? violation.message : "").toContain("boom");
  });

  it("blocks mutating git branch / remote in plan mode", () => {
    for (const command of ["git branch -D main", "git branch tmp", "git remote add evil https://x.example/r.git"]) {
      expect(checkToolSafety("bash", { command }, { agentProfile: PLAN_AGENT_NAME })).toMatchObject({
        kind: "blocked_tool",
        reasonKey: "plan_mode_read_only",
      });
    }
  });

  it("blocks edit and side-effecting tools in plan mode", () => {
    expect(
      checkToolSafety(
        "apply_patch",
        { patch: "*** Begin Patch\n*** End Patch\n" },
        {
          agentProfile: PLAN_AGENT_NAME,
        },
      ),
    ).toMatchObject({
      kind: "blocked_tool",
      reasonKey: "plan_mode_read_only",
    });
    expect(
      checkToolSafety(
        "cycloid.spawn_child_session",
        { prompt: "check this" },
        {
          agentProfile: PLAN_AGENT_NAME,
        },
      ),
    ).toMatchObject({
      kind: "blocked_tool",
      reasonKey: "plan_mode_read_only",
    });
    expect(
      checkToolSafety(
        "AskUserQuestion",
        { question: "continue?" },
        {
          agentProfile: PLAN_AGENT_NAME,
        },
      ),
    ).toMatchObject({
      kind: "blocked_tool",
      reasonKey: "plan_mode_read_only",
    });
  });

  it("allows bulk git staging commands", () => {
    expect(checkToolSafety("bash", { command: "git add -A" })).toBeNull();
    expect(checkToolSafety("bash", { command: "git add --all" })).toBeNull();
    expect(checkToolSafety("bash", { command: "git add ." })).toBeNull();
  });

  it("still blocks protected paths in git staging commands", () => {
    expect(checkToolSafety("bash", { command: "git add .env" })).toEqual({
      kind: "protected_path",
      path: ".env",
      errorCode: "policy_block",
      message: 'Policy block: protected path ".env"',
    });
  });

  it("blocks protected paths in bash commands", () => {
    expect(checkToolSafety("bash", { command: "cat /home/user/.ssh/id_rsa" })).toEqual({
      kind: "protected_path",
      path: "/home/user/.ssh/id_rsa",
      errorCode: "policy_block",
      message: 'Policy block: protected path "/home/user/.ssh/id_rsa"',
    });
  });

  it("blocks symlinked paths that resolve to protected targets", () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "arca-protect-symlink-"));
    try {
      const sshDir = path.join(tmpRoot, ".ssh");
      mkdirSync(sshDir, { recursive: true });
      const target = path.join(sshDir, "id_rsa");
      writeFileSync(target, "secret");

      const linkDir = path.join(tmpRoot, "config");
      mkdirSync(linkDir, { recursive: true });
      const linkPath = path.join(linkDir, "auth.json");
      symlinkSync(target, linkPath);

      const resolved = realpathSync(linkPath);
      const violation = checkToolSafety("bash", { command: `cat ${linkPath}` });
      expect(violation?.kind).toBe("protected_path");
      if (!violation || violation.kind !== "protected_path") throw new Error("expected protected_path violation");
      expect(violation.path).toBe(resolved);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("blocks relative symlinked paths using worktreeRoot for resolution", () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "arca-protect-symlink-rel-"));
    try {
      const sshDir = path.join(tmpRoot, ".ssh");
      mkdirSync(sshDir, { recursive: true });
      const target = path.join(sshDir, "id_rsa");
      writeFileSync(target, "secret");

      const linkDir = path.join(tmpRoot, "config");
      mkdirSync(linkDir, { recursive: true });
      const linkPath = path.join(linkDir, "auth.json");
      symlinkSync(target, linkPath);

      const resolved = realpathSync(linkPath);
      const violation = checkToolSafety("bash", { command: "cat config/auth.json" }, { worktreeRoot: tmpRoot });
      expect(violation?.kind).toBe("protected_path");
      if (!violation || violation.kind !== "protected_path") throw new Error("expected protected_path violation");
      expect(violation.path).toBe(resolved);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("blocks dangerous bash commands with normalized details", () => {
    const violation = checkToolSafety("bash", { command: "git checkout -b feature/test" });
    expect(violation?.kind).toBe("blocked_command");
    if (!violation || violation.kind !== "blocked_command") {
      throw new Error("expected blocked command");
    }
    expect(violation.blockedCommands[0]).toMatchObject({
      actionKey: "git.create_branch",
      reasonKey: "handled_automatically",
    });
  });

  it("blocks managed PR commands after a heredoc body", () => {
    const violation = checkToolSafety("bash", {
      command: `pr_body=$(mktemp); cat > "$pr_body" <<E'OF'
## Scope
EOF
gh pr create --repo owner/repo --title "Fix bug" --body-file "$pr_body"`,
    });

    expect(violation?.kind).toBe("blocked_command");
    if (!violation || violation.kind !== "blocked_command") {
      throw new Error("expected blocked command");
    }
    expect(violation.blockedCommands[0]).toMatchObject({
      actionKey: "gh.pr.create",
      reasonKey: "handled_automatically",
    });
  });

  it("blocks managed PR commands after a herestring", () => {
    const violation = checkToolSafety("bash", {
      command: `cat <<<'NEVERCLOSED'
gh pr create --repo owner/repo --title "Fix bug"`,
    });

    expect(violation?.kind).toBe("blocked_command");
    if (!violation || violation.kind !== "blocked_command") {
      throw new Error("expected blocked command");
    }
    expect(violation.blockedCommands[0]).toMatchObject({
      actionKey: "gh.pr.create",
      reasonKey: "handled_automatically",
    });
  });

  it("blocks broad GitHub mutation escape hatches only in review-loop mode", () => {
    expect(checkToolSafety("bash", { command: "gh api repos/acme/repo/pulls/1/comments" })).toBeNull();

    const ghViolation = checkToolSafety(
      "bash",
      { command: "gh api repos/acme/repo/pulls/1/comments" },
      { reviewLoopMode: true, worktreeRoot: "/workspace/repo" },
    );
    expect(ghViolation?.kind).toBe("blocked_command");
    if (!ghViolation || ghViolation.kind !== "blocked_command") throw new Error("expected gh api block");
    expect(ghViolation.blockedCommands[0]).toMatchObject({
      actionKey: "review_loop.gh_api",
      reasonKey: "review_loop_mutation_blocked",
    });

    expect(checkToolSafety("bash", { command: "gh pr comment 1 --body hi" })).toBeNull();

    // Safe close and title-only edit operations are brokered by the sandbox
    // wrapper; unsupported metadata changes remain blocked by the wrapper.
    const globalPrEdit = checkToolSafety("bash", { command: "gh pr edit 1 --base main" });
    expect(globalPrEdit).toBeNull();

    const globalPrClose = checkToolSafety("bash", { command: "gh pr close 1" });
    expect(globalPrClose).toBeNull();

    const reviewLoopTitleEdit = checkToolSafety(
      "bash",
      { command: 'gh pr edit 1 --title "Compliant title"' },
      { reviewLoopMode: true, worktreeRoot: "/workspace/repo" },
    );
    expect(reviewLoopTitleEdit).toBeNull();

    for (const command of [
      "gh pr review 1 --approve",
      "gh pr review 1 --comment --body done",
      "gh pr comment 1 --body done",
      "gh issue comment 1 --body done",
    ]) {
      const violation = checkToolSafety("bash", { command }, { reviewLoopMode: true, worktreeRoot: "/workspace/repo" });
      expect(violation?.kind).toBe("blocked_command");
      if (!violation || violation.kind !== "blocked_command") throw new Error("expected block for " + command);
      expect(violation.blockedCommands[0]).toMatchObject({
        actionKey: "review_loop.gh_review_comment",
        reasonKey: "review_loop_mutation_blocked",
      });
    }

    const prEditViolation = checkToolSafety(
      "bash",
      { command: "gh pr edit 1 --base release --add-reviewer octocat" },
      { reviewLoopMode: true, worktreeRoot: "/workspace/repo" },
    );
    expect(prEditViolation?.kind).toBe("blocked_command");
    if (!prEditViolation || prEditViolation.kind !== "blocked_command") throw new Error("expected gh pr edit block");
    expect(prEditViolation.blockedCommands[0]).toMatchObject({
      actionKey: "review_loop.gh_pr_edit",
      reasonKey: "review_loop_mutation_blocked",
    });

    const curlViolation = checkToolSafety(
      "bash",
      { command: "curl -X POST https://api.github.com/repos/acme/repo/issues/1/comments" },
      { reviewLoopMode: true, worktreeRoot: "/workspace/repo" },
    );
    expect(curlViolation?.kind).toBe("blocked_command");
    if (!curlViolation || curlViolation.kind !== "blocked_command") throw new Error("expected curl block");
    expect(curlViolation.blockedCommands[0]).toMatchObject({
      actionKey: "review_loop.github_http_mutation",
      reasonKey: "review_loop_mutation_blocked",
    });

    for (const command of [
      "curl -XPOST https://api.github.com/repos/acme/repo/issues/1/comments",
      "curl -d @payload.json https://api.github.com/repos/acme/repo/issues/1/comments",
      "curl --data-raw '{}' https://api.github.com/repos/acme/repo/issues/1/comments",
      "wget --request=PATCH https://api.github.com/repos/acme/repo/pulls/1",
    ]) {
      const violation = checkToolSafety("bash", { command }, { reviewLoopMode: true, worktreeRoot: "/workspace/repo" });
      expect(violation?.kind).toBe("blocked_command");
      if (!violation || violation.kind !== "blocked_command") throw new Error("expected block for " + command);
      expect(violation.blockedCommands[0]).toMatchObject({
        actionKey: "review_loop.github_http_mutation",
        reasonKey: "review_loop_mutation_blocked",
      });
    }
  });

  it("blocks git remote rewrites and writes outside the worktree in review-loop mode", () => {
    const remoteViolation = checkToolSafety(
      "bash",
      { command: "git remote set-url origin git@github.com:evil/repo.git" },
      { reviewLoopMode: true, worktreeRoot: "/workspace/repo" },
    );
    expect(remoteViolation?.kind).toBe("blocked_command");
    if (!remoteViolation || remoteViolation.kind !== "blocked_command") throw new Error("expected remote block");
    expect(remoteViolation.blockedCommands[0]).toMatchObject({
      actionKey: "review_loop.git_remote_set_url",
      reasonKey: "review_loop_mutation_blocked",
    });

    expect(
      checkToolSafety(
        "apply_patch",
        { path: "/tmp/outside.ts", patch: "*** Update File: /tmp/outside.ts\n@@\n-old\n+new\n" },
        { reviewLoopMode: true, worktreeRoot: "/workspace/repo" },
      ),
    ).toEqual({
      kind: "protected_path",
      path: "/tmp/outside.ts",
      errorCode: "policy_block",
      message: 'Policy block: review-loop access outside worktree "/tmp/outside.ts"',
    });

    expect(
      checkToolSafety(
        "apply_patch",
        { path: "../other-repo/file.ts", patch: "*** Update File: ../other-repo/file.ts\n@@\n-old\n+new\n" },
        { reviewLoopMode: true, worktreeRoot: "/workspace/repo" },
      ),
    ).toEqual({
      kind: "protected_path",
      path: "../other-repo/file.ts",
      errorCode: "policy_block",
      message: 'Policy block: review-loop access outside worktree "../other-repo/file.ts"',
    });

    expect(
      checkToolSafety(
        "write_file",
        { file_path: "../other-repo/file.txt", content: "outside" },
        { reviewLoopMode: true, worktreeRoot: "/workspace/repo" },
      ),
    ).toEqual({
      kind: "protected_path",
      path: "../other-repo/file.txt",
      errorCode: "policy_block",
      message: 'Policy block: review-loop access outside worktree "../other-repo/file.txt"',
    });

    for (const command of [
      "cat ../other-repo/secret.txt",
      "printf hacked > ../other-repo/leak.txt",
      "echo x >> /tmp/outside.txt",
      "printf hacked >../other-repo/leak.txt",
      "echo x >/tmp/outside.txt",
      "echo x 2>/tmp/outside.txt",
      "echo x &>/tmp/outside.txt",
      "echo x &>>../other-repo/leak.txt",
      "echo x >|/tmp/outside.txt",
      ": <>/tmp/outside.txt",
      "echo x >&/tmp/outside.txt",
    ]) {
      const violation = checkToolSafety("bash", { command }, { reviewLoopMode: true, worktreeRoot: "/workspace/repo" });
      expect(violation, command).toMatchObject({
        kind: "protected_path",
        errorCode: "policy_block",
      });
      expect(violation?.message).toContain("review-loop access outside worktree");
    }

    for (const command of ["cat src/index.ts", "printf fixed > src/output.txt"]) {
      expect(
        checkToolSafety("bash", { command }, { reviewLoopMode: true, worktreeRoot: "/workspace/repo" }),
      ).toBeNull();
    }
  });

  // ARC-843: regex bodies and inline-script args contain dots and protected suffixes,
  // but they aren't file paths. Tokens with shell/regex metacharacters must be skipped.
  it("allows grep -E patterns that contain .key inside the regex", () => {
    expect(checkToolSafety("bash", { command: "grep -E 'switch|Tab|event.key' file.ts" })).toBeNull();
    expect(checkToolSafety("bash", { command: "grep -E 'a|b.key' file.ts" })).toBeNull();
  });

  it("does not misclassify regex patterns as files when rg/grep value-taking flags are used", () => {
    expect(checkToolSafety("bash", { command: "rg -j 4 'secret.key' file.ts" })).toBeNull();
    expect(checkToolSafety("bash", { command: "rg --threads 4 'secret.key' file.ts" })).toBeNull();
    expect(checkToolSafety("bash", { command: "grep -C 3 'secret.key' file.ts" })).toBeNull();
    expect(checkToolSafety("bash", { command: "grep --context 3 'secret.key' file.ts" })).toBeNull();
    expect(checkToolSafety("bash", { command: "grep -A 2 'secret.key' file.ts" })).toBeNull();
    expect(checkToolSafety("bash", { command: "grep -B 2 'secret.key' file.ts" })).toBeNull();
    expect(checkToolSafety("bash", { command: "rg -m 1 'secret.key' file.ts" })).toBeNull();
    expect(checkToolSafety("bash", { command: "rg --max-count 1 'secret.key' file.ts" })).toBeNull();
    expect(checkToolSafety("bash", { command: "rg -g '*.ts' 'secret.key' file.ts" })).toBeNull();
    expect(checkToolSafety("bash", { command: "rg --glob '*.ts' 'secret.key' file.ts" })).toBeNull();
    expect(checkToolSafety("bash", { command: "rg -t ts 'secret.key' file.ts" })).toBeNull();
    expect(checkToolSafety("bash", { command: "rg --type ts 'secret.key' file.ts" })).toBeNull();
    expect(checkToolSafety("bash", { command: "rg --type-not ts 'secret.key' file.ts" })).toBeNull();
    expect(checkToolSafety("bash", { command: "rg --color always 'secret.key' file.ts" })).toBeNull();
  });

  it("does not block protected-looking pattern args for audited read-only search commands", () => {
    for (const command of [
      "rg 'secret.key' src/index.ts",
      "grep 'secret.key' src/index.ts",
      "git grep 'secret.key' -- src/index.ts",
      "git grep -esecret.key -- src/index.ts",
      "git grep --regexp=secret.key -- src/index.ts",
      "find . -name '*.key'",
      "find . -regex '.*secret.key'",
      "sed -n '/secret.key/p' src/index.ts",
    ]) {
      expect(checkToolSafety("bash", { command }), command).toBeNull();
    }
  });

  it("blocks malformed rg/grep searches with unclosed quotes before sandbox execution", () => {
    const violation = checkToolSafety("bash", {
      command: "rg --files apps/control-plane-worker | rg '(auth|routes).*(test|spec)\\\\.ts'$|tests/.+auth'",
    });

    expect(violation?.kind).toBe("blocked_command");
    if (!violation || violation.kind !== "blocked_command") throw new Error("expected malformed search block");
    expect(violation.blockedCommands[0]).toMatchObject({
      actionKey: "search.malformed",
      reasonKey: "malformed_search_command",
      executable: "rg",
    });
    expect(violation.blockedCommands[0].message).toContain("unclosed ' quote");
  });

  it("attributes malformed search quotes to the search segment that contains them", () => {
    const violation = checkToolSafety("bash", {
      command: "rg --files apps | grep 'keyword",
    });

    expect(violation?.kind).toBe("blocked_command");
    if (!violation || violation.kind !== "blocked_command") throw new Error("expected malformed search block");
    expect(violation.blockedCommands[0]).toMatchObject({
      actionKey: "search.malformed",
      reasonKey: "malformed_search_command",
      executable: "grep",
    });
    expect(violation.blockedCommands[0].raw).toBe("grep 'keyword");
  });

  it("preserves valid advanced rg searches and pipelines", () => {
    expect(
      checkToolSafety("bash", {
        command: "rg --files apps/control-plane-worker | rg '(auth|routes).*(test|spec)\\\\.ts$|tests/.+auth'",
      }),
    ).toBeNull();
    expect(
      checkToolSafety("bash", {
        command:
          "rg -n \"resolveAuthSessionCached|/auth/me|auth/session|RATE_LIMITS|AuthSession\" apps/control-plane-worker -g '*.{test,spec}.ts'",
      }),
    ).toBeNull();
  });

  it("preserves well-formed rg and grep searches", () => {
    expect(checkToolSafety("bash", { command: "rg foo ." })).toBeNull();
    expect(checkToolSafety("bash", { command: "grep -r foo ." })).toBeNull();
  });

  it("blocks cycloid CLI commands while auth is still pending", () => {
    const violation = checkToolSafety("bash", { command: "cycloid whoami" }, { cycloidCliAuthState: "pending" });

    expect(violation?.kind).toBe("blocked_command");
    if (!violation || violation.kind !== "blocked_command") throw new Error("expected blocked command");
    expect(violation.blockedCommands[0]).toMatchObject({
      actionKey: "cycloid.cli_auth_pending",
      reasonKey: "cycloid_cli_auth_pending",
      executable: "cycloid",
    });
    expect(violation.blockedCommands[0].message).toContain("still being prepared");
  });

  it("blocks wrapped cycloid CLI commands after auth setup fails", () => {
    const violation = checkToolSafety(
      "bash",
      { command: "/bin/bash -lc 'cycloid sessions list'" },
      { cycloidCliAuthState: "failed" },
    );

    expect(violation?.kind).toBe("blocked_command");
    if (!violation || violation.kind !== "blocked_command") throw new Error("expected blocked command");
    expect(violation.blockedCommands[0]).toMatchObject({
      actionKey: "cycloid.cli_auth_failed",
      reasonKey: "cycloid_cli_auth_failed",
      executable: "cycloid",
    });
    expect(violation.blockedCommands[0].message).toContain("setup failed earlier");
  });

  it("preserves valid rg searches that use shell quote escapes", () => {
    expect(checkToolSafety("bash", { command: "rg 'can'\\''t' file.ts" })).toBeNull();
    expect(checkToolSafety("bash", { command: "rg '\\''foo'\\'' file.ts" })).toBeNull();
    expect(checkToolSafety("bash", { command: "rg ''\\''foo'\\''' file.ts" })).toBeNull();
    expect(checkToolSafety("bash", { command: "rg $'can\\'t' file.ts" })).toBeNull();
  });

  it("does not attribute a non-search unclosed quote to a downstream rg-looking token", () => {
    expect(checkToolSafety("bash", { command: "cat 'file.ts | rg pattern" })).toBeNull();
  });

  it("does not block a valid search followed by an unrelated unclosed quote", () => {
    expect(checkToolSafety("bash", { command: "rg pattern file.ts && cat 'unclosed" })).toBeNull();
  });

  it("ignores apostrophes in comments and heredoc bodies when checking search quoting", () => {
    expect(checkToolSafety("bash", { command: "rg foo # don't treat this as shell syntax" })).toBeNull();
    expect(
      checkToolSafety("bash", {
        command: `cat <<EOF
don't treat this heredoc text as shell syntax
EOF
rg foo file.ts`,
      }),
    ).toBeNull();
  });

  it("allows awk -v assignments whose value contains .key", () => {
    expect(checkToolSafety("bash", { command: "awk -v k=event.key 'BEGIN{print k}'" })).toBeNull();
  });

  it("allows node -e inline scripts that reference process.env", () => {
    expect(checkToolSafety("bash", { command: 'node -e "console.log(process.env.SCREENSHOT)"' })).toBeNull();
    expect(checkToolSafety("bash", { command: 'node -e "process.env.X"' })).toBeNull();
  });

  it("still blocks reads of protected files via bash", () => {
    expect(checkToolSafety("bash", { command: "cat /secret.key" })?.kind).toBe("protected_path");
    expect(checkToolSafety("bash", { command: "cat /.env.production" })?.kind).toBe("protected_path");
    expect(checkToolSafety("bash", { command: "cat /home/user/.ssh/id_rsa" })?.kind).toBe("protected_path");
  });

  it("classifies file args correctly across known command shapes", () => {
    // grep `-f PATTERNFILE`: PATTERNFILE is a file, the trailing positional is also a file
    expect(checkToolSafety("bash", { command: "grep -f patterns.txt src/index.ts" })).toBeNull();
    expect(checkToolSafety("bash", { command: "git grep -n 'secret.key' src/index.ts" })).toBeNull();
    // sed `-e SCRIPT`: script body isn't a path
    expect(checkToolSafety("bash", { command: "sed -e 's/foo.key/bar/g' src/index.ts" })).toBeNull();
    // find `-name PATTERN`: the glob is a value, not a path
    expect(checkToolSafety("bash", { command: "find . -name '*.key'" })).toBeNull();
    // python -c SCRIPT: the script body isn't a path
    expect(checkToolSafety("bash", { command: "python -c 'import os; print(os.environ)'" })).toBeNull();
  });

  it("blocks protected files passed as search targets when regex is supplied via flag", () => {
    // grep -f PATTERNFILE shifts the trailing positional from regex to file.
    expect(checkToolSafety("bash", { command: "grep -f patterns.txt /etc/secret.key" })?.kind).toBe("protected_path");
    // grep -e PATTERN file → file is the search target
    expect(checkToolSafety("bash", { command: "grep -e foo /home/user/.ssh/id_rsa" })?.kind).toBe("protected_path");
    expect(checkToolSafety("bash", { command: "git grep -efoo -- /home/user/.ssh/id_rsa" })?.kind).toBe(
      "protected_path",
    );
    expect(checkToolSafety("bash", { command: "git grep --regexp=foo -- /home/user/.ssh/id_rsa" })?.kind).toBe(
      "protected_path",
    );
    expect(checkToolSafety("bash", { command: "git grep -e foo -- /home/user/.ssh/id_rsa" })?.kind).toBe(
      "protected_path",
    );
  });

  it("still blocks protected grep/rg search targets after value-taking flags", () => {
    expect(checkToolSafety("bash", { command: "rg -j 4 foo /etc/secret.key" })?.kind).toBe("protected_path");
    expect(checkToolSafety("bash", { command: "grep -C 3 foo /home/user/.ssh/id_rsa" })?.kind).toBe("protected_path");
    expect(checkToolSafety("bash", { command: "rg -g '*.ts' foo /etc/secret.key" })?.kind).toBe("protected_path");
    expect(checkToolSafety("bash", { command: "rg --type ts foo /home/user/.ssh/id_rsa" })?.kind).toBe(
      "protected_path",
    );
    expect(checkToolSafety("bash", { command: "rg --color always foo /etc/secret.key" })?.kind).toBe("protected_path");
  });
});

describe("checkToolSafety git worktree", () => {
  it("blocks git worktree add with handled_automatically reason", () => {
    const violation = checkToolSafety("bash", { command: "git worktree add ../foo origin/main" });
    expect(violation?.kind).toBe("blocked_command");
    if (!violation || violation.kind !== "blocked_command") {
      throw new Error("expected blocked command");
    }
    expect(violation.blockedCommands[0]).toMatchObject({
      actionKey: "git.worktree",
      reasonKey: "handled_automatically",
    });
  });

  it("allows git worktree list", () => {
    expect(checkToolSafety("bash", { command: "git worktree list" })).toBeNull();
  });
});

describe("checkToolSafety with bash -lc wrappers (Codex emits all tool calls this way)", () => {
  it("blocks git worktree add wrapped in /bin/bash -lc", () => {
    const violation = checkToolSafety("bash", {
      command: "/bin/bash -lc 'git worktree add ../foo origin/main'",
    });
    expect(violation?.kind).toBe("blocked_command");
    if (!violation || violation.kind !== "blocked_command") throw new Error("expected blocked command");
    expect(violation.blockedCommands.some((d) => d.actionKey === "git.worktree")).toBe(true);
  });

  it("blocks compound worktree script inside bash -lc", () => {
    const violation = checkToolSafety("bash", {
      command: "/bin/bash -lc 'git fetch origin main && git worktree add ../foo origin/main'",
    });
    expect(violation?.kind).toBe("blocked_command");
    if (!violation || violation.kind !== "blocked_command") throw new Error("expected blocked command");
    expect(violation.blockedCommands.some((d) => d.actionKey === "git.worktree")).toBe(true);
  });

  it("blocks git push wrapped in bash -lc", () => {
    const violation = checkToolSafety("bash", { command: "/bin/bash -lc 'git push origin main'" });
    expect(violation?.kind).toBe("blocked_command");
    if (!violation || violation.kind !== "blocked_command") throw new Error("expected blocked command");
    expect(violation.blockedCommands.some((d) => d.actionKey === "git.push")).toBe(true);
  });

  it("blocks protected paths reached through bash -lc", () => {
    const violation = checkToolSafety("bash", { command: "/bin/bash -lc 'cat /etc/secret.key'" });
    expect(violation?.kind).toBe("protected_path");
  });
});

describe("checkToolSafety review_summary_comment source-kind gate", () => {
  it("allows cycloid.review_summary_comment in review-loop mode with human sourceKind", () => {
    expect(
      checkToolSafety(
        "cycloid.review_summary_comment",
        { epochId: "ep1", body: "summary text" },
        { reviewLoopMode: true, reviewLoopSourceKind: "human" },
      ),
    ).toBeNull();
  });

  it("allows cycloid.review_summary_comment in review-loop mode with mixed sourceKind", () => {
    expect(
      checkToolSafety(
        "cycloid.review_summary_comment",
        { epochId: "ep1", body: "summary text" },
        { reviewLoopMode: true, reviewLoopSourceKind: "mixed" },
      ),
    ).toBeNull();
  });

  it("blocks cycloid.review_summary_comment in review-loop mode with bot sourceKind", () => {
    const violation = checkToolSafety(
      "cycloid.review_summary_comment",
      { epochId: "ep1", body: "summary text" },
      { reviewLoopMode: true, reviewLoopSourceKind: "bot" },
    );
    expect(violation?.kind).toBe("blocked_tool");
    if (!violation || violation.kind !== "blocked_tool") throw new Error("expected blocked_tool");
    expect(violation.reasonKey).toBe("review_loop_source_kind_blocked");
    expect(violation.errorCode).toBe("policy_block");
    expect(violation.message).toBe(
      'Policy block: tool "cycloid.review_summary_comment" is not permitted for this review-loop source kind.',
    );
  });

  it("blocks cycloid.review_summary_comment in review-loop mode when sourceKind is missing", () => {
    const violation = checkToolSafety(
      "cycloid.review_summary_comment",
      { epochId: "ep1", body: "summary text" },
      { reviewLoopMode: true },
    );
    expect(violation?.kind).toBe("blocked_tool");
    if (!violation || violation.kind !== "blocked_tool") throw new Error("expected blocked_tool");
    expect(violation.reasonKey).toBe("review_loop_source_kind_blocked");
    expect(violation.errorCode).toBe("policy_block");
    expect(violation.message).toBe(
      'Policy block: tool "cycloid.review_summary_comment" is not permitted for this review-loop source kind.',
    );
  });

  it("does not block cycloid.review_summary_comment outside review-loop mode", () => {
    expect(checkToolSafety("cycloid.review_summary_comment", { epochId: "ep1", body: "summary text" }, {})).toBeNull();
  });

  it("does not block cycloid.review_loop_reply for any sourceKind in review-loop mode", () => {
    for (const sourceKind of ["bot", "human", "mixed", undefined] as const) {
      expect(
        checkToolSafety(
          "cycloid.review_loop_reply",
          { epochId: "ep1", body: "reply" },
          { reviewLoopMode: true, reviewLoopSourceKind: sourceKind },
        ),
      ).toBeNull();
    }
  });
});

describe("isToolAllowedInReviewLoopSession", () => {
  it("allows cycloid.review_summary_comment for human source kind", () => {
    expect(isToolAllowedInReviewLoopSession("cycloid.review_summary_comment", { sourceKind: "human" })).toBe(true);
  });

  it("allows cycloid.review_summary_comment for mixed source kind", () => {
    expect(isToolAllowedInReviewLoopSession("cycloid.review_summary_comment", { sourceKind: "mixed" })).toBe(true);
  });

  it("blocks cycloid.review_summary_comment for bot source kind", () => {
    expect(isToolAllowedInReviewLoopSession("cycloid.review_summary_comment", { sourceKind: "bot" })).toBe(false);
  });

  it("blocks cycloid.review_summary_comment when sourceKind is missing", () => {
    expect(isToolAllowedInReviewLoopSession("cycloid.review_summary_comment", {})).toBe(false);
    expect(isToolAllowedInReviewLoopSession("cycloid.review_summary_comment", { sourceKind: undefined })).toBe(false);
  });

  it("allows cycloid.review_loop_reply for bot source kind", () => {
    expect(isToolAllowedInReviewLoopSession("cycloid.review_loop_reply", { sourceKind: "bot" })).toBe(true);
  });

  it("allows cycloid.review_loop_reply for human source kind", () => {
    expect(isToolAllowedInReviewLoopSession("cycloid.review_loop_reply", { sourceKind: "human" })).toBe(true);
  });

  it("allows cycloid.review_loop_reply for mixed source kind", () => {
    expect(isToolAllowedInReviewLoopSession("cycloid.review_loop_reply", { sourceKind: "mixed" })).toBe(true);
  });

  it("allows cycloid.review_loop_reply when sourceKind is missing", () => {
    expect(isToolAllowedInReviewLoopSession("cycloid.review_loop_reply", {})).toBe(true);
  });

  it("allows all other tools regardless of sourceKind", () => {
    expect(isToolAllowedInReviewLoopSession("bash", { sourceKind: "bot" })).toBe(true);
    expect(isToolAllowedInReviewLoopSession("read", {})).toBe(true);
    expect(isToolAllowedInReviewLoopSession("cycloid.memory_recall", { sourceKind: "human" })).toBe(true);
  });
});
