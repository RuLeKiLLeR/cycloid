import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const RECORDER = resolve(REPO_ROOT, "apps/sandbox-e2b/cycloid-record-demo.mjs");

describe("cycloid-record-demo", () => {
  it("ships an executable helper with reviewer-friendly WebM defaults", () => {
    expect(existsSync(RECORDER)).toBe(true);
    if (!existsSync(RECORDER)) {
      return;
    }

    const source = readFileSync(RECORDER, "utf8");
    expect(source).toContain("#!/usr/bin/env node");
    expect(source).toContain("recordVideo");
    expect(source).toContain("width: 1280");
    expect(source).toContain("height: 720");
    expect(source).toContain("/usr/local/bin/chromium");
    expect(source).toContain("/usr/bin/chromium");
    expect(source).toContain("Chromium is required");
    expect(source).toContain("WEBM_LIMIT_BYTES");
  });

  it("parses the minimal URL and output contract agents can call from prompts", async () => {
    expect(existsSync(RECORDER)).toBe(true);
    if (!existsSync(RECORDER)) {
      return;
    }

    const mod = await import(pathToFileURL(RECORDER).href);
    expect(
      mod.parseArgs(["--url", "http://127.0.0.1:3000", "--out", "/tmp/cycloid-evidence/e2e-demo/demo.webm"]),
    ).toMatchObject({
      url: "http://127.0.0.1:3000",
      out: "/tmp/cycloid-evidence/e2e-demo/demo.webm",
      timeoutMs: 60_000,
      holdMs: 2_000,
    });
  });

  it("parses optional storage state for authenticated recordings", async () => {
    expect(existsSync(RECORDER)).toBe(true);
    if (!existsSync(RECORDER)) {
      return;
    }

    const mod = await import(pathToFileURL(RECORDER).href);
    expect(
      mod.parseArgs([
        "--url",
        "http://127.0.0.1:3000",
        "--out",
        "/tmp/cycloid-evidence/e2e-demo/demo.webm",
        "--storage-state",
        __filename,
      ]),
    ).toMatchObject({
      storageState: __filename,
    });
  });

  it("rejects non-WebM output paths before launching a browser", async () => {
    expect(existsSync(RECORDER)).toBe(true);
    if (!existsSync(RECORDER)) {
      return;
    }

    const mod = await import(pathToFileURL(RECORDER).href);
    expect(() => mod.parseArgs(["--url", "http://127.0.0.1:3000", "--out", "/tmp/demo.mp4"])).toThrow(
      /--out must end with \.webm/,
    );
  });
});
