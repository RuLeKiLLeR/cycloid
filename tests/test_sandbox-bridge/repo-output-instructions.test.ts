// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveOutputInstructions } from "../../apps/sandbox-bridge/src/services/repo-output-instructions.js";

function makeLog() {
  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => log,
  };
  return log;
}

let cwd: string;
const cleanup: string[] = [];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "repo-output-instructions-"));
  cleanup.push(cwd);
});

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, body: string) => writeFileSync(join(cwd, name), body, "utf-8");

describe("resolveOutputInstructions", () => {
  const aliases = [
    "PR descriptions",
    "PR description style",
    "PR summary",
    "PR summaries",
    "PR summary style",
    "Pull request descriptions",
    "Pull request summaries",
  ];

  it.each(aliases)("matches the %s heading alias", (heading) => {
    write(
      "CYCLOID.md",
      [
        "# Repo rules",
        "",
        "General coding rules that should not be returned.",
        "",
        `## ${heading}`,
        "",
        "Two sentences, plain language.",
        "",
        "No command dumps.",
        "",
        "## Build",
        "",
        "Run tests.",
      ].join("\n"),
    );

    expect(resolveOutputInstructions(cwd, "pr-summary", makeLog())).toBe(
      "Two sentences, plain language.\n\nNo command dumps.",
    );
  });

  it("caps oversized matched sections", () => {
    write("CYCLOID.md", `## PR descriptions\n\n${"x".repeat(5000)}`);

    expect(resolveOutputInstructions(cwd, "pr-summary", makeLog())).toHaveLength(4096);
  });

  it("returns null when no project doc exists", () => {
    expect(resolveOutputInstructions(cwd, "pr-summary", makeLog())).toBeNull();
  });

  it("returns null when no matching section exists and does not return the whole doc", () => {
    write("CYCLOID.md", "## Build\n\nRun npm test.\n\n## Coding style\n\nPrefer small functions.");

    expect(resolveOutputInstructions(cwd, "pr-summary", makeLog())).toBeNull();
  });

  it("returns null for an empty matching section", () => {
    write("CYCLOID.md", "## PR descriptions\n\n   \n\n## Build\n\nRun tests.");

    expect(resolveOutputInstructions(cwd, "pr-summary", makeLog())).toBeNull();
  });

  it("falls back to AGENTS.md and CLAUDE.md when higher-precedence docs are absent", () => {
    write("AGENTS.md", "## PR summaries\n\nUse the team's voice.");
    expect(resolveOutputInstructions(cwd, "pr-summary", makeLog())).toBe("Use the team's voice.");

    rmSync(join(cwd, "AGENTS.md"));
    write("CLAUDE.md", "## Pull request summaries\n\nKeep it concise.");
    expect(resolveOutputInstructions(cwd, "pr-summary", makeLog())).toBe("Keep it concise.");
  });
});
