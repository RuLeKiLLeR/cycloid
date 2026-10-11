import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error plain .mjs module without type declarations
import { computeBundleHash } from "../../scripts/control-plane-bundle-hash.mjs";

const SCRIPT_PATH = join(__dirname, "../../scripts/control-plane-bundle-hash.mjs");

describe("control-plane bundle hash", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("is stable for identical inputs", () => {
    const a = computeBundleHash([Buffer.from("bundle"), Buffer.from("config")]);
    const b = computeBundleHash([Buffer.from("bundle"), Buffer.from("config")]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the bundle changes", () => {
    const a = computeBundleHash([Buffer.from("bundle-v1"), Buffer.from("config")]);
    const b = computeBundleHash([Buffer.from("bundle-v2"), Buffer.from("config")]);
    expect(a).not.toBe(b);
  });

  it("changes when only the wrangler config changes (config-only change forces a deploy)", () => {
    const a = computeBundleHash([Buffer.from("bundle"), Buffer.from("[vars]\nA = '1'")]);
    const b = computeBundleHash([Buffer.from("bundle"), Buffer.from("[vars]\nA = '2'")]);
    expect(a).not.toBe(b);
  });

  it("does not collide when content shifts across the part boundary", () => {
    const a = computeBundleHash([Buffer.from("ab"), Buffer.from("c")]);
    const b = computeBundleHash([Buffer.from("a"), Buffer.from("bc")]);
    expect(a).not.toBe(b);
  });

  it("prints the hash for valid file arguments via the CLI", () => {
    tempDir = mkdtempSync(join(tmpdir(), "bundle-hash-"));
    const bundlePath = join(tempDir, "index.js");
    const configPath = join(tempDir, "wrangler.toml");
    writeFileSync(bundlePath, "export default {};");
    writeFileSync(configPath, "name = 'worker'");

    const output = execFileSync("node", [SCRIPT_PATH, bundlePath, configPath], { encoding: "utf8" }).trim();
    expect(output).toBe(computeBundleHash([Buffer.from("export default {};"), Buffer.from("name = 'worker'")]));
  });

  it("exits non-zero with usage when arguments are missing", () => {
    expect(() => execFileSync("node", [SCRIPT_PATH], { encoding: "utf8", stdio: "pipe" })).toThrow(/Usage/);
  });

  it("exits non-zero when an input file is missing", () => {
    expect(() =>
      execFileSync("node", [SCRIPT_PATH, "/nonexistent/index.js", "/nonexistent/wrangler.toml"], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    ).toThrow(/Failed to compute bundle hash/);
  });
});
