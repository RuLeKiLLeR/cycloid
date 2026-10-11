import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "../..");

function readRepoFile(...segments: string[]): string {
  return readFileSync(join(REPO_ROOT, ...segments), "utf-8");
}

describe("sandbox-visible docs do not instruct sandbox sessions to use worktrees", () => {
  it("docs/workflow.md scopes the worktree section to local developer checkouts", () => {
    const workflow = readRepoFile("docs", "workflow.md");
    expect(workflow).toMatch(/^##\s+Local worktrees$/m);
    expect(workflow).not.toMatch(/^-\s+Always create a worktree before editing repo files\.$/m);
    expect(workflow).toMatch(/local developer checkout/);
  });

  it("AGENTS.md Local Dev section is scoped to local developer checkouts", () => {
    const agents = readRepoFile("AGENTS.md");
    const localDevSection = agents.split(/^##\s+Local Dev\s*$/m)[1] ?? "";
    expect(localDevSection).toMatch(/local developer checkout/i);
    expect(localDevSection).toMatch(/[Ss]andbox sessions/);
  });

  it("CLAUDE.md Local Dev section is scoped to local developer checkouts", () => {
    const claude = readRepoFile("CLAUDE.md");
    const localDevSection = claude.split(/^##\s+Local Dev\s*$/m)[1] ?? "";
    expect(localDevSection).toMatch(/local developer checkout/i);
    expect(localDevSection).toMatch(/[Ss]andbox sessions/);
  });

  it("AGENTS.md does not advertise a separate remote-sandbox workflow row", () => {
    const agents = readRepoFile("AGENTS.md");
    expect(agents).not.toMatch(/remote-agent-workflow\.md/);
    expect(agents).not.toMatch(/Remote Cycloid sandbox workflow/i);
  });
});
