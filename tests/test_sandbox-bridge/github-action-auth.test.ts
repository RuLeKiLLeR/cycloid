// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installGithubActionAuth } from "../../apps/sandbox-bridge/src/utils/github-action-auth.js";
import { GITHUB_ACTION_AUTH_FILE_ENV } from "../../shared/constants/github-action-auth.js";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env[GITHUB_ACTION_AUTH_FILE_ENV];
});

describe("installGithubActionAuth", () => {
  it("fails soft when the configured auth path cannot be written", () => {
    const dir = mkdtempSync(join(tmpdir(), "github-action-auth-"));
    tempDirs.push(dir);
    process.env[GITHUB_ACTION_AUTH_FILE_ENV] = dir;

    expect(installGithubActionAuth("sandbox-token")).toEqual({ reason: "write_failed" });
    expect(process.env[GITHUB_ACTION_AUTH_FILE_ENV]).toBe(dir);
  });
});
