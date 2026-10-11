import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");

describe("Codex skill interface metadata", () => {
  it("exposes recap as a first-class Codex skill with a session-summary default prompt", () => {
    const content = readFileSync(resolve(repoRoot, ".agents/skills/recap/agents/openai.yaml"), "utf-8");

    expect(content).toContain('display_name: "Recap"');
    expect(content).toContain('short_description: "Summarize the current Codex session"');
    expect(content).toContain("Use $recap to summarize what has happened so far in this Codex session");
  });

  it("exposes review-cycloid-session as a first-class Codex skill for waiting and session audits", () => {
    const content = readFileSync(
      resolve(repoRoot, ".agents/skills/review-cycloid-session/agents/openai.yaml"),
      "utf-8",
    );

    expect(content).toContain('display_name: "Review Cycloid Session"');
    expect(content).toContain('short_description: "Wait for and audit one Cycloid session"');
    expect(content).toContain("Use $review-cycloid-session to review this Cycloid session");
    expect(content).toContain("wait for it if it is still active");
    expect(content).toContain("URL or UUID");
  });

  it("exposes run-and-audit-cycloid-session as a first-class Codex skill for Linear-driven runs", () => {
    const content = readFileSync(
      resolve(repoRoot, ".agents/skills/run-and-audit-cycloid-session/agents/openai.yaml"),
      "utf-8",
    );

    expect(content).toContain('display_name: "Run And Audit Cycloid Session"');
    expect(content).toContain('short_description: "Run a Cycloid session from a Linear ticket, then audit it"');
    expect(content).toContain("Use $run-and-audit-cycloid-session to take a Linear ticket");
    expect(content).toContain("Linear ticket");
  });

  it("exposes pr-session-timeline as a first-class Codex skill for PR review-loop timelines", () => {
    const content = readFileSync(resolve(repoRoot, ".agents/skills/pr-session-timeline/agents/openai.yaml"), "utf-8");

    expect(content).toContain('display_name: "PR Session Timeline"');
    expect(content).toContain(
      'short_description: "Reconstruct stopwatch timelines for Cycloid sessions and PR review loops"',
    );
    expect(content).toContain("Use $pr-session-timeline to reconstruct the stopwatch-style timeline");
    expect(content).toContain("reviewer comments and edits");
    expect(content).toContain("verification agent runs");
  });

  it("exposes audit-prod-docs as a first-class Codex skill for production docs audits", () => {
    const content = readFileSync(resolve(repoRoot, ".agents/skills/audit-prod-docs/agents/openai.yaml"), "utf-8");

    expect(content).toContain('display_name: "Audit Prod Docs"');
    expect(content).toContain('short_description: "Audit docs.trycycloid.com against the current repo"');
    expect(content).toContain("Use $audit-prod-docs to audit the public production docs");
    expect(content).toContain("alternate docs URL");
  });

  it("documents stale-premise handling in session audit skills", () => {
    const runAndAuditSkill = readFileSync(
      resolve(repoRoot, ".agents/skills/run-and-audit-cycloid-session/SKILL.md"),
      "utf-8",
    );
    const reviewSkill = readFileSync(resolve(repoRoot, ".agents/skills/review-cycloid-session/SKILL.md"), "utf-8");

    expect(runAndAuditSkill).toContain(
      "if the requested implementation is already present or already shipped, it must say so explicitly",
    );
    expect(runAndAuditSkill).toContain(
      "say whether no code change is needed, the request should be closed, or a narrow follow-up is still justified",
    );
    expect(runAndAuditSkill).not.toContain("`no_op`");
    expect(runAndAuditSkill).not.toContain("`closure_recommendation`");
    expect(runAndAuditSkill).not.toContain("`narrow_followup`");
    expect(reviewSkill).toContain("Scope honesty");
    expect(reviewSkill).toContain("if the agent finds the requested change already exists");
  });
});
