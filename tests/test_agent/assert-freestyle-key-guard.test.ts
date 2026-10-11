import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// The always-on prod deploy step (ARC-1492) that re-adds the Freestyle-key guard
// runs this script. It re-derives the outage: the reverted step fetched with the
// denied `ssm:GetParameter`, masked the AccessDenied to an empty value, and failed
// closed — blocking every prod deploy. This exercises the whole script against a
// stubbed `aws` on PATH so the fetch-error, definitively-absent, and placeholder
// branches are locked, without touching real AWS.
const scriptPath = path.resolve(import.meta.dirname, "../../scripts/assert-freestyle-key.mjs");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Throwaway repo whose wrangler.toml drives the per-env Freestyle override + snapshot
// id. The script (via the validator) reads apps/control-plane-worker/wrangler.toml
// relative to cwd, so tests set cwd here. `prodOverrideRaw` writes the override RHS
// verbatim (no quoting) to exercise the present-but-unparseable branch.
function fixtureRepo(
  prodOverride: string,
  { prodSnapshotId = "snap-prod", prodOverrideRaw }: { prodSnapshotId?: string; prodOverrideRaw?: string } = {},
): string {
  const repo = mkdtempSync(path.join(tmpdir(), "assert-freestyle-"));
  tempDirs.push(repo);
  const tomlPath = path.join(repo, "apps", "control-plane-worker", "wrangler.toml");
  mkdirSync(path.dirname(tomlPath), { recursive: true });
  writeFileSync(
    tomlPath,
    [
      "[vars]",
      `FREESTYLE_SANDBOX_BACKEND_OVERRIDE = ${prodOverrideRaw ?? `"${prodOverride}"`}`,
      `FREESTYLE_DEFAULT_SNAPSHOT_ID = "${prodSnapshotId}"`,
      "",
      "[env.qa.vars]",
      'FREESTYLE_SANDBOX_BACKEND_OVERRIDE = ""',
      'FREESTYLE_DEFAULT_SNAPSHOT_ID = ""',
      "",
    ].join("\n"),
  );
  return repo;
}

type AwsMode = "fail" | "real" | "change_me" | "absent" | "garbage";

// Write an executable `aws` shim into a fresh bin dir. The script invokes
// `aws ssm get-parameters-by-path ...`; the shim ignores the args and emits the
// fixture output (or fails) for the requested mode, mimicking the CLI's
// non-recursive path-read JSON: [{ Name, Value }, ...].
function fakeAwsBin(mode: AwsMode): string {
  const binDir = mkdtempSync(path.join(tmpdir(), "fake-aws-bin-"));
  tempDirs.push(binDir);
  const body: Record<AwsMode, string> = {
    fail: 'echo "An error occurred (AccessDeniedException) when calling GetParameter" >&2\nexit 255',
    real: `printf '%s' '[{"Name":"/cycloid/FREESTYLE_API_KEY","Value":"fs-real-key"}]'`,
    change_me: `printf '%s' '[{"Name":"/cycloid/FREESTYLE_API_KEY","Value":"CHANGE_ME"}]'`,
    absent: `printf '%s' '[{"Name":"/cycloid/E2B_API_KEY","Value":"e2b-key"}]'`,
    garbage: `printf '%s' 'not json{'`,
  };
  const awsPath = path.join(binDir, "aws");
  writeFileSync(awsPath, `#!/bin/bash\n${body[mode]}\n`);
  chmodSync(awsPath, 0o755);
  return binDir;
}

interface RunResult {
  ok: boolean;
  status: number | null;
  stderr: string;
  stdout: string;
}

// Run the guard with `binDir` prepended to PATH so its `aws` shim shadows any real
// aws. Pass binDir=null to test the aws-not-found (ENOENT) branch: PATH points at an
// empty dir so `aws` cannot resolve at all.
function runGuard(cwd: string, binDir: string | null, args: string[] = ["--env=production"]): RunResult {
  const pathDir = binDir ?? mkdtempSync(path.join(tmpdir(), "empty-bin-"));
  if (!binDir) tempDirs.push(pathDir);
  // spawnSync (not execFileSync) so stderr is captured on exit 0 too — the skip path
  // warns to stderr then exits 0, and that warning is what the skip tests assert on.
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, PATH: binDir ? `${pathDir}:${process.env.PATH ?? ""}` : pathDir },
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

describe("assert-freestyle-key guard (ARC-1492)", () => {
  it("does NOT block the deploy when the SSM fetch fails (the outage regression)", () => {
    // Routing on, but aws returns non-zero (AccessDenied). A fetch failure must never
    // be treated as an absent key — that is exactly what broke every prod deploy.
    const repo = fixtureRepo("org:trycycloid");
    const result = runGuard(repo, fakeAwsBin("fail"));
    expect(result.ok).toBe(true);
    expect(`${result.stdout}${result.stderr}`).toContain("skipped");
  });

  it("does NOT block the deploy when aws is unavailable (spawn ENOENT)", () => {
    const repo = fixtureRepo("org:trycycloid");
    const result = runGuard(repo, null);
    expect(result.ok).toBe(true);
    expect(`${result.stdout}${result.stderr}`).toContain("skipped");
  });

  it("does NOT block the deploy when the fetch returns unparseable output", () => {
    const repo = fixtureRepo("org:trycycloid");
    const result = runGuard(repo, fakeAwsBin("garbage"));
    expect(result.ok).toBe(true);
    expect(`${result.stdout}${result.stderr}`).toContain("skipped");
  });

  it("passes when routing is on and the SSM key is real", () => {
    const repo = fixtureRepo("org:trycycloid");
    expect(runGuard(repo, fakeAwsBin("real")).ok).toBe(true);
  });

  it("BLOCKS the deploy when a successful fetch shows a CHANGE_ME placeholder", () => {
    const repo = fixtureRepo("org:trycycloid");
    const result = runGuard(repo, fakeAwsBin("change_me"));
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("FREESTYLE_API_KEY is missing");
  });

  it("BLOCKS the deploy when a successful fetch shows the key is definitively absent", () => {
    const repo = fixtureRepo("org:trycycloid");
    const result = runGuard(repo, fakeAwsBin("absent"));
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("FREESTYLE_API_KEY is missing");
  });

  it("no-ops (passes) when Freestyle routing is off, even with a placeholder key", () => {
    const repo = fixtureRepo("");
    expect(runGuard(repo, fakeAwsBin("change_me")).ok).toBe(true);
  });

  it("BLOCKS when routing is on and the snapshot id is missing, even with a real key", () => {
    // The --freestyle-only validator also gates the snapshot id (ARC-1480); this
    // restores that deploy-time signal on non-sync prod deploys.
    const repo = fixtureRepo("org:trycycloid", { prodSnapshotId: "" });
    const result = runGuard(repo, fakeAwsBin("real"));
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("FREESTYLE_DEFAULT_SNAPSHOT_ID is missing");
  });

  it("BLOCKS the deploy when the committed override var is present but unparseable (ARC-1483)", () => {
    // A bare (unquoted) override token is a committed config defect, not an SSM hiccup:
    // it must exit 1 via the readWranglerVar throw, never route through skip() (exit 0),
    // which would silently disarm this guard while routing may be live.
    const repo = fixtureRepo("", { prodOverrideRaw: "org:trycycloid" });
    const result = runGuard(repo, fakeAwsBin("real"));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported value format");
    expect(`${result.stdout}${result.stderr}`).not.toContain("skipped");
  });
});
