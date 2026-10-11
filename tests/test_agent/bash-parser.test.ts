import { describe, expect, it } from "vitest";

import { PR_WORKFLOW_AUTOMATION_CLAUSE } from "../../apps/sandbox-bridge/src/constants/bridge.js";
import {
  extractShellCommandPayloads,
  parseBashCommand,
  tokenizeCommand,
  tokenizeCommandWithSpans,
} from "../../apps/sandbox-bridge/src/utils/bash-parser.js";

const HANDLED_AUTOMATICALLY_SUFFIX =
  "Do not retry. Continue with the remaining non-git task (checks, code changes), or finish if the work is complete. This command is permanently blocked -- do not retry.";
const expectedHandledAutomaticallyMessage = (action: string) =>
  `${action} is unnecessary -- ${PR_WORKFLOW_AUTOMATION_CLAUSE}. ${HANDLED_AUTOMATICALLY_SUFFIX}`;

describe("parseBashCommand", () => {
  it("extracts executable names", () => {
    const result = parseBashCommand("git status && npm test");
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].executable).toBe("git");
    expect(result.segments[1].executable).toBe("npm");
  });

  it("handles path prefixes in executables", () => {
    const result = parseBashCommand("/usr/bin/ls -la");
    expect(result.segments[0].executable).toBe("ls");
  });

  it("skips sudo prefix", () => {
    const result = parseBashCommand("sudo rm -rf /tmp/test");
    expect(result.segments[0].executable).toBe("rm");
  });

  it("skips env prefix", () => {
    const result = parseBashCommand("env NODE_ENV=production node app.js");
    expect(result.segments[0].executable).toBe("node");
  });

  it("allows safe commands", () => {
    const result = parseBashCommand("git status && npm test && ls -la");
    expect(result.isDangerous).toBe(false);
    expect(result.blockedCommands).toHaveLength(0);
  });

  it("extracts paths from arguments", () => {
    const result = parseBashCommand("cat /etc/passwd && cp ./src/file.ts /tmp/");
    expect(result.allPaths.length).toBeGreaterThan(0);
    expect(result.allPaths).toContain("/etc/passwd");
  });

  it("handles env variable assignments", () => {
    const result = parseBashCommand("FOO=bar BAZ=qux node server.js");
    expect(result.segments[0].executable).toBe("node");
  });

  it("handles quoted paths", () => {
    const result = parseBashCommand("cat 'some file.txt' && echo done");
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].executable).toBe("cat");
  });
});

describe("PR-readiness shell tokenization contract", () => {
  it("preserves quote characters and source spans for redaction replacements", () => {
    expect(tokenizeCommandWithSpans("bash -lc 'mysql -pSecret db'")).toEqual([
      { value: "bash", start: 0, end: 4 },
      { value: "-lc", start: 5, end: 8 },
      { value: "'mysql -pSecret db'", start: 9, end: 28 },
    ]);
  });

  it("strips shell quotes and backslash escapes for command analysis tokens", () => {
    expect(tokenizeCommand("bash -lc 'mysql -pSecret db'")).toEqual(["bash", "-lc", "mysql -pSecret db"]);
    expect(tokenizeCommand("tool --token=Escaped\\Secret 'two words'")).toEqual([
      "tool",
      "--token=EscapedSecret",
      "two words",
    ]);
  });

  it("extracts shell -c payloads using quote-stripped command tokens", () => {
    expect(extractShellCommandPayloads("/bin/bash -lc 'npm test -- --token=abc'")).toEqual(["npm test -- --token=abc"]);
    expect(extractShellCommandPayloads("bash -l script.sh")).toEqual([]);
  });
});

describe("blocked git patterns", () => {
  it("allows git commit --amend fixup workflows", () => {
    for (const command of [
      "git commit --amend",
      'git commit --amend -m "msg"',
      "git commit -a --amend",
      "git -C /path commit --amend",
      "/usr/bin/git commit --amend",
    ]) {
      const result = parseBashCommand(command);
      expect(result.isDangerous).toBe(false);
      expect(result.blockedCommandDetails.some((d) => d.actionKey === "git.commit.amend")).toBe(false);
    }
  });

  it("detects git commit --no-verify", () => {
    const result = parseBashCommand('git commit --no-verify -m "msg"');
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(
      "git commit --no-verify is blocked. This command is permanently blocked -- do not retry.",
    );
  });

  it("detects git commit -n (short for --no-verify)", () => {
    const result = parseBashCommand('git commit -n -m "msg"');
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(
      "git commit --no-verify is blocked. This command is permanently blocked -- do not retry.",
    );
  });

  it("detects git rebase -i main", () => {
    const result = parseBashCommand("git rebase -i main");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(
      "git rebase --interactive is blocked. This command is permanently blocked -- do not retry.",
    );
  });

  it("detects git rebase --interactive main", () => {
    const result = parseBashCommand("git rebase --interactive main");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(
      "git rebase --interactive is blocked. This command is permanently blocked -- do not retry.",
    );
  });

  it("detects git -c core.hooksPath=/dev/null commit --amend as hook bypass only", () => {
    const result = parseBashCommand("git -c core.hooksPath=/dev/null commit --amend");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain("git -c core.hooksPath is blocked.");
    expect(result.blockedCommandDetails.some((d) => d.actionKey === "git.commit.amend")).toBe(false);
  });

  it("detects git config core.hooksPath as a hook bypass", () => {
    const result = parseBashCommand("git config core.hooksPath /tmp/empty-hooks");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain("git config core.hooksPath is blocked.");
    expect(result.blockedCommandDetails.some((d) => d.actionKey === "git.config_core_hooks_path")).toBe(true);
  });

  it("detects git config --global core.hooksPath as a hook bypass", () => {
    const result = parseBashCommand("git config --global core.hooksPath /tmp/empty-hooks");
    expect(result.blockedCommands).toContain("git config core.hooksPath is blocked.");
  });

  it("detects git config --unset core.hooksPath as a hook bypass", () => {
    const result = parseBashCommand("git config --unset core.hooksPath");
    expect(result.blockedCommands).toContain("git config core.hooksPath is blocked.");
  });

  it("allows git config user.name (unrelated config key)", () => {
    const result = parseBashCommand('git config user.name "Cycloid"');
    expect(result.blockedCommandDetails.some((d) => d.actionKey === "git.config_core_hooks_path")).toBe(false);
  });

  it("detects core.hooksPath set via GIT_CONFIG_* env on a git command", () => {
    const result = parseBashCommand(
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp/empty git commit -m x",
    );
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(
      "Setting core.hooksPath via GIT_CONFIG_* environment variables is blocked.",
    );
    expect(result.blockedCommandDetails.some((d) => d.actionKey === "git.env_config_core_hooks_path")).toBe(true);
  });

  it("allows unrelated GIT_CONFIG_* env keys", () => {
    const result = parseBashCommand(
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=Cycloid git commit -m x",
    );
    expect(result.blockedCommandDetails.some((d) => d.actionKey === "git.env_config_core_hooks_path")).toBe(false);
  });

  it("still detects the GIT_CONFIG_* bypass behind env options (env -i)", () => {
    const result = parseBashCommand(
      "env -i GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp/empty git commit -m x",
    );
    expect(result.blockedCommands).toContain(
      "Setting core.hooksPath via GIT_CONFIG_* environment variables is blocked.",
    );
  });

  it("still detects git config core.hooksPath behind env options that take a value (env -u)", () => {
    const result = parseBashCommand("env -u FOO git config core.hooksPath /tmp/empty");
    expect(result.blockedCommands).toContain("git config core.hooksPath is blocked.");
  });

  it("allows read-only git config --get core.hooksPath", () => {
    const result = parseBashCommand("git config --get core.hooksPath");
    expect(result.blockedCommandDetails.some((d) => d.actionKey === "git.config_core_hooks_path")).toBe(false);
  });

  it("allows git config --show-origin core.hooksPath (read-only)", () => {
    const result = parseBashCommand("git config --show-origin core.hooksPath");
    expect(result.blockedCommandDetails.some((d) => d.actionKey === "git.config_core_hooks_path")).toBe(false);
  });

  it("allows git commit -m 'msg' (legitimate commit)", () => {
    const result = parseBashCommand('git commit -m "msg"');
    expect(result.isDangerous).toBe(false);
  });

  it("allows git rebase main (non-interactive)", () => {
    const result = parseBashCommand("git rebase main");
    expect(result.isDangerous).toBe(false);
  });

  it("blocks git push origin main", () => {
    const result = parseBashCommand("git push origin main");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("git push"));
  });

  it("blocks bare git push", () => {
    const result = parseBashCommand("git push");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("git push"));
  });

  it("blocks git push --force", () => {
    const result = parseBashCommand("git push --force");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("git push"));
  });

  it("blocks git push in compound command", () => {
    const result = parseBashCommand("git add -A && git push origin main");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("git push"));
  });

  it("blocks git push after an escaped ampersand before a background separator", () => {
    const result = parseBashCommand("echo \\&& git push origin main");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("git push"));
  });

  it("does not flag git log --amend-something (wrong subcommand)", () => {
    // --amend-something doesn't match /^--amend$/ exactly
    const result = parseBashCommand("git log --amend-something");
    expect(result.isDangerous).toBe(false);
  });

  it("allows git add -A in compound command", () => {
    const result = parseBashCommand('cd /workspace && git add -A && git commit -m "msg"');
    expect(result.isDangerous).toBe(false);
    expect(result.blockedCommandDetails.some((d) => d.actionKey === "git.add.all")).toBe(false);
  });

  it("allows git add --all", () => {
    const result = parseBashCommand("git add --all");
    expect(result.isDangerous).toBe(false);
    expect(result.blockedCommandDetails.some((d) => d.actionKey === "git.add.all")).toBe(false);
  });

  it("allows git add .", () => {
    const result = parseBashCommand("git add .");
    expect(result.isDangerous).toBe(false);
    expect(result.blockedCommandDetails.some((d) => d.actionKey === "git.add.dot")).toBe(false);
  });

  it("allows git add ./", () => {
    const result = parseBashCommand("git add ./");
    expect(result.isDangerous).toBe(false);
    expect(result.blockedCommandDetails.some((d) => d.actionKey === "git.add.dot")).toBe(false);
  });

  it("allows git add with specific files", () => {
    const result = parseBashCommand("git add src/foo.ts ./src/bar.ts");
    expect(result.isDangerous).toBe(false);
  });

  it("allows git commit --amend in compound commands with bulk staging", () => {
    const msg = `cd /workspace/repo && git add -A && git commit --amend -m "Batch sequential D1 calls\n\nReduces D1 queue slot consumption on hot paths\n\n- resolveSpawnIntegrationRuntime\n- handleModels\n\nCloses ARC-461"`;
    const result = parseBashCommand(msg);
    expect(result.isDangerous).toBe(false);
    expect(result.blockedCommandDetails.some((d) => d.actionKey === "git.commit.amend")).toBe(false);
    expect(result.blockedCommandDetails.some((d) => d.actionKey === "git.add.all")).toBe(false);
  });
});

describe("blocked git worktree patterns", () => {
  const mutatingVerbs = ["add", "remove", "move", "prune", "lock", "unlock", "repair"];

  for (const verb of mutatingVerbs) {
    it(`blocks git worktree ${verb}`, () => {
      const command =
        verb === "add"
          ? "git worktree add ../foo origin/main"
          : verb === "move"
            ? "git worktree move ../foo ../bar"
            : verb === "prune" || verb === "repair"
              ? `git worktree ${verb}`
              : `git worktree ${verb} ../foo`;
      const result = parseBashCommand(command);
      expect(result.isDangerous).toBe(true);
      expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("git worktree"));
      const detail = result.blockedCommandDetails.find((d) => d.actionKey === "git.worktree");
      expect(detail).toBeDefined();
      expect(detail?.reasonKey).toBe("handled_automatically");
    });
  }

  it("allows git worktree list (read-only inspection)", () => {
    const result = parseBashCommand("git worktree list");
    expect(result.isDangerous).toBe(false);
    expect(result.blockedCommandDetails.some((d) => d.actionKey === "git.worktree")).toBe(false);
  });

  it("allows git worktree list --porcelain", () => {
    const result = parseBashCommand("git worktree list --porcelain");
    expect(result.isDangerous).toBe(false);
  });

  it("does not over-match on unrelated git subcommands", () => {
    for (const command of ["git status", "git checkout main", "git rev-parse --show-toplevel", "git log --oneline"]) {
      const result = parseBashCommand(command);
      expect(result.blockedCommandDetails.some((d) => d.actionKey === "git.worktree")).toBe(false);
    }
  });

  it("blocks git worktree add inside compound commands", () => {
    const result = parseBashCommand("cd /workspace && git worktree add ../foo origin/main && cd ../foo");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommandDetails.some((d) => d.actionKey === "git.worktree")).toBe(true);
  });

  it("blocks git -C /path worktree add (respects global -C)", () => {
    const result = parseBashCommand("git -C /workspace worktree add ../foo");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommandDetails.some((d) => d.actionKey === "git.worktree")).toBe(true);
  });

  it("blocks the standalone git-worktree binary the same as `git worktree`", () => {
    // `git --exec-path` exposes per-subcommand binaries like
    // /usr/lib/git-core/git-worktree. Without handling this form the worktree
    // block can be bypassed by invoking the standalone binary directly.
    for (const cmd of [
      "git-worktree add ../foo origin/main",
      "/usr/lib/git-core/git-worktree add ../foo",
      "/bin/bash -lc '/usr/lib/git-core/git-worktree add ../foo origin/main'",
    ]) {
      const r = parseBashCommand(cmd);
      expect(r.isDangerous).toBe(true);
      expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.worktree")).toBe(true);
    }
  });

  it("allows the standalone git-worktree list form", () => {
    expect(parseBashCommand("git-worktree list").isDangerous).toBe(false);
    expect(parseBashCommand("/usr/lib/git-core/git-worktree list").isDangerous).toBe(false);
  });

  it("blocks the standalone git-push binary", () => {
    const r = parseBashCommand("/usr/lib/git-core/git-push origin main");
    expect(r.isDangerous).toBe(true);
    expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.push")).toBe(true);
  });

  it("shares actionKey across mutating worktree verbs (doom-loop dedup)", () => {
    const addDetail = parseBashCommand("git worktree add ../foo").blockedCommandDetails.find(
      (d) => d.actionKey === "git.worktree",
    );
    const removeDetail = parseBashCommand("git worktree remove ../foo").blockedCommandDetails.find(
      (d) => d.actionKey === "git.worktree",
    );
    expect(addDetail).toBeDefined();
    expect(removeDetail).toBeDefined();
    expect(addDetail?.actionKey).toBe(removeDetail?.actionKey);
    expect(addDetail?.reasonKey).toBe(removeDetail?.reasonKey);
  });
});

describe("shell -c wrapper recursion", () => {
  // Codex wraps every tool call as `/bin/bash -lc '<script>'`, so blocked git/CLI
  // patterns must apply to the inner script body, not just the bare invocation.
  it("blocks git push wrapped in /bin/bash -lc", () => {
    const r = parseBashCommand("/bin/bash -lc 'git push origin main'");
    expect(r.isDangerous).toBe(true);
    expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.push")).toBe(true);
  });

  it("blocks git checkout -b wrapped in bash -lc", () => {
    const r = parseBashCommand("bash -lc 'git checkout -b feature/x'");
    expect(r.isDangerous).toBe(true);
    expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.create_branch")).toBe(true);
  });

  it("blocks git commit --no-verify wrapped in bash -lc", () => {
    const r = parseBashCommand("/bin/bash -lc 'git commit --no-verify -m msg'");
    expect(r.isDangerous).toBe(true);
    expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.commit.no_verify")).toBe(true);
  });

  it("blocks git worktree add wrapped in bash -lc", () => {
    const r = parseBashCommand("/bin/bash -lc 'git worktree add ../foo origin/main'");
    expect(r.isDangerous).toBe(true);
    expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.worktree")).toBe(true);
  });

  it("blocks a compound script inside a bash -lc wrapper", () => {
    const r = parseBashCommand(
      "/bin/bash -lc 'git fetch origin main:refs/remotes/origin/main && git worktree add ../foo origin/main'",
    );
    expect(r.isDangerous).toBe(true);
    expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.worktree")).toBe(true);
  });

  it("recognizes -c flag in any single-letter combination", () => {
    for (const cmd of [
      "bash -c 'git push'",
      "bash -lc 'git push'",
      "bash -cl 'git push'",
      "bash -ic 'git push'",
      "bash -i -c 'git push'",
    ]) {
      const r = parseBashCommand(cmd);
      expect(r.isDangerous).toBe(true);
      expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.push")).toBe(true);
    }
  });

  it("blocks commands when options appear after -c (e.g. `-c -i <body>`)", () => {
    // Bash keeps parsing options after `-c`; the script body is the first
    // operand, not the next argv item. The parser must skip trailing flags.
    for (const cmd of [
      "bash -c -i 'git push'",
      "bash -c -l 'git push'",
      "bash -c -il 'git push'",
      "sh -c -i 'git push'",
      "zsh -c -i 'git push'",
    ]) {
      const r = parseBashCommand(cmd);
      expect(r.isDangerous).toBe(true);
      expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.push")).toBe(true);
    }
  });

  it("blocks commands when -- terminates option parsing (e.g. `-c -- <body>`)", () => {
    // `--` is the end-of-options marker; the arg right after it is the body.
    for (const cmd of [
      "bash -c -- 'git push'",
      "bash -c -i -- 'git push'",
      "/bin/bash -lc -- 'gh pr create --title foo --body bar'",
      "sh -c -- 'git push'",
    ]) {
      const r = parseBashCommand(cmd);
      expect(r.isDangerous).toBe(true);
    }
    expect(
      parseBashCommand("bash -c -- 'gh pr create'").blockedCommandDetails.some((d) => d.actionKey === "gh.pr.create"),
    ).toBe(true);
  });

  it("blocks commands when value-taking options appear after -c (`-o`/`-O`)", () => {
    // `-o option` and `-O shopt` (and the `+o`/`+O` unset forms) consume the
    // following arg as their value, so the body is two args after the flag.
    // Verified against bash: `bash -c -O extglob 'echo X'` runs `echo X`.
    for (const cmd of [
      "bash -c -O extglob 'git push'",
      "bash -c -o emacs 'git push'",
      "bash -c +O extglob 'git push'",
      "bash -c -io emacs 'git push'",
      "/bin/bash -lc --rcfile /tmp/x 'git push'",
    ]) {
      const r = parseBashCommand(cmd);
      expect(r.isDangerous).toBe(true);
      expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.push")).toBe(true);
    }
  });

  it("does not mistake a dash-prefixed script body for an option flag", () => {
    // After quote stripping, a body like `-x; git push` is a single token that
    // starts with `-`. It contains shell metacharacters so it is not a real
    // option flag; the parser must still recurse into it.
    for (const cmd of ["bash -c '-x; git push origin main'", "bash -c -- '-x; git push origin main'"]) {
      const r = parseBashCommand(cmd);
      expect(r.isDangerous).toBe(true);
      expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.push")).toBe(true);
    }
  });

  it("recurses into other POSIX-shell wrappers", () => {
    for (const cmd of [
      "sh -c 'git push origin main'",
      "zsh -c 'git push origin main'",
      "dash -c 'git push'",
      "ash -c 'git push'",
    ]) {
      const r = parseBashCommand(cmd);
      expect(r.isDangerous).toBe(true);
      expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.push")).toBe(true);
    }
  });

  it("fails closed when nested wrappers exceed parser depth", () => {
    // Build a wrapper chain deeper than SHELL_SCRIPT_BODY_MAX_DEPTH (5). At
    // each level the inner body is wrapped in `bash -c '...'` with embedded
    // single quotes escaped via the standard '"'"' pattern. A bypass would
    // require the deepest body to slip past detection silently; instead the
    // parser must record a shell.wrapper.depth violation.
    const wrapBashLc = (body: string) => `bash -c '${body.replace(/'/g, "'\"'\"'")}'`;
    let cmd = "echo hello";
    for (let i = 0; i < 7; i++) cmd = wrapBashLc(cmd);
    const r = parseBashCommand(cmd);
    expect(r.isDangerous).toBe(true);
    expect(r.blockedCommandDetails.some((d) => d.actionKey === "shell.wrapper.depth")).toBe(true);
  });

  it("blocks gh pr create wrapped in bash -lc", () => {
    const r = parseBashCommand("/bin/bash -lc 'gh pr create --title foo --body bar'");
    expect(r.isDangerous).toBe(true);
    expect(r.blockedCommandDetails.some((d) => d.actionKey === "gh.pr.create")).toBe(true);
  });

  it("recurses through nested bash -lc wrappers", () => {
    const r = parseBashCommand("/bin/bash -lc 'bash -lc \"git push origin main\"'");
    expect(r.isDangerous).toBe(true);
    expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.push")).toBe(true);
  });

  it("blocks git push after an escaped quote inside a double-quoted shell body", () => {
    const r = parseBashCommand(`bash -lc "echo \\\\\\"; git push"`);
    expect(r.isDangerous).toBe(true);
    expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.push")).toBe(true);
  });

  it("blocks git push through a line continuation inside a double-quoted shell body", () => {
    const r = parseBashCommand(`bash -lc "git \\
push origin main"`);
    expect(r.isDangerous).toBe(true);
    expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.push")).toBe(true);
  });

  it("allows safe commands inside a bash -lc wrapper", () => {
    for (const cmd of [
      "/bin/bash -lc 'git status'",
      "bash -lc 'git worktree list'",
      "bash -lc 'echo hello'",
      "/bin/bash -lc 'git fetch origin main'",
    ]) {
      const r = parseBashCommand(cmd);
      expect(r.isDangerous).toBe(false);
    }
  });

  it("does not over-match on -l alone (no -c flag)", () => {
    // `bash -l script.sh` runs script.sh as a login shell; script.sh is a file,
    // not a script body. Must not recurse.
    const r = parseBashCommand("bash -l script.sh");
    expect(r.isDangerous).toBe(false);
  });

  it("propagates inner paths through allPaths for protected-path checks", () => {
    const r = parseBashCommand("/bin/bash -lc 'cat /etc/secret.key'");
    expect(r.allPaths).toContain("/etc/secret.key");
  });

  it("blocks git push when wrapped in command substitution (canonicalized)", () => {
    const r = parseBashCommand("$(git push origin main)");
    expect(r.isDangerous).toBe(true);
    expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.push")).toBe(true);
  });

  it("blocks git push when wrapped in backticks (canonicalized)", () => {
    const r = parseBashCommand("`git push origin main`");
    expect(r.isDangerous).toBe(true);
    expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.push")).toBe(true);
  });

  it("blocks git push when wrapped in assignment command substitution", () => {
    const r = parseBashCommand("FOO=$(git push origin main)");
    expect(r.isDangerous).toBe(true);
    expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.push")).toBe(true);
  });

  it("blocks git push in bash -lc assignment command substitution", () => {
    const r = parseBashCommand("/bin/bash -lc 'FOO=$(git push origin main)'");
    expect(r.isDangerous).toBe(true);
    expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.push")).toBe(true);
  });

  it("blocks git push when newline splits git and push argv tokens", () => {
    const r = parseBashCommand("git \npush origin main");
    expect(r.isDangerous).toBe(true);
    expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.push")).toBe(true);
  });

  it("blocks gh pr create when newline splits gh and pr argv tokens", () => {
    const r = parseBashCommand("gh \n pr create --title foo --body bar");
    expect(r.isDangerous).toBe(true);
    expect(r.blockedCommandDetails.some((d) => d.actionKey === "gh.pr.create")).toBe(true);
  });

  it("blocks git push when newline splits git global options and push", () => {
    const r = parseBashCommand("git \n -C \n /repo \n push origin main");
    expect(r.isDangerous).toBe(true);
    expect(r.blockedCommandDetails.some((d) => d.actionKey === "git.push")).toBe(true);
  });
});

describe("search command counting", () => {
  it("counts direct rg and grep-family searches", () => {
    expect(parseBashCommand("rg foo .").searchCommandCounts).toEqual({ grep: 0, ripgrep: 1 });
    expect(parseBashCommand("grep -r foo .").searchCommandCounts).toEqual({ grep: 1, ripgrep: 0 });
    expect(parseBashCommand("egrep foo .").searchCommandCounts).toEqual({ grep: 1, ripgrep: 0 });
    expect(parseBashCommand("fgrep foo .").searchCommandCounts).toEqual({ grep: 1, ripgrep: 0 });
  });

  it("counts compound search commands", () => {
    expect(parseBashCommand("rg a . && grep b .").searchCommandCounts).toEqual({ grep: 1, ripgrep: 1 });
  });

  it("excludes pipe-filter search commands from grep counts", () => {
    expect(parseBashCommand("rg --files | grep x").searchCommandCounts).toEqual({ grep: 0, ripgrep: 1 });
    expect(parseBashCommand("cat f | grep x").searchCommandCounts).toEqual({ grep: 0, ripgrep: 0 });
  });

  it("counts inner searches inside Codex-style bash wrappers", () => {
    expect(parseBashCommand("/bin/bash -lc 'rg foo .'").searchCommandCounts).toEqual({ grep: 0, ripgrep: 1 });
    expect(parseBashCommand("bash -lc 'grep -r foo .'").searchCommandCounts).toEqual({ grep: 1, ripgrep: 0 });
    expect(parseBashCommand("/bin/bash -lc 'rg a . && grep b .'").searchCommandCounts).toEqual({
      grep: 1,
      ripgrep: 1,
    });
  });

  it("excludes inner pipe-filter search commands inside bash wrappers", () => {
    expect(parseBashCommand("/bin/bash -lc 'rg --files | grep x'").searchCommandCounts).toEqual({
      grep: 0,
      ripgrep: 1,
    });
    expect(parseBashCommand("bash -lc 'cat f | grep x'").searchCommandCounts).toEqual({ grep: 0, ripgrep: 0 });
  });
});

describe("blocked branch creation patterns", () => {
  it("blocks git checkout -b feature", () => {
    const result = parseBashCommand("git checkout -b feature");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("Branch creation"));
  });

  it("blocks git checkout -B feature", () => {
    const result = parseBashCommand("git checkout -B feature");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("Branch creation"));
  });

  it("blocks git switch -c feature", () => {
    const result = parseBashCommand("git switch -c feature");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("Branch creation"));
  });

  it("blocks git switch --create feature", () => {
    const result = parseBashCommand("git switch --create feature");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("Branch creation"));
  });

  it("blocks git branch creation before a flagless checkout can switch to it", () => {
    const result = parseBashCommand("git branch ARC-1556/perf-review && git checkout ARC-1556/perf-review");

    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommandDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionKey: "git.create_branch",
          reasonKey: "handled_automatically",
        }),
      ]),
    );
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("Branch creation"));
  });

  it.each([
    "git branch -c main ARC-1556/perf-review",
    "git branch -C main ARC-1556/perf-review",
    "git branch --copy main ARC-1556/perf-review",
  ])("blocks copied branch creation: %s", (command) => {
    const result = parseBashCommand(`${command} && git checkout ARC-1556/perf-review`);

    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommandDetails).toEqual(
      expect.arrayContaining([expect.objectContaining({ actionKey: "git.create_branch" })]),
    );
  });

  it.each([
    "git branch",
    "git branch -a",
    "git branch -l",
    "git branch --list",
    "git branch --show-current",
    "git branch -v",
    "git branch -d old-branch",
    "git branch -D old-branch",
    "git branch -m old-branch new-branch",
    "git branch -M old-branch new-branch",
    "git branch --merged main",
    "git branch --contains abc1234",
    "git branch --format '%(refname:short)'",
    "git branch -u origin/main feature",
    "git branch --set-upstream-to origin/main feature",
    "git branch --unset-upstream feature",
    "git branch --edit-description old-branch",
    "git checkout existing-branch",
  ])("allows non-creation branch command: %s", (command) => {
    const result = parseBashCommand(command);

    expect(result.blockedCommandDetails.some((detail) => detail.actionKey === "git.create_branch")).toBe(false);
  });

  it("allows git checkout main (no -b)", () => {
    const result = parseBashCommand("git checkout main");
    expect(result.isDangerous).toBe(false);
  });

  it("allows git switch main (no -c)", () => {
    const result = parseBashCommand("git switch main");
    expect(result.isDangerous).toBe(false);
  });

  it("normalizes blocked branch creation retries across branch names and commands", () => {
    const checkoutFoo = parseBashCommand("git checkout -b foo");
    const checkoutBar = parseBashCommand("git checkout -b bar");
    const switchBaz = parseBashCommand("git switch -c baz");

    expect(checkoutFoo.blockedCommandDetails[0]).toMatchObject({
      actionKey: "git.create_branch",
      reasonKey: "handled_automatically",
    });
    expect(checkoutBar.blockedCommandDetails[0]).toMatchObject({
      actionKey: "git.create_branch",
      reasonKey: "handled_automatically",
    });
    expect(switchBaz.blockedCommandDetails[0]).toMatchObject({
      actionKey: "git.create_branch",
      reasonKey: "handled_automatically",
    });
  });
});

describe("blocked gh pr patterns", () => {
  it("blocks gh pr create", () => {
    const result = parseBashCommand('gh pr create --title "foo"');
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("PR creation"));
  });

  it("allows gh pr close through the broker", () => {
    const result = parseBashCommand("gh pr close 123");
    expect(result.isDangerous).toBe(false);
  });

  it("blocks gh pr merge", () => {
    const result = parseBashCommand("gh pr merge 123");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("PR management"));
  });

  it("allows title-only gh pr edit through the broker", () => {
    const result = parseBashCommand('gh pr edit 123 --title "foo"');
    expect(result.isDangerous).toBe(false);
  });

  it("allows gh pr view (read-only)", () => {
    const result = parseBashCommand("gh pr view 123");
    expect(result.isDangerous).toBe(false);
  });

  it("allows gh pr diff (read-only)", () => {
    const result = parseBashCommand("gh pr diff 123");
    expect(result.isDangerous).toBe(false);
  });

  it("allows gh pr list (read-only)", () => {
    const result = parseBashCommand("gh pr list");
    expect(result.isDangerous).toBe(false);
  });

  it("allows gh issue view (different command group)", () => {
    const result = parseBashCommand("gh issue view 456");
    expect(result.isDangerous).toBe(false);
  });

  it("blocks gh browse", () => {
    const result = parseBashCommand("gh browse");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(
      "Browser commands are not available in the sandbox. Output the URL as text instead. This command is permanently blocked -- do not retry.",
    );
  });

  it("blocks gh pr view --web", () => {
    const result = parseBashCommand("gh pr view --web");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(
      "Browser commands are not available in the sandbox. Output the URL as text instead. This command is permanently blocked -- do not retry.",
    );
  });

  it("blocks gh repo view --web", () => {
    const result = parseBashCommand("gh repo view --web");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(
      "Browser commands are not available in the sandbox. Output the URL as text instead. This command is permanently blocked -- do not retry.",
    );
  });

  it("allows gh pr view without --web (read-only)", () => {
    const result = parseBashCommand("gh pr view 123");
    expect(result.isDangerous).toBe(false);
  });

  it("blocks gh --repo owner/repo pr create (with global flag)", () => {
    const result = parseBashCommand("gh --repo owner/repo pr create");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("PR creation"));
  });

  it("blocks gh pr create in compound command", () => {
    const result = parseBashCommand("gh pr create && gh issue view 1");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("PR creation"));
  });

  it("blocks gh pr create after a heredoc body", () => {
    const result = parseBashCommand(`pr_body=$(mktemp); cat > "$pr_body" <<'EOF'
## Scope

Body text
EOF
gh pr create --repo owner/repo --base main --head feature --title "Fix bug" --body-file "$pr_body"`);

    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("PR creation"));
  });

  it("blocks gh pr create after a backslash-quoted heredoc delimiter", () => {
    const result = parseBashCommand(`cat > pr-body.md <<\\EOF
## Scope
EOF
gh pr create --repo owner/repo --base main --head feature --title "Fix bug" --body-file pr-body.md`);

    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("PR creation"));
  });

  it("blocks gh pr create after a partially quoted heredoc delimiter", () => {
    const result = parseBashCommand(`cat > pr-body.md <<E'OF'
## Scope
EOF
gh pr create --repo owner/repo --base main --head feature --title "Fix bug" --body-file pr-body.md`);

    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("PR creation"));
  });

  it("blocks gh pr create after a herestring", () => {
    const result = parseBashCommand(`cat <<<'NEVERCLOSED'
gh pr create --repo owner/repo --base main --head feature --title "Fix bug"`);

    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("PR creation"));
  });

  it("blocks git push after a heredoc-looking token following an escaped double quote", () => {
    const result = parseBashCommand(`echo "Escape quotes with \\" and heredoc with <<EOF" > help.txt
git push origin main
EOF`);

    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("git push"));
  });

  it("blocks git push after a heredoc delimiter with a line continuation", () => {
    const result = parseBashCommand(`cat <<EO\\
F
body
EOF
git push origin main`);

    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("git push"));
  });

  it("blocks git push after a line ending with an escaped backslash", () => {
    const result = parseBashCommand(`echo safe\\\\
git push origin main`);

    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("git push"));
  });

  it("ignores blocked-looking text inside heredoc bodies", () => {
    const result = parseBashCommand(`cat > pr-body.md <<'EOF'
gh pr create --title "body text only"
EOF
gh pr view 1`);

    expect(result.isDangerous).toBe(false);
    expect(result.blockedCommands).toHaveLength(0);
  });

  it("does not close plain heredocs on tab-indented delimiters", () => {
    const result = parseBashCommand(`cat > pr-body.md <<'EOF'
Body text
\tEOF
gh pr create --title "body text only"
EOF
gh pr view 1`);

    expect(result.isDangerous).toBe(false);
    expect(result.blockedCommands).toHaveLength(0);
  });

  it("closes dash heredocs on tab-indented delimiters", () => {
    const result = parseBashCommand(`cat > pr-body.md <<-'EOF'
Body text
\tEOF
gh pr create --repo owner/repo --base main --head feature --title "Fix bug" --body-file pr-body.md`);

    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("PR creation"));
  });
});

describe("blocked gh api mutation patterns", () => {
  it("blocks gh api -X PATCH", () => {
    const result = parseBashCommand("gh api repos/foo/bar/pulls/1 -X PATCH -f state=closed");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(
      "Mutating GitHub API calls are not allowed. Use read-only gh commands instead. This command is permanently blocked -- do not retry.",
    );
  });

  it("blocks gh api --method DELETE", () => {
    const result = parseBashCommand("gh api repos/foo/bar/pulls/1 --method DELETE");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(
      "Mutating GitHub API calls are not allowed. Use read-only gh commands instead. This command is permanently blocked -- do not retry.",
    );
  });

  it("blocks gh api -X POST with flag before positional", () => {
    const result = parseBashCommand("gh api -X POST repos/foo/bar/issues");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(
      "Mutating GitHub API calls are not allowed. Use read-only gh commands instead. This command is permanently blocked -- do not retry.",
    );
  });

  it("allows gh api GET (no -X flag)", () => {
    const result = parseBashCommand("gh api repos/foo/bar/pulls/1");
    expect(result.isDangerous).toBe(false);
  });

  // Known gap: equals-joined form bypasses the flag check because the bash
  // parser uses exact string matching (flagSet.has(a)) and --method=DELETE !== --method
  it("allows gh api --method=DELETE (known gap: equals-joined form)", () => {
    const result = parseBashCommand("gh api repos/foo/bar/pulls/1 --method=DELETE");
    expect(result.isDangerous).toBe(false);
  });
});

describe("blocked gh issue patterns", () => {
  it("blocks gh issue close", () => {
    const result = parseBashCommand("gh issue close 123");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("Issue management"));
  });

  it("blocks gh issue reopen", () => {
    const result = parseBashCommand("gh issue reopen 123");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("Issue management"));
  });

  it("blocks gh issue delete", () => {
    const result = parseBashCommand("gh issue delete 123");
    expect(result.isDangerous).toBe(true);
    expect(result.blockedCommands).toContain(expectedHandledAutomaticallyMessage("Issue management"));
  });

  it("allows gh issue view (read-only)", () => {
    const result = parseBashCommand("gh issue view 456");
    expect(result.isDangerous).toBe(false);
  });

  it("allows gh issue list (read-only)", () => {
    const result = parseBashCommand("gh issue list");
    expect(result.isDangerous).toBe(false);
  });
});

describe("grouping/wrapper bypass hardening (ARC-1550)", () => {
  const NO_VERIFY_MSG = "git commit --no-verify is blocked. This command is permanently blocked -- do not retry.";
  const REBASE_MSG = "git rebase --interactive is blocked. This command is permanently blocked -- do not retry.";

  it("blocks git commit --no-verify wrapped in a subshell", () => {
    for (const command of [
      "(git commit --no-verify -m 'msg')",
      "( git commit --no-verify )",
      "(cd sub && git commit --no-verify)",
      "( ( git commit --no-verify ) )", // valid nested subshell (spaced)
    ]) {
      const result = parseBashCommand(command);
      expect(result.isDangerous, command).toBe(true);
      expect(result.blockedCommands, command).toContain(NO_VERIFY_MSG);
      expect(
        result.blockedCommandDetails.some((d) => d.actionKey === "git.commit.no_verify"),
        command,
      ).toBe(true);
    }
  });

  it("blocks blocked git commands even when a redirection follows the subshell close", () => {
    const push = parseBashCommand("(git push origin main) 2>&1");
    expect(push.isDangerous).toBe(true);
    expect(push.blockedCommandDetails.some((d) => d.actionKey === "git.push")).toBe(true);

    const commit = parseBashCommand("(git commit --no-verify) >/tmp/log");
    expect(commit.isDangerous).toBe(true);
    expect(commit.blockedCommands).toContain(NO_VERIFY_MSG);
  });

  it("blocks blocked git commands wrapped in a brace group", () => {
    const commit = parseBashCommand("{ git commit --no-verify -m 'msg'; }");
    expect(commit.isDangerous).toBe(true);
    expect(commit.blockedCommands).toContain(NO_VERIFY_MSG);

    const rebase = parseBashCommand("{ git rebase -i HEAD~1; }");
    expect(rebase.isDangerous).toBe(true);
    expect(rebase.blockedCommands).toContain(REBASE_MSG);
  });

  it("blocks blocked git commands behind exec/command builtins", () => {
    for (const command of [
      "exec git commit --no-verify -m 'msg'",
      "exec -a alias git commit --no-verify", // -a consumes its value; git must still resolve
      "command git commit --no-verify",
      "env FOO=bar exec git commit --no-verify",
      "(sudo git commit --no-verify)",
    ]) {
      const result = parseBashCommand(command);
      expect(result.isDangerous, command).toBe(true);
      expect(result.blockedCommands, command).toContain(NO_VERIFY_MSG);
    }
  });

  it("blocks blocked git commands behind eval (direct, quoted, and -- forms)", () => {
    for (const command of [
      "eval git commit --no-verify",
      'eval "git commit --no-verify"',
      "eval -- git commit --no-verify",
      "eval 'git rebase -i main'",
    ]) {
      const result = parseBashCommand(command);
      expect(result.isDangerous, command).toBe(true);
    }
  });

  it("fails closed on eval payloads with unresolved dynamic expansion", () => {
    for (const command of ['eval "$cmd commit --no-verify"', 'eval "$GIT commit --no-verify"']) {
      const result = parseBashCommand(command);
      expect(result.isDangerous, command).toBe(true);
      expect(
        result.blockedCommandDetails.some((d) => d.actionKey === "shell.eval.dynamic"),
        command,
      ).toBe(true);
    }
  });

  it("still fires non-commit blocked layers when wrapped", () => {
    const worktree = parseBashCommand("(git worktree add ../wt)");
    expect(worktree.blockedCommandDetails.some((d) => d.actionKey === "git.worktree")).toBe(true);

    const standalone = parseBashCommand("(git-commit --no-verify)");
    expect(standalone.isDangerous).toBe(true);
    expect(standalone.blockedCommandDetails.some((d) => d.actionKey === "git.commit.no_verify")).toBe(true);

    const hooksPath = parseBashCommand("{ git -c core.hooksPath=/dev/null commit --amend; }");
    expect(hooksPath.blockedCommands).toContain("git -c core.hooksPath is blocked.");
  });

  it("resolves the real executable through grouping and wrapper builtins", () => {
    expect(parseBashCommand("(git status)").segments[0].executable).toBe("git");
    expect(parseBashCommand("exec git status").segments[0].executable).toBe("git");
    expect(parseBashCommand("command git status").segments[0].executable).toBe("git");
  });

  it("does not regress allowed commands or over-block benign wrappers", () => {
    // command -v git is introspection, not execution.
    const commandV = parseBashCommand("command -v git");
    expect(commandV.isDangerous).toBe(false);

    // A benign quoted paren in a commit message must not be treated as a wrapper.
    const parenMsg = parseBashCommand("git commit -m '(wip) msg'");
    expect(parenMsg.isDangerous).toBe(false);

    // git commit --amend stays allowed even when wrapped.
    const amend = parseBashCommand("(git commit --amend)");
    expect(amend.isDangerous).toBe(false);

    // Brace expansion must not crash or be treated as a brace group.
    expect(() => parseBashCommand("echo {a,b}")).not.toThrow();

    // Prefix + subshell path detection stays intact for /app.
    const appPath = parseBashCommand("(cat /app/secret.txt)");
    expect(appPath.allPaths).toContain("/app/secret.txt");
  });
});
