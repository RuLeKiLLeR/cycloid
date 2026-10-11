import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = join(__dirname, "../../scripts/unauthenticated-exposure-check.mjs");

function runExposureCheck(args: string[], cwd: string) {
  return execFileSync("node", [SCRIPT_PATH, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("unauthenticated exposure check", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  function createFixture() {
    tempDir = mkdtempSync(join(tmpdir(), "unauth-exposure-"));
    const dist = join(tempDir, "dist/ui");
    const sourceRoot = join(tempDir, "apps/ui/src");
    mkdirSync(join(dist, "assets"), { recursive: true });
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(dist, "index.html"), '<div id="root"></div><script src="/assets/app.js"></script>');
    writeFileSync(join(dist, "assets/app.js"), "console.log('ok');");
    writeFileSync(join(sourceRoot, "sentry.ts"), "const key = 'VITE_SENTRY_DSN';");
    return { dist, sourceRoot };
  }

  it("passes a minimal strict fixture", () => {
    const { dist, sourceRoot } = createFixture();

    expect(runExposureCheck(["--dist", dist, "--source-root", sourceRoot, "--strict-assets"], tempDir!)).toContain(
      "[unauth-exposure] passed",
    );
  });

  it("allows hidden local source maps for deploy-time Sentry upload", () => {
    const { dist, sourceRoot } = createFixture();
    writeFileSync(join(dist, "assets/app.js.map"), '{"version":3,"sourcesContent":["const ok = true;"]}');

    expect(runExposureCheck(["--dist", dist, "--source-root", sourceRoot, "--strict-assets"], tempDir!)).toContain(
      "deploy uploads them to Sentry and strips them before publishing Pages",
    );
  });

  it("fails strict assets on public source map references", () => {
    const { dist, sourceRoot } = createFixture();
    writeFileSync(join(dist, "assets/app.js"), "console.log('ok');\n//# sourceMappingURL=app.js.map");

    expect(() =>
      runExposureCheck(["--dist", dist, "--source-root", sourceRoot, "--strict-assets"], tempDir!),
    ).toThrowError(/sourceMappingURL/);
  });

  it("fails strict assets on inline trailing source map references", () => {
    const { dist, sourceRoot } = createFixture();
    writeFileSync(
      join(dist, "assets/app.js"),
      "console.log('ok');//# sourceMappingURL=app.js.map\nconsole.log('still ok');/*# sourceMappingURL=app.js.map */",
    );

    expect(() =>
      runExposureCheck(["--dist", dist, "--source-root", sourceRoot, "--strict-assets"], tempDir!),
    ).toThrowError(/sourceMappingURL/);
  });

  it("ignores inert sourceMappingURL string literals in public assets", () => {
    const { dist, sourceRoot } = createFixture();
    writeFileSync(join(dist, "assets/app.js"), "const marker = 'sourceMappingURL=app.js.map';\nconsole.log(marker);");

    expect(runExposureCheck(["--dist", dist, "--source-root", sourceRoot, "--strict-assets"], tempDir!)).toContain(
      "[unauth-exposure] passed",
    );
  });

  it("fails strict assets on provider token prefixes in public text assets", () => {
    const { dist, sourceRoot } = createFixture();
    writeFileSync(join(dist, "assets/app.js"), "const token = 'ghp_123456789012345678901234567890123456';");

    expect(() =>
      runExposureCheck(["--dist", dist, "--source-root", sourceRoot, "--strict-assets"], tempDir!),
    ).toThrowError(/GitHub token prefix ghp_/);
  });

  it("fails strict assets on unallowlisted VITE source keys", () => {
    const { dist, sourceRoot } = createFixture();
    writeFileSync(join(sourceRoot, "bad.ts"), "const key = 'VITE_INTERNAL_SECRET';");

    expect(() =>
      runExposureCheck(["--dist", dist, "--source-root", sourceRoot, "--strict-assets"], tempDir!),
    ).toThrowError(/VITE_INTERNAL_SECRET/);
  });
});
