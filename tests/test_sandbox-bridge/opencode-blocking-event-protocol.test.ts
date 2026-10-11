// @ts-nocheck -- sandbox-bridge is excluded from root tsconfig
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function expectLiteral(source: string, literal: string): void {
  expect(source).toContain(`type: "${literal}"`);
}

describe("opencode blocking event protocol guard", () => {
  it("anchors blocking event names to the v2 SDK types, not the stale default Event union", () => {
    const v2Types = readRepoFile("node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts");
    const defaultTypes = readRepoFile("node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts");

    // The default @opencode-ai/sdk Event union is stale for this incident class:
    // it still names permission.updated and omits the real permission.asked wire
    // event. Do not use it as the bridge drift oracle.
    expect(defaultTypes).toContain('type: "permission.updated"');
    expect(defaultTypes).not.toContain('type: "permission.asked"');

    expectLiteral(v2Types, "permission.asked");
    expectLiteral(v2Types, "permission.v2.asked");
    expectLiteral(v2Types, "question.asked");
    expectLiteral(v2Types, "question.v2.asked");
  });

  it("keeps the translator wired to the real v1 permission event and a fail-fast asked fallback", () => {
    const translator = readRepoFile("apps/sandbox-bridge/src/services/opencode-event-translator.ts");

    expect(translator).toContain('case "permission.asked"');
    expect(translator).not.toContain('case "permission.updated"');
    expect(translator).toContain('eventType.endsWith(".asked")');
    expect(translator).toContain("opencode.blocking_event.failsafe");
  });
});
