import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const CURL_WRAPPER = resolve(REPO_ROOT, "apps/sandbox-e2b/curl-egress-wrapper.sh");
const GIT_WRAPPER = resolve(REPO_ROOT, "apps/sandbox-e2b/git-command-wrapper.sh");
const GH_WRAPPER = resolve(REPO_ROOT, "apps/sandbox-e2b/gh-command-wrapper.sh");
const WRAPPER_COMMAND_TIMEOUT_MS = 10_000;
const WRAPPER_TEST_TIMEOUT_MS = 120_000;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cycloid-command-wrapper-"));
  tempDirs.push(dir);
  return dir;
}

function makeRealBinary(name: string): { dir: string; path: string; logPath: string } {
  const dir = makeTempDir();
  const path = join(dir, name);
  const logPath = join(dir, `${name}.log`);
  writeFileSync(
    path,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$0 $*" >> "${logPath}"\nprintf 'real-%s %s\\n' "$(basename "$0")" "$*"\n`,
  );
  chmodSync(path, 0o755);
  return { dir, path, logPath };
}

function runWrapper(
  wrapper: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  try {
    const stdout = execFileSync("bash", [wrapper, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: WRAPPER_COMMAND_TIMEOUT_MS,
    });
    return { ok: true, stdout, stderr: "", status: 0 };
  } catch (error) {
    const err = error as Error & { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      ok: false,
      stdout: err.stdout?.toString("utf8") ?? "",
      stderr: err.stderr?.toString("utf8") ?? "",
      status: err.status ?? null,
    };
  }
}

function expectBlocked(result: ReturnType<typeof runWrapper>, message: string): void {
  expect(result.ok).toBe(false);
  expect(result.status).toBe(126);
  expect(result.stderr).toContain(message);
}

describe("sandbox curl command wrapper", () => {
  it(
    "passes allowlisted and local curl URLs through to the real binary",
    () => {
      const real = makeRealBinary("curl");
      const env = {
        ARCANIST_REAL_CURL_PATH: real.path,
        ARCANIST_SANDBOX_EGRESS_ALLOWLIST: "api.github.com,app.trycycloid.com",
      };

      expect(runWrapper(CURL_WRAPPER, ["https://api.github.com"], env)).toMatchObject({
        ok: true,
        stdout: "real-curl https://api.github.com\n",
      });
      expect(runWrapper(CURL_WRAPPER, ["http://127.0.0.1:3000/health"], env)).toMatchObject({
        ok: true,
        stdout: "real-curl http://127.0.0.1:3000/health\n",
      });

      const log = readFileSync(real.logPath, "utf8");
      expect(log).toContain("https://api.github.com");
      expect(log).toContain("http://127.0.0.1:3000/health");
    },
    WRAPPER_TEST_TIMEOUT_MS,
  );

  it(
    "blocks non-allowlisted public curl destinations before execing real curl",
    () => {
      const real = makeRealBinary("curl");
      const egressLog = join(makeTempDir(), "egress.log");
      const env = {
        ARCANIST_REAL_CURL_PATH: real.path,
        ARCANIST_EGRESS_LOG_PATH: egressLog,
        ARCANIST_SANDBOX_EGRESS_ALLOWLIST: "api.github.com",
      };

      const result = runWrapper(CURL_WRAPPER, ["https://www.cloudflare.com"], env);

      expectBlocked(result, "curl to non-allowlisted domain www.cloudflare.com");
      expect(readFileSync(egressLog, "utf8")).toContain("[egress] blocked domain=www.cloudflare.com tool=curl");
      expect(() => readFileSync(real.logPath, "utf8")).toThrow();
    },
    WRAPPER_TEST_TIMEOUT_MS,
  );
});

describe("sandbox git command wrapper", () => {
  it(
    "passes allowed git commands through to the real binary",
    () => {
      const real = makeRealBinary("git");
      const result = runWrapper(GIT_WRAPPER, ["status", "--porcelain"], { ARCANIST_REAL_GIT_PATH: real.path });

      expect(result).toMatchObject({ ok: true, stdout: "real-git status --porcelain\n" });
      expect(readFileSync(real.logPath, "utf8")).toContain("status --porcelain");
    },
    WRAPPER_TEST_TIMEOUT_MS,
  );

  it(
    "blocks direct publish and hook-bypass git commands before execing real git",
    () => {
      const real = makeRealBinary("git");
      const env = { ARCANIST_REAL_GIT_PATH: real.path };

      expectBlocked(runWrapper(GIT_WRAPPER, ["push", "origin", "main"], env), "git push");
      expectBlocked(runWrapper(GIT_WRAPPER, ["commit", "--no-verify", "-m", "x"], env), "git commit --no-verify");
      expectBlocked(
        runWrapper(GIT_WRAPPER, ["-c", "core.hooksPath=/tmp/x", "commit", "-m", "x"], env),
        "core.hooksPath",
      );
      expectBlocked(runWrapper(GIT_WRAPPER, ["-ccore.hooksPath=/tmp/x", "commit", "-m", "x"], env), "core.hooksPath");
      expectBlocked(
        runWrapper(GIT_WRAPPER, ["--config", "core.hooksPath=/tmp/x", "commit", "-m", "x"], env),
        "core.hooksPath",
      );
      expectBlocked(
        runWrapper(GIT_WRAPPER, ["--config=core.hooksPath=/tmp/x", "commit", "-m", "x"], env),
        "core.hooksPath",
      );
      expectBlocked(runWrapper(GIT_WRAPPER, ["config", "core.hooksPath", "/tmp/x"], env), "git config core.hooksPath");
      expectBlocked(runWrapper(GIT_WRAPPER, ["checkout", "-b", "feature"], env), "Branch creation");
      expectBlocked(runWrapper(GIT_WRAPPER, ["switch", "--create", "feature"], env), "Branch creation");
      expectBlocked(runWrapper(GIT_WRAPPER, ["worktree", "add", "../other"], env), "git worktree");
      expectBlocked(runWrapper(GIT_WRAPPER, ["rebase", "--interactive", "main"], env), "git rebase --interactive");

      expect(() => readFileSync(real.logPath, "utf8")).toThrow();
    },
    WRAPPER_TEST_TIMEOUT_MS,
  );

  it(
    "allows read-only core.hooksPath config inspection",
    () => {
      const real = makeRealBinary("git");
      const result = runWrapper(GIT_WRAPPER, ["config", "--get", "core.hooksPath"], {
        ARCANIST_REAL_GIT_PATH: real.path,
      });

      expect(result).toMatchObject({ ok: true });
      expect(readFileSync(real.logPath, "utf8")).toContain("config --get core.hooksPath");
    },
    WRAPPER_TEST_TIMEOUT_MS,
  );

  it(
    "blocks GIT_CONFIG_* core.hooksPath env bypasses",
    () => {
      const real = makeRealBinary("git");
      const result = runWrapper(GIT_WRAPPER, ["commit", "-m", "x"], {
        ARCANIST_REAL_GIT_PATH: real.path,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: "/tmp/x",
      });

      expectBlocked(result, "GIT_CONFIG_*");
      expect(() => readFileSync(real.logPath, "utf8")).toThrow();
    },
    WRAPPER_TEST_TIMEOUT_MS,
  );

  it(
    "blocks GIT_CONFIG_KEY values even when another env value contains a newline",
    () => {
      const real = makeRealBinary("git");
      const result = runWrapper(GIT_WRAPPER, ["commit", "-m", "x"], {
        ARCANIST_REAL_GIT_PATH: real.path,
        CYCLOID_MULTILINE_VALUE: "safe\nGIT_CONFIG_KEY_0=not-real",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: "/tmp/x",
      });

      expectBlocked(result, "GIT_CONFIG_*");
      expect(() => readFileSync(real.logPath, "utf8")).toThrow();
    },
    WRAPPER_TEST_TIMEOUT_MS,
  );

  it(
    "blocks through PATH lookup, command lookup, and bash -lc wrappers",
    () => {
      const real = makeRealBinary("git");
      const binDir = makeTempDir();
      const homeDir = makeTempDir();
      symlinkSync(GIT_WRAPPER, join(binDir, "git"));
      const env = {
        ARCANIST_REAL_GIT_PATH: real.path,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        HOME: homeDir,
      };
      writeFileSync(join(homeDir, ".bash_profile"), `export PATH="${binDir}:$PATH"\n`);

      const result = runWrapper(GIT_WRAPPER, ["--version"], env);
      expect(result.ok).toBe(true);

      const commands = ["git push", "command git push", `bash -lc 'export PATH="${binDir}:$PATH"; git push'`];
      for (const command of commands) {
        try {
          execFileSync("bash", ["-c", command], {
            encoding: "utf8",
            env: { ...process.env, ...env },
            timeout: WRAPPER_COMMAND_TIMEOUT_MS,
          });
          throw new Error(`expected command to fail: ${command}`);
        } catch (error) {
          const err = error as Error & { stderr?: Buffer; status?: number };
          expect(err.status).toBe(126);
          expect(err.stderr?.toString("utf8")).toContain("git push");
        }
      }
    },
    WRAPPER_TEST_TIMEOUT_MS,
  );

  it(
    "fails closed when a protected command is blocked even if the real binary is missing",
    () => {
      const result = runWrapper(GIT_WRAPPER, ["push"], { ARCANIST_REAL_GIT_PATH: "/missing/git" });

      expectBlocked(result, "git push");
    },
    WRAPPER_TEST_TIMEOUT_MS,
  );
});

describe("sandbox gh command wrapper", () => {
  it(
    "passes allowed gh commands through to the real binary",
    () => {
      const real = makeRealBinary("gh");
      const env = { ARCANIST_REAL_GH_PATH: real.path };

      expect(runWrapper(GH_WRAPPER, ["pr", "view", "123"], env)).toMatchObject({
        ok: true,
        stdout: "real-gh pr view 123\n",
      });
      expect(runWrapper(GH_WRAPPER, ["pr", "list", "--state", "merged"], env)).toMatchObject({ ok: true });
      expect(runWrapper(GH_WRAPPER, ["pr", "diff", "123"], env)).toMatchObject({ ok: true });
      expect(runWrapper(GH_WRAPPER, ["pr", "checks", "123"], env)).toMatchObject({ ok: true });
      expect(runWrapper(GH_WRAPPER, ["run", "view", "123"], env)).toMatchObject({ ok: true });
      expect(runWrapper(GH_WRAPPER, ["run", "list"], env)).toMatchObject({ ok: true });
      expect(runWrapper(GH_WRAPPER, ["run", "watch", "123"], env)).toMatchObject({ ok: true });
      expect(runWrapper(GH_WRAPPER, ["repo", "view"], env)).toMatchObject({ ok: true });

      const log = readFileSync(real.logPath, "utf8");
      expect(log).toContain("pr view 123");
      expect(log).toContain("pr list --state merged");
      expect(log).toContain("pr diff 123");
      expect(log).toContain("pr checks 123");
      expect(log).toContain("repo view");
    },
    WRAPPER_TEST_TIMEOUT_MS,
  );

  it(
    "passes subcommand-less version and help probes through (ready-check.sh depends on `gh --version`)",
    () => {
      const real = makeRealBinary("gh");
      const env = { ARCANIST_REAL_GH_PATH: real.path };

      expect(runWrapper(GH_WRAPPER, ["--version"], env)).toMatchObject({ ok: true });
      expect(runWrapper(GH_WRAPPER, ["--help"], env)).toMatchObject({ ok: true });
      expect(runWrapper(GH_WRAPPER, ["-v"], env)).toMatchObject({ ok: true });

      const log = readFileSync(real.logPath, "utf8");
      expect(log).toContain("--version");
    },
    WRAPPER_TEST_TIMEOUT_MS,
  );

  it(
    "blocks PR and issue mutation commands",
    () => {
      const real = makeRealBinary("gh");
      const env = { ARCANIST_REAL_GH_PATH: real.path };

      expectBlocked(runWrapper(GH_WRAPPER, ["pr", "create", "--title", "x"], env), "PR creation");
      expectBlocked(runWrapper(GH_WRAPPER, ["pr", "close", "1"], env), "session capability");
      expectBlocked(runWrapper(GH_WRAPPER, ["pr", "merge", "1"], env), "PR management");
      expectBlocked(runWrapper(GH_WRAPPER, ["pr", "reopen", "1"], env), "session capability");
      expectBlocked(runWrapper(GH_WRAPPER, ["pr", "edit", "1", "--title", "x"], env), "session capability");
      expectBlocked(runWrapper(GH_WRAPPER, ["issue", "close", "1"], env), "Issue management");
      expectBlocked(runWrapper(GH_WRAPPER, ["issue", "reopen", "1"], env), "Issue management");
      expectBlocked(runWrapper(GH_WRAPPER, ["issue", "delete", "1"], env), "Issue management");

      expect(() => readFileSync(real.logPath, "utf8")).toThrow();
    },
    WRAPPER_TEST_TIMEOUT_MS,
  );

  it(
    "blocks mutating API and browser-opening commands but allows read-only API calls",
    () => {
      const real = makeRealBinary("gh");
      const env = { ARCANIST_REAL_GH_PATH: real.path };

      expectBlocked(runWrapper(GH_WRAPPER, ["api", "-X", "POST", "/repos/o/r"], env), "Mutating GitHub API");
      expectBlocked(runWrapper(GH_WRAPPER, ["api", "--method=PATCH", "/repos/o/r"], env), "Mutating GitHub API");
      expectBlocked(runWrapper(GH_WRAPPER, ["api", "/repos/o/r", "--field", "name=x"], env), "Mutating GitHub API");
      expectBlocked(runWrapper(GH_WRAPPER, ["api", "/repos/o/r", "-f", "name=x"], env), "Mutating GitHub API");
      expectBlocked(runWrapper(GH_WRAPPER, ["api", "/repos/o/r", "--raw-field=name=x"], env), "Mutating GitHub API");
      expectBlocked(
        runWrapper(GH_WRAPPER, ["api", "/repos/o/r", "--input", "payload.json"], env),
        "Mutating GitHub API",
      );
      expectBlocked(
        runWrapper(GH_WRAPPER, ["api", "graphql", "-f", "query={viewer{login}}"], env),
        "Mutating GitHub API",
      );
      expectBlocked(runWrapper(GH_WRAPPER, ["browse"], env), "Browser commands");
      expectBlocked(runWrapper(GH_WRAPPER, ["pr", "view", "1", "--web"], env), "Browser commands");
      expectBlocked(runWrapper(GH_WRAPPER, ["repo", "view", "--web"], env), "Browser commands");

      const readOnly = runWrapper(GH_WRAPPER, ["api", "-X", "GET", "/repos/o/r"], env);
      expect(readOnly).toMatchObject({ ok: true });
      expect(readFileSync(real.logPath, "utf8")).toContain("api -X GET /repos/o/r");

      expect(runWrapper(GH_WRAPPER, ["api", "repos/o/r"], env)).toMatchObject({ ok: true });
    },
    WRAPPER_TEST_TIMEOUT_MS,
  );

  it(
    "delegates read-only gh commands that the runtime shim allows",
    () => {
      const real = makeRealBinary("gh");
      const env = { ARCANIST_REAL_GH_PATH: real.path };

      expect(runWrapper(GH_WRAPPER, ["pr", "list"], env)).toMatchObject({ ok: true });
      expect(runWrapper(GH_WRAPPER, ["pr", "diff", "123"], env)).toMatchObject({ ok: true });
      expect(runWrapper(GH_WRAPPER, ["pr", "checks", "123"], env)).toMatchObject({ ok: true });

      const log = readFileSync(real.logPath, "utf8");
      expect(log).toContain("pr list");
      expect(log).toContain("pr diff 123");
      expect(log).toContain("pr checks 123");
    },
    WRAPPER_TEST_TIMEOUT_MS,
  );
});
