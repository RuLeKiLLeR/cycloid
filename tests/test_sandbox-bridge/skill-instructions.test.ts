import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveAgentProfileIndexInstruction } from "../../apps/sandbox-bridge/src/utils/agent-profiles.js";
import { resolveSkillInstructions } from "../../apps/sandbox-bridge/src/utils/skills.js";

describe("resolveSkillInstructions", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves selected repo skills as instruction content", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cycloid-skills-"));
    tempRoots.push(repoRoot);
    const skillDir = join(repoRoot, ".claude", "skills", "review-spec");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: review-spec\ndescription: Review a spec\n---\n\n# Review\n\nUse the spec checklist.\n",
      "utf-8",
    );

    const [skill] = resolveSkillInstructions(repoRoot, ["review-spec"]);

    expect(skill.name).toBe("review-spec");
    expect(skill.path).toBe(".claude/skills/review-spec/SKILL.md");
    expect(skill.content).toContain('<instruction_content source="repo_skill"');
    expect(skill.content).toContain("Use the spec checklist.");
    expect(skill.content).not.toContain("description: Review a spec");
  });

  it("resolves selected repo skills by frontmatter name when it differs from the directory", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cycloid-skills-"));
    tempRoots.push(repoRoot);
    const skillDir = join(repoRoot, ".agents", "skills", "review-plan");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: review-spec\ndescription: Review a spec\n---\n\n# Review\n\nUse the spec checklist.\n",
      "utf-8",
    );

    const [skill] = resolveSkillInstructions(repoRoot, ["review-spec"]);

    expect(skill.name).toBe("review-spec");
    expect(skill.path).toBe(".agents/skills/review-plan/SKILL.md");
    expect(skill.content).toContain("Use the spec checklist.");
  });

  it("resolves skills from the Codex agents skill root", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cycloid-skills-"));
    tempRoots.push(repoRoot);
    const skillDir = join(repoRoot, ".agents", "skills", "review-spec");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: review-spec\ndescription: Review a spec\n---\n\n# Review\n\nUse the agents checklist.\n",
      "utf-8",
    );

    const [skill] = resolveSkillInstructions(repoRoot, ["review-spec"]);

    expect(skill.name).toBe("review-spec");
    expect(skill.path).toBe(".agents/skills/review-spec/SKILL.md");
    expect(skill.content).toContain("Use the agents checklist.");
  });

  it("substitutes skill arguments into selected skill instructions", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cycloid-skills-"));
    tempRoots.push(repoRoot);
    const skillDir = join(repoRoot, ".agents", "skills", "explain-plan-file");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: explain-plan-file",
        "description: Explain a plan file",
        "argument: path to a plan file",
        "---",
        "",
        "# Explain",
        "",
        "Read `$ARGUMENTS` and explain it.",
      ].join("\n"),
      "utf-8",
    );

    const [skill] = resolveSkillInstructions(repoRoot, ["explain-plan-file"], "plans/update.md");

    expect(skill.content).toContain("Read `plans/update.md` and explain it.");
    expect(skill.content).not.toContain("$ARGUMENTS");
  });

  it("inserts skill argument text containing $-replacement metacharacters verbatim", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cycloid-skills-"));
    tempRoots.push(repoRoot);
    const skillDir = join(repoRoot, ".agents", "skills", "echo-arg");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", "name: echo-arg", "description: Echo argument", "---", "", "Run `$ARGUMENTS`."].join("\n"),
      "utf-8",
    );

    const tricky = "sed 's/x/$&/' && echo $$ $`";
    const [skill] = resolveSkillInstructions(repoRoot, ["echo-arg"], tricky);

    expect(skill.content).toContain(`Run \`${tricky}\`.`);
  });

  it("prefers the first configured skill root when names overlap", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cycloid-skills-"));
    tempRoots.push(repoRoot);
    const claudeSkillDir = join(repoRoot, ".claude", "skills", "review-spec");
    const agentsSkillDir = join(repoRoot, ".agents", "skills", "review-spec");
    mkdirSync(claudeSkillDir, { recursive: true });
    mkdirSync(agentsSkillDir, { recursive: true });
    writeFileSync(
      join(claudeSkillDir, "SKILL.md"),
      "---\nname: review-spec\ndescription: Review a spec\n---\n\n# Review\n\nUse the Claude checklist.\n",
      "utf-8",
    );
    writeFileSync(
      join(agentsSkillDir, "SKILL.md"),
      "---\nname: review-spec\ndescription: Review a spec\n---\n\n# Review\n\nUse the agents checklist.\n",
      "utf-8",
    );

    const [skill] = resolveSkillInstructions(repoRoot, ["review-spec"]);

    expect(skill.path).toBe(".claude/skills/review-spec/SKILL.md");
    expect(skill.content).toContain("Use the Claude checklist.");
  });

  it("fails when a selected skill does not exist in the checked-out repo", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cycloid-skills-"));
    tempRoots.push(repoRoot);

    expect(() => resolveSkillInstructions(repoRoot, ["missing"])).toThrow("Selected skill not found: missing");
  });
});

describe("resolveAgentProfileIndexInstruction", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when the repo has no agent profile index", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cycloid-profiles-"));
    tempRoots.push(repoRoot);

    expect(resolveAgentProfileIndexInstruction(repoRoot)).toBeNull();
  });

  it("wraps the repo agent profile index with profile-first guidance", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cycloid-profiles-"));
    tempRoots.push(repoRoot);
    const profileDir = join(repoRoot, ".cycloid", "agent-profiles");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, "index.md"),
      [
        "# Agent Profiles",
        "",
        "- [investigate-incident](investigate-incident.md) - incidents and production alerts.",
      ].join("\n"),
      "utf-8",
    );

    const instruction = resolveAgentProfileIndexInstruction(repoRoot);

    expect(instruction?.path).toBe(".cycloid/agent-profiles/index.md");
    expect(instruction?.content).toContain("# Repo agent profile selection");
    expect(instruction?.content).toContain("Before choosing any repo skill or workflow");
    expect(instruction?.content).toContain("skills as tactical guidance");
    expect(instruction?.content).toContain('<instruction_content source="repo_agent_profile_index"');
    expect(instruction?.content).toContain("[investigate-incident](investigate-incident.md)");
  });
});
