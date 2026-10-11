import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { compileSandboxLayerEnvInstruction } from "../../apps/control-plane-worker/src/sandbox/layer-compiler";

const REPO_ROOT = resolve(__dirname, "../..");
const START_BRIDGE = resolve(REPO_ROOT, "apps/sandbox-e2b/start-bridge.sh");
const READY_CHECK = resolve(REPO_ROOT, "apps/sandbox-e2b/ready-check.sh");

describe("sandbox layer env hook", () => {
  it("start-bridge loads the generated layer env before validating required runtime env", () => {
    const script = readFileSync(START_BRIDGE, "utf8");
    const hookIndex = script.indexOf('. "${LAYER_ENV_PATH}"');
    const requiredEnvIndex = script.indexOf("required_env=(");

    expect(hookIndex).toBeGreaterThan(0);
    expect(hookIndex).toBeLessThan(requiredEnvIndex);
    expect(script).toContain("layer_env_loaded");
  });

  it("ready-check verifies generated hook files when they exist", () => {
    const script = readFileSync(READY_CHECK, "utf8");

    expect(script).toContain("/etc/cycloid/layer-env.sh");
    expect(script).toContain("/etc/profile.d/cycloid-layer-env.sh");
    expect(script).toContain("8#022");
  });

  it("generated profile hook exposes layer ENV values to shell commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "cycloid-layer-env-"));
    try {
      const generated = compileSandboxLayerEnvInstruction({ FOO: "bar baz" });
      expect(generated).toContain("export FOO='bar baz'");
      expect(generated).toContain("export ARCANIST_SANDBOX_LAYER_ENV=1");
      const cycloidDir = join(dir, "etc/cycloid");
      const profileDir = join(dir, "etc/profile.d");
      mkdirSync(cycloidDir, { recursive: true });
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(join(cycloidDir, "layer-env.sh"), "export ARCANIST_SANDBOX_LAYER_ENV=1\nexport FOO='bar baz'\n");
      writeFileSync(
        join(profileDir, "cycloid-layer-env.sh"),
        `if [ -r ${join(cycloidDir, "layer-env.sh")} ]; then\n  . ${join(cycloidDir, "layer-env.sh")}\nfi\n`,
      );
      const profile = join(dir, "etc/profile.d/cycloid-layer-env.sh");
      writeFileSync(join(dir, "check.sh"), `. ${profile}\nprintf '%s:%s' "$ARCANIST_SANDBOX_LAYER_ENV" "$FOO"\n`);

      expect(execFileSync("bash", [join(dir, "check.sh")], { encoding: "utf8" })).toBe("1:bar baz");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
