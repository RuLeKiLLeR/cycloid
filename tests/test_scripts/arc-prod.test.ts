import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const SCRIPT = resolve(REPO_ROOT, "scripts/arc-prod");

describe("arc-prod", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("runs cycloid with apiUrl and token from the global config", () => {
    tempDir = mkdtempSync(join(tmpdir(), "arc-prod-"));
    const home = join(tempDir, "home");
    const bin = join(tempDir, "bin");
    mkdirSync(join(home, ".cycloid"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(home, ".cycloid", "config.json"),
      JSON.stringify({ apiUrl: "https://app.trycycloid.com", token: "arc_prod" }),
    );
    writeFileSync(
      join(bin, "cycloid"),
      `#!/usr/bin/env bash
printf 'url=%s token=%s args=%s\\n' "$ARCANIST_API_URL" "$ARCANIST_TOKEN" "$*"
`,
      { mode: 0o755 },
    );

    const output = execFileSync("bash", [SCRIPT, "auth", "whoami", "--json"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ARCANIST_GLOBAL_CONFIG: undefined,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });

    expect(output).toBe("url=https://app.trycycloid.com token=arc_prod args=auth whoami --json\n");
  });

  it("errors when the global config is missing", () => {
    tempDir = mkdtempSync(join(tmpdir(), "arc-prod-"));
    let stderr = "";

    try {
      execFileSync("bash", [SCRIPT, "auth", "whoami"], {
        cwd: REPO_ROOT,
        env: { ...process.env, ARCANIST_GLOBAL_CONFIG: undefined, HOME: tempDir },
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      stderr = String((error as { stderr?: Buffer }).stderr);
    }

    expect(stderr).toContain("missing global Cycloid CLI config");
    expect(stderr).toContain("cycloid auth login");
  });

  it("does not exec cycloid when the global config is incomplete", () => {
    tempDir = mkdtempSync(join(tmpdir(), "arc-prod-"));
    const home = join(tempDir, "home");
    const bin = join(tempDir, "bin");
    mkdirSync(join(home, ".cycloid"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(home, ".cycloid", "config.json"), JSON.stringify({ apiUrl: "https://app.trycycloid.com" }));
    writeFileSync(
      join(bin, "cycloid"),
      `#!/usr/bin/env bash
echo 'unexpected cycloid exec'
exit 99
`,
      { mode: 0o755 },
    );
    let stderr = "";

    try {
      execFileSync("bash", [SCRIPT, "auth", "whoami"], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          ARCANIST_GLOBAL_CONFIG: undefined,
          HOME: home,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      stderr = String((error as { stderr?: Buffer }).stderr);
    }

    expect(stderr).toContain("must contain apiUrl and token");
    expect(stderr).not.toContain("unexpected cycloid exec");
  });

  it("is documented with the literal repo script path", () => {
    expect(readFileSync(resolve(REPO_ROOT, "docs/cli.md"), "utf8")).toContain("scripts/arc-prod auth whoami --json");
    expect(readFileSync(resolve(REPO_ROOT, "apps/cli/README.md"), "utf8")).toContain("scripts/arc-prod <command>");
  });
});
