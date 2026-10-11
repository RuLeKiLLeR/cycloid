import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { baseEnv, cleanupTempDirs, makeTempDir, START_BRIDGE, writeBridgeBundle } from "./start-bridge-helpers";

afterEach(cleanupTempDirs);

describe("E2B start-bridge desktop startup", () => {
  it("exports DISPLAY=:99 without starting the desktop supervisor before it is requested", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    const bundlePath = writeBridgeBundle(dir);
    const env = {
      ...baseEnv(dir, repoPath),
      BRIDGE_BUNDLE: bundlePath,
    };
    writeFileSync(bundlePath, 'console.log(`bridge-display=${process.env.DISPLAY ?? ""}`);\n');
    const startedAt = Date.now();

    const result = spawnSync("bash", [START_BRIDGE], {
      env,
      encoding: "utf8",
      timeout: 5000,
    });

    expect(result.status).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(result.stdout).toContain("bridge-display=:99");
    expect(readFileSync(join(dir, "start-bridge.log"), "utf8")).not.toContain("desktop_supervisor");
    expect(existsSync(join(dir, "desktop-supervisor.log"))).toBe(false);
  });
});
