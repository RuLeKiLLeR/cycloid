import { execFileSync } from "child_process";
import { lstatSync, readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");
const claudeSkillsRoot = resolve(repoRoot, ".claude/skills");
const agentsSkillsRoot = resolve(repoRoot, ".agents/skills");

function listTrackedSkillNames(root: ".claude/skills" | ".agents/skills"): string[] {
  const output = execFileSync("git", ["ls-files", `${root}/*/SKILL.md`], { cwd: repoRoot, encoding: "utf-8" });
  return output
    .split("\n")
    .filter(Boolean)
    .map((path) => path.split("/")[2])
    .sort();
}

function skillPath(root: string, name: string): string {
  return resolve(root, name, "SKILL.md");
}

// Skill files are consumed by two runtimes:
//   - Claude Code reads .claude/skills/<name>/SKILL.md
//   - Codex reads .agents/skills/<name>/SKILL.md
// Every repo skill must exist in both roots, and each runtime-facing SKILL.md
// must be a real file because local skill loaders may skip symlinks.
describe("Claude and Codex skill dual-path sync", () => {
  const claudeSkillNames = listTrackedSkillNames(".claude/skills");
  const agentsSkillNames = listTrackedSkillNames(".agents/skills");

  it("exposes the same skill names to Claude and Codex", () => {
    expect(agentsSkillNames).toEqual(claudeSkillNames);
  });

  it("stores every paired skill as real files", () => {
    for (const name of claudeSkillNames) {
      const agentsStats = lstatSync(skillPath(agentsSkillsRoot, name));
      const claudeStats = lstatSync(skillPath(claudeSkillsRoot, name));
      expect(agentsStats.isFile(), `.agents ${name}`).toBe(true);
      expect(agentsStats.isSymbolicLink(), `.agents ${name}`).toBe(false);
      expect(claudeStats.isFile(), `.claude ${name}`).toBe(true);
      expect(claudeStats.isSymbolicLink(), `.claude ${name}`).toBe(false);
    }
  });

  it("keeps every paired SKILL byte-identical across roots", () => {
    for (const name of claudeSkillNames) {
      const agents = readFileSync(skillPath(agentsSkillsRoot, name), "utf-8");
      const claude = readFileSync(skillPath(claudeSkillsRoot, name), "utf-8");
      expect(claude, name).toBe(agents);
    }
  });

  it("documents that sessions always start from a fresh sandbox", () => {
    const skillContent = readFileSync(skillPath(claudeSkillsRoot, "verify-deployed-pr"), "utf-8");
    expect(skillContent).toContain("Sessions always start from a fresh sandbox");
    expect(skillContent).toContain(
      'cycloid --json sessions create https://github.com/trycycloid/cycloid "<verification prompt>"',
    );
    expect(skillContent).toContain("Do not add the deprecated cold-start flag");
  });

  it("documents fix-first handling for failing pre-merge required checks", () => {
    for (const root of [claudeSkillsRoot, agentsSkillsRoot]) {
      const skillContent = readFileSync(skillPath(root, "verify-pr-before-merge"), "utf-8");
      expect(skillContent).toContain("fix it by default instead of stopping at a generic");
      expect(skillContent).toContain("especially backend test, typecheck, lint, and workflow failures");
      expect(skillContent).toContain(
        "Only stop and report fail immediately when the required check failure is unreasonable to fix",
      );
      expect(skillContent).toContain("commit it and push the updated branch back to the PR head ref");
      expect(skillContent).toContain("re-check GitHub status against the updated remote SHA");
    }
  });

  it("documents that verifier sessions must not recurse into nested Cycloid sessions", () => {
    for (const root of [claudeSkillsRoot, agentsSkillsRoot]) {
      const skillContent = readFileSync(skillPath(root, "verify-pr-before-merge"), "utf-8");
      expect(skillContent).toContain("ARCANIST_AGENT_ROLE=verification");
      expect(skillContent).toContain("do not follow this skill's session-creation steps");
      expect(skillContent).toContain("cycloid.spawn_child_session");
      expect(skillContent).toContain("direct local/sandbox evidence");
    }
  });

  it("documents the current GitHub inline review reply endpoint", () => {
    const skillContent = readFileSync(skillPath(claudeSkillsRoot, "resolve-comments"), "utf-8");
    expect(skillContent).toContain("gh api repos/<OWNER>/<REPO>/pulls/<N>/comments/<COMMENT_ID>/replies");
    expect(skillContent).toContain("Do not use `repos/<OWNER>/<REPO>/pulls/comments/<COMMENT_ID>/replies`");
  });

  it("documents resolved-comments PR labeling", () => {
    const skillContent = readFileSync(skillPath(claudeSkillsRoot, "resolve-comments"), "utf-8");
    expect(skillContent).toContain("gh api repos/<OWNER>/<REPO>/labels/resolved-comments");
    expect(skillContent).toContain("gh label create resolved-comments --repo <OWNER>/<REPO>");
    expect(skillContent).toContain("gh pr edit <N> --repo <OWNER>/<REPO> --add-label resolved-comments");
    expect(skillContent).toContain("Do not add the label if the run stops early or any work item remains deferred");
  });

  it("keeps auto-merge ownership in merge-graphite-stack", () => {
    for (const root of [claudeSkillsRoot, agentsSkillsRoot]) {
      const resolveContent = readFileSync(skillPath(root, "resolve-comments"), "utf-8");
      const mergeContent = readFileSync(skillPath(root, "merge-graphite-stack"), "utf-8");
      expect(resolveContent).toContain("Do not enable auto-merge from this skill");
      expect(resolveContent).not.toContain("gh pr merge <N> --repo <OWNER>/<REPO> --auto --squash");
      expect(mergeContent).toContain(
        "gt submit --no-stack --no-interactive --publish --no-edit --branch <name> --merge-when-ready",
      );
      expect(mergeContent).toContain("this skill owns the single per-PR merge-enablement call");
    }
  });

  it("assigns out-of-scope Linear tickets to the original PR author", () => {
    for (const root of [claudeSkillsRoot, agentsSkillsRoot]) {
      for (const skill of ["resolve-comments"]) {
        const skillContent = readFileSync(skillPath(root, skill), "utf-8");
        expect(skillContent).toContain("--json number,headRefName,baseRefName,title,body,author");
        expect(skillContent).toContain("--json title,body,headRefName,baseRefName,author");
        expect(skillContent).toContain("Assignee set to the original PR author from `gh pr view`");
        expect(skillContent).toContain("Resolve only against fields belonging to the PR author");
        expect(skillContent).toContain("use `author.login` from `gh pr view --json author`");
        expect(skillContent).toContain("then try the exact `author.name` display name");
        expect(skillContent).toContain("still create the ticket unassigned");
        expect(skillContent).toContain("Do not leave valid feedback untracked because assignee resolution failed");
      }
    }
  });

  it("namespaces spec-check temp files with an mktemp workspace, not a non-persisting shell var", () => {
    for (const root of [claudeSkillsRoot, agentsSkillsRoot]) {
      const skillContent = readFileSync(skillPath(root, "spec-check"), "utf-8");
      // Concurrent reviews must isolate temp files in a unique directory created atomically.
      expect(skillContent).toContain('mktemp -d "${TMPDIR:-/tmp}/spec-check-XXXXXXXX"');
      expect(skillContent).toContain("shell state does NOT persist between `Bash` tool calls");
      expect(skillContent).toContain("rm -rf <WORKDIR>");
      // The old PID/REVIEW_ID scheme interpolated a non-persisting var into temp paths, which
      // silently collapsed to shared paths across Bash calls. Guard against those path patterns.
      expect(skillContent).not.toContain("-${REVIEW_ID}.md");
      expect(skillContent).not.toContain("/tmp/spec-check-claude-round");
      expect(skillContent).not.toContain("/tmp/spec-check-accumulated-");
      // $SPEC_PATH was also a non-persisting shell variable (same root cause); the codex prompts
      // must use the literal spec path, not a variable. Guard against reintroducing it.
      expect(skillContent).not.toContain("$SPEC_PATH");
    }
  });

  it("keeps cross-check-pr read-only and bundle-based", () => {
    for (const root of [claudeSkillsRoot, agentsSkillsRoot]) {
      const skillContent = readFileSync(skillPath(root, "cross-check-pr"), "utf-8");
      expect(skillContent).toContain("disable-model-invocation: true");
      expect(skillContent).toContain("allowed-tools:");
      expect(skillContent).toContain("Bash(diff:*)");
      expect(skillContent).toContain('mktemp -d "${TMPDIR:-/tmp}/cross-check-pr-XXXXXXXX"');
      expect(skillContent).toContain("baseRefOid,headRefOid");
      expect(skillContent).toContain("root `AGENTS.md`");
      expect(skillContent).toContain("any nested `AGENTS.md` whose directory scopes changed files");
      expect(skillContent).toContain("Accept: application/vnd.github.raw");
      expect(skillContent).toContain("explicitly decode `.content` before saving a snapshot");
      expect(skillContent).toContain("Codex reviews a local bundle, never the live PR");
      expect(skillContent).toContain("codex exec -s read-only");
      expect(skillContent).toContain("<WORKDIR>/pr-<PR_NUMBER>.diff");
      expect(skillContent).toContain("The command is expected to block until complete");
      expect(skillContent).toContain("diff -u <WORKDIR>/git-status-before.txt <WORKDIR>/git-status-after.txt");
      expect(skillContent).toContain("Never `gh pr checkout`");
      expect(skillContent).toContain(
        "never edit, push, comment, submit a review, label, merge, close, or change PR state",
      );
      expect(skillContent).toContain("rm -rf <WORKDIR>");
      expect(skillContent).toContain("Never use a broad glob like `/tmp/cross-check-pr-*`");
      expect(skillContent).not.toContain("Bash(gh pr comment");
      expect(skillContent).not.toContain("Bash(gh pr review");
      expect(skillContent).not.toContain("Bash(gh pr edit");
      expect(skillContent).not.toContain("Bash(git push");
      expect(skillContent).not.toContain("Bash(git commit");
    }

    const claude = readFileSync(skillPath(claudeSkillsRoot, "cross-check-pr"), "utf-8");
    const agents = readFileSync(skillPath(agentsSkillsRoot, "cross-check-pr"), "utf-8");
    expect(claude).toBe(agents);
  });
});
