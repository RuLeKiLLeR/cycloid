import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ESLint } from "eslint";
import { afterEach, describe, expect, it } from "vitest";

const FIXTURE_ROOT = "tools/__lint-fixture__";

async function runEslint(file: string): Promise<{ ok: boolean; output: string }> {
  const eslint = new ESLint({
    cwd: process.cwd(),
  });
  const results = await eslint.lintFiles([file]);
  const formatter = await eslint.loadFormatter("stylish");
  const output = await formatter.format(results);
  return { ok: results.every((result) => result.errorCount === 0), output };
}

describe("tools process.env lint rule", () => {
  afterEach(() => {
    rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it("rejects process.env dot, bracket, and computed env reads under tools", async () => {
    const fixtureDir = join(FIXTURE_ROOT, "bad");
    mkdirSync(fixtureDir, { recursive: true });
    const fixturePath = join(fixtureDir, "client.ts");
    writeFileSync(
      fixturePath,
      `
export const dot = process.env.LINEAR_ACCESS_TOKEN;
export const bracket = process.env["LINEAR_ACCESS_TOKEN"];
export const computedEnv = process["env"].LINEAR_ACCESS_TOKEN;
`,
    );

    const result = await runEslint(fixturePath);

    expect(result.ok).toBe(false);
    expect(result.output).toContain(
      "Tool clients must read secrets from the execution context via secret(name, ctx.env)",
    );
    expect(result.output).toContain("2:20");
    expect(result.output).toContain("3:24");
    expect(result.output).toContain("4:28");
  });
});
