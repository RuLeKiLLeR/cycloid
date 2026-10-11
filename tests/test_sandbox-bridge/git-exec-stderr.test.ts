// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { execRepoGit, execRepoGitSync } from "../../apps/sandbox-bridge/src/services/git/exec.js";

const tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "git-exec-stderr-"));
  tempDirs.push(dir);
  return dir;
}

function installGitStub(body) {
  const dir = tempDir();
  const stub = join(dir, "git-stub.sh");
  writeFileSync(stub, `#!/bin/sh\n${body}\n`);
  chmodSync(stub, 0o755);
  process.env.ARCANIST_REAL_GIT_PATH = stub;
  return dir;
}

let savedRealGitPath;
beforeEach(() => {
  savedRealGitPath = process.env.ARCANIST_REAL_GIT_PATH;
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedRealGitPath === undefined) delete process.env.ARCANIST_REAL_GIT_PATH;
  else process.env.ARCANIST_REAL_GIT_PATH = savedRealGitPath;
});

describe("execRepoGit error messages", () => {
  it("surfaces async Node timeouts without dropping the structured error fields", async () => {
    const cwd = installGitStub(`printf 'partial stderr\\n' >&2\nsleep 2`);

    await expect(execRepoGit(["fetch", "origin"], { cwd, timeout: 50 })).rejects.toMatchObject({
      killed: true,
      signal: "SIGTERM",
      message: expect.stringContaining("git fetch timed out or was killed after 50ms"),
    });
  });

  it("surfaces sync timeouts without dropping the structured error fields", () => {
    expect.assertions(3);
    const cwd = installGitStub(`printf 'partial stderr\\n' >&2\nsleep 2`);

    expect(() => execRepoGitSync(["fetch", "origin"], { cwd, timeout: 50 })).toThrow(
      /git fetch timed out or was killed after 50ms/,
    );
    try {
      execRepoGitSync(["fetch", "origin"], { cwd, timeout: 50 });
    } catch (err) {
      expect(err).toMatchObject({ code: "ETIMEDOUT" });
      expect(err.message).toContain("code=ETIMEDOUT");
    }
  });

  it("labels external kills separately without synthesizing killed=false", async () => {
    expect.assertions(5);
    const cwd = installGitStub(`printf 'partial stderr\\n' >&2\nkill -KILL $$`);

    try {
      await execRepoGit(["fetch", "origin"], { cwd, timeout: 50 });
      throw new Error("expected execRepoGit to fail");
    } catch (err) {
      expect(err.signal).toBe("SIGKILL");
      expect(err.killed).not.toBe(true);
      expect(err.message).toContain("git fetch was killed externally");
      expect(err.message).not.toContain("after 50ms");
      expect(err.message).not.toContain("killed=false");
    }
  });

  it("leaves async AbortSignal cancellations labelled as aborts", async () => {
    expect.assertions(3);
    const cwd = installGitStub(`printf 'partial stderr\\n' >&2\nsleep 2`);
    const controller = new AbortController();

    const promise = execRepoGit(["fetch", "origin"], {
      cwd,
      timeout: 5_000,
      signal: controller.signal,
    });
    controller.abort();

    try {
      await promise;
      throw new Error("expected execRepoGit to fail");
    } catch (err) {
      expect(err.name).toBe("AbortError");
      expect(err.code).toBe("ABORT_ERR");
      expect(err.message).not.toContain("timed out or was killed");
    }
  });

  it("leaves async clean non-zero exits alone so stderr appears exactly once", async () => {
    const cwd = installGitStub(`printf 'fatal once\\n' >&2\nexit 42`);

    try {
      await execRepoGit(["fetch", "origin"], { cwd });
      throw new Error("expected execRepoGit to fail");
    } catch (err) {
      expect(err.message).not.toContain("timed out or was killed");
      expect(err.message).toContain("fatal once");
      expect(err.message.match(/fatal once/g)).toHaveLength(1);
    }
  });

  it("leaves sync clean non-zero exits alone so stderr appears exactly once", () => {
    const cwd = installGitStub(`printf 'fatal once\\n' >&2\nexit 42`);

    try {
      execRepoGitSync(["fetch", "origin"], { cwd });
      throw new Error("expected execRepoGitSync to fail");
    } catch (err) {
      expect(err.message).not.toContain("timed out or was killed");
      expect(err.message).toContain("fatal once");
      expect(err.message.match(/fatal once/g)).toHaveLength(1);
    }
  });
});
