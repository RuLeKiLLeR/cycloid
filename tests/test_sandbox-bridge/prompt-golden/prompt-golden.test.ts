import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildSystemContext } from "../../../apps/sandbox-bridge/src/services/prompt-context-builder.js";
import { PROMPT_GOLDEN_FIXTURES } from "./fixtures.js";

/**
 * Golden tests over the assembled system context. Each fixture's rendered text
 * is pinned to a committed `.golden.txt` file so any prompt-affecting change
 * shows up as a reviewable diff instead of slipping through unnoticed.
 *
 * To regenerate after an intentional prompt change:
 *
 *   UPDATE_PROMPT_GOLDENS=1 npx vitest run tests/test_sandbox-bridge/prompt-golden
 *
 * then review and commit the regenerated goldens.
 */
const GOLDEN_DIR = join(__dirname, "goldens");
const EMPTY_SENTINEL = "<no system context>\n";
const UPDATE = process.env.UPDATE_PROMPT_GOLDENS === "1";

function goldenPath(name: string): string {
  return join(GOLDEN_DIR, `${name}.golden.txt`);
}

function renderGolden(text: string | undefined): string {
  return text === undefined ? EMPTY_SENTINEL : `${text}\n`;
}

describe("prompt golden fixtures", () => {
  it("has unique fixture names", () => {
    const names = PROMPT_GOLDEN_FIXTURES.map((fixture) => fixture.name);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const fixture of PROMPT_GOLDEN_FIXTURES) {
    it(`matches golden: ${fixture.name}`, () => {
      const { systemContext } = buildSystemContext(fixture.input);
      const rendered = renderGolden(systemContext.text);
      const path = goldenPath(fixture.name);

      if (UPDATE) {
        mkdirSync(GOLDEN_DIR, { recursive: true });
        writeFileSync(path, rendered, "utf8");
        return;
      }

      expect(
        existsSync(path),
        `Missing golden file for fixture "${fixture.name}". Run UPDATE_PROMPT_GOLDENS=1 to generate it.`,
      ).toBe(true);
      expect(rendered).toBe(readFileSync(path, "utf8"));
    });
  }
});

describe("system context structural invariants", () => {
  it("is deterministic across repeated builds", () => {
    for (const fixture of PROMPT_GOLDEN_FIXTURES) {
      const first = buildSystemContext(fixture.input);
      const second = buildSystemContext(fixture.input);
      expect(second.systemContext.text).toBe(first.systemContext.text);
      expect(second.systemContext.totalTokenCountEstimate).toBe(first.systemContext.totalTokenCountEstimate);
    }
  });

  it("derives the prompt phase from session state", () => {
    for (const fixture of PROMPT_GOLDEN_FIXTURES) {
      const { systemContext } = buildSystemContext(fixture.input);
      expect(systemContext.promptPhase).toBe(fixture.input.hasSentPromptInCurrentSession ? "followup" : "initial");
    }
  });

  it("reports invalid prompt actor IDs while still rendering the author-only identity section", () => {
    const fixture = PROMPT_GOLDEN_FIXTURES.find((entry) => entry.name === "identity-invalid-prompt-actor");
    expect(fixture).toBeDefined();
    const result = buildSystemContext(fixture!.input);
    expect(result.invalidPromptActorUserId).toBe("not a user id!");
  });

  it("measures a per-section token contribution for every rendered section", () => {
    const fixture = PROMPT_GOLDEN_FIXTURES.find((entry) => entry.name === "followup-composite");
    expect(fixture).toBeDefined();
    const { systemContext } = buildSystemContext(fixture!.input);
    expect(systemContext.sections.length).toBeGreaterThan(0);
    for (const section of systemContext.sections) {
      expect(section.tokenCountEstimate).toBeGreaterThan(0);
    }
    expect(systemContext.totalTokenCountEstimate).toBeGreaterThan(0);
  });
});
