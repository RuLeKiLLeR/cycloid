import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { resolveRuntimeTemplateId } from "../../apps/control-plane-worker/src/sandbox/repo-sandbox-specs";
import { computeTemplateContentHash } from "../../apps/sandbox-e2b/template";
import { IMAGE_ADVERTISED_AGENT_RUNTIME_BACKENDS } from "../../shared/agent/agent-runtime-backend";

const REPO_ROOT = resolve(__dirname, "../..");
const SCRIPT = resolve(REPO_ROOT, "scripts/e2b-template-build.sh");
const BRIDGE_BUNDLE = resolve(REPO_ROOT, "apps/sandbox-bridge/dist/bundle.js");
const BUILD_SCRIPT_SOURCE = readFileSync(SCRIPT, "utf8");

// The capabilities header the build prints first; mirrors the shared constant the control plane
// reads, locked byte-identical by the drift test below.
const BACKENDS_LINE = `E2B_SANDBOX_TEMPLATE_AGENT_BACKENDS=${IMAGE_ADVERTISED_AGENT_RUNTIME_BACKENDS.join(",")}`;

function runTemplateScript(args: string[]) {
  return spawnSync("bash", [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, USER: "testuser" },
  });
}

function printedTemplate(args: string[]): string {
  const result = runTemplateScript([...args, "--print-template"]);
  expect(result.status).toBe(0);
  const line = result.stdout
    .trim()
    .split("\n")
    .find((l) => l.startsWith("E2B_SANDBOX_TEMPLATE="));
  if (!line) throw new Error(`no E2B_SANDBOX_TEMPLATE line in: ${result.stdout}`);
  return line.slice("E2B_SANDBOX_TEMPLATE=".length);
}

function withDummyBridgeBundle(contents: string): void {
  const hadBundle = existsSync(BRIDGE_BUNDLE);
  const original = hadBundle ? readFileSync(BRIDGE_BUNDLE) : null;
  mkdirSync(dirname(BRIDGE_BUNDLE), { recursive: true });
  writeFileSync(BRIDGE_BUNDLE, contents);
  onTestFinished(() => {
    if (original) {
      writeFileSync(BRIDGE_BUNDLE, original);
    } else {
      rmSync(BRIDGE_BUNDLE, { force: true });
    }
  });
}

// The CLI defaults the build script relies on (template.ts TEMPLATE_MEMORY_MB / TEMPLATE_CPU_COUNT).
const DEFAULT_SIZING = { memoryMB: 4096, cpuCount: 2 };

function templateContentHash(sizing: { memoryMB: number; cpuCount: number } = DEFAULT_SIZING): string {
  return computeTemplateContentHash(sizing);
}

function runTemplateScriptWithFakeNpm(args: string[], options: { npmBody?: string; curlBody?: string } = {}) {
  const binDir = mkdtempSync(resolve(tmpdir(), "template-build-bin-"));
  onTestFinished(() => rmSync(binDir, { recursive: true, force: true }));
  const npmLogPath = resolve(binDir, "npm.log");
  const sleepLogPath = resolve(binDir, "sleep.log");
  const curlLogPath = resolve(binDir, "curl.log");
  const fakeNpmPath = resolve(binDir, "npm");
  const fakeSleepPath = resolve(binDir, "sleep");
  const fakeCurlPath = resolve(binDir, "curl");

  writeFileSync(
    fakeNpmPath,
    `#!/usr/bin/env bash
set -euo pipefail
# Each invocation appends one complete line; O_APPEND makes the shared log safe
# when concurrent template builds write at the same time.
printf '%s\n' "$*" >> ${JSON.stringify(npmLogPath)}
${options.npmBody ?? ""}
if [[ "$*" == *"--print-content-hash"* ]]; then
  memory="4096"
  cpu="2"
  previous=""
  for arg in "$@"; do
    if [ "$previous" = "--memory-mb" ]; then memory="$arg"; fi
    if [ "$previous" = "--cpu-count" ]; then cpu="$arg"; fi
    previous="$arg"
  done
  echo "E2B_TEMPLATE_CONTENT_HASH=hash-$memory-$cpu"
  exit 0
fi
`,
    { mode: 0o755 },
  );

  writeFileSync(
    fakeSleepPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(sleepLogPath)}
`,
    { mode: 0o755 },
  );

  writeFileSync(
    fakeCurlPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(curlLogPath)}
${options.curlBody ?? 'echo "curl called unexpectedly" >&2; exit 1'}
`,
    { mode: 0o755 },
  );

  const result = spawnSync("bash", [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      BASH_ENV: "",
      USER: "testuser",
      FAKE_NPM_STATE_DIR: binDir,
      CI_AUTOMATION_TOKEN: "test-ci-token",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });

  const npmLog = existsSync(npmLogPath) ? readFileSync(npmLogPath, "utf8").trim() : "";
  const sleepLog = existsSync(sleepLogPath) ? readFileSync(sleepLogPath, "utf8").trim() : "";
  const curlLog = existsSync(curlLogPath) ? readFileSync(curlLogPath, "utf8").trim() : "";
  return { result, npmLog, sleepLog, curlLog };
}

describe("e2b template build script", () => {
  it("streams template build logs instead of hiding them in command substitutions", () => {
    expect(BUILD_SCRIPT_SOURCE).toContain('2>&1 | tee "$output_file" >&2');
    expect(BUILD_SCRIPT_SOURCE).toContain('2>&1 | tee "$output_path" >&2');
    expect(BUILD_SCRIPT_SOURCE).not.toContain('build_output="$(build_template_with_retries');
  });

  it("prints the default dev template with the default resource suffix", () => {
    const result = runTemplateScript(["--dev", "--print-template"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      `${BACKENDS_LINE}\nE2B_SANDBOX_TEMPLATE=cycloid-sandbox-dev-testuser-mem4096-cpu2`,
    );
  });

  it("prints the prod default template as arc-default-template-mem4096-cpu2", () => {
    const result = runTemplateScript(["--prod", "--print-template"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`${BACKENDS_LINE}\nE2B_SANDBOX_TEMPLATE=arc-default-template-mem4096-cpu2`);
  });

  it("prints the qa default template from the stable stem", () => {
    const result = runTemplateScript(["--qa", "--print-template"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`${BACKENDS_LINE}\nE2B_SANDBOX_TEMPLATE=cycloid-sandbox-qa-mem4096-cpu2`);
  });

  it("registers the stable stem's default + repo-spec tiers with --include-repo-spec-templates", () => {
    const result = runTemplateScript(["--qa", "--include-repo-spec-templates", "--print-template"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      BACKENDS_LINE,
      "E2B_SANDBOX_TEMPLATE=cycloid-sandbox-qa-mem4096-cpu2",
      "E2B_REPO_SANDBOX_TEMPLATE=trycycloid/cycloid:cycloid-sandbox-qa-mem8192-cpu4",
      "E2B_REPO_SANDBOX_TEMPLATE=mialabs/mia:cycloid-sandbox-qa-mem8192-cpu4",
      "E2B_REPO_SANDBOX_TEMPLATE=trycycloid/mia-copy-4:cycloid-sandbox-qa-mem8192-cpu4",
    ]);
    expect(result.stderr).toContain("skipping repo-spec openevidence/xyla (16384 MiB > QA cap 8192 MiB)");
  });

  it("keeps prod repo-spec tiers unchanged with --include-repo-spec-templates", () => {
    const result = runTemplateScript(["--prod", "--include-repo-spec-templates", "--print-template"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      BACKENDS_LINE,
      "E2B_SANDBOX_TEMPLATE=arc-default-template-mem4096-cpu2",
      "E2B_REPO_SANDBOX_TEMPLATE=trycycloid/cycloid:arc-default-template-mem8192-cpu4",
      "E2B_REPO_SANDBOX_TEMPLATE=openevidence/xyla:arc-default-template-mem16384-cpu4",
      "E2B_REPO_SANDBOX_TEMPLATE=mialabs/mia:arc-default-template-mem8192-cpu4",
      "E2B_REPO_SANDBOX_TEMPLATE=trycycloid/mia-copy-4:arc-default-template-mem8192-cpu4",
    ]);
    expect(result.stderr).toBe("");
  });

  it("rejects a bare qa-* tag (the worker expects the cycloid-sandbox-qa stem)", () => {
    const result = runTemplateScript(["--tag", "qa-something", "--print-template"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ambiguous QA template tag");
  });

  it("appends the derived resource suffix for named environment templates", () => {
    const result = runTemplateScript(["--qa", "--memory-mb", "8192", "--cpu-count", "4", "--print-template"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`${BACKENDS_LINE}\nE2B_SANDBOX_TEMPLATE=cycloid-sandbox-qa-mem8192-cpu4`);
  });

  it("keeps --tag as an exact template name while passing resource options to the builder", () => {
    const result = runTemplateScript(["--tag", "custom-template", "--memory-mb", "8192", "--print-template"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`${BACKENDS_LINE}\nE2B_SANDBOX_TEMPLATE=custom-template`);
  });

  it("prints repo-specific resource templates when requested", () => {
    const result = runTemplateScript([
      "--tag",
      "cycloid-sandbox-qa-abc123",
      "--include-repo-spec-templates",
      "--print-template",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      BACKENDS_LINE,
      "E2B_SANDBOX_TEMPLATE=cycloid-sandbox-qa-abc123",
      "E2B_REPO_SANDBOX_TEMPLATE=trycycloid/cycloid:cycloid-sandbox-qa-abc123-mem8192-cpu4",
      "E2B_REPO_SANDBOX_TEMPLATE=openevidence/xyla:cycloid-sandbox-qa-abc123-mem16384-cpu4",
      "E2B_REPO_SANDBOX_TEMPLATE=mialabs/mia:cycloid-sandbox-qa-abc123-mem8192-cpu4",
      "E2B_REPO_SANDBOX_TEMPLATE=trycycloid/mia-copy-4:cycloid-sandbox-qa-abc123-mem8192-cpu4",
    ]);
  });

  // The bash resource_template_name formatter and the TS resolveRuntimeTemplateId
  // formatter are linked only by a "Mirrors" comment. If they drift, the worker
  // requests a name the build never registers and every spawn 404s. Lock the two
  // sources to byte-identical output for default and bumped tiers.
  it("bash --print-template agrees with the TS resolveRuntimeTemplateId formatter", () => {
    expect(printedTemplate(["--prod"])).toBe(
      resolveRuntimeTemplateId("arc-default-template", { cpuCount: 2, memoryMB: 4096 }),
    );
    expect(printedTemplate(["--prod", "--memory-mb", "8192", "--cpu-count", "4"])).toBe(
      resolveRuntimeTemplateId("arc-default-template", { cpuCount: 4, memoryMB: 8192 }),
    );
    expect(printedTemplate(["--qa"])).toBe(
      resolveRuntimeTemplateId("cycloid-sandbox-qa", { cpuCount: 2, memoryMB: 4096 }),
    );
  });

  // The bash capabilities header is hardcoded; the control plane reads the advertised backends from
  // IMAGE_ADVERTISED_AGENT_RUNTIME_BACKENDS. If they drift, registration records the wrong backends
  // and the opencode spawn preflight gates the wrong sessions. Lock the two to identical output.
  it("bash --print-template advertises exactly IMAGE_ADVERTISED_AGENT_RUNTIME_BACKENDS", () => {
    const result = runTemplateScript(["--prod", "--print-template"]);
    expect(result.status).toBe(0);
    const line = result.stdout
      .trim()
      .split("\n")
      .find((l) => l.startsWith("E2B_SANDBOX_TEMPLATE_AGENT_BACKENDS="));
    expect(line).toBe(BACKENDS_LINE);
  });

  it("template content hash is stable and changes with copied bytes and resource sizing", () => {
    withDummyBridgeBundle("bundle-v1");
    const first = templateContentHash();
    expect(templateContentHash()).toBe(first);

    writeFileSync(BRIDGE_BUNDLE, "bundle-v2");
    expect(templateContentHash()).not.toBe(first);

    writeFileSync(BRIDGE_BUNDLE, "bundle-v1");
    expect(templateContentHash({ memoryMB: 8192, cpuCount: 4 })).not.toBe(first);
  });

  it("builds templates without the deleted GitHub Meta refresh helper", () => {
    const { result, npmLog } = runTemplateScriptWithFakeNpm(["--dev", "--skip-bundles"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("E2B_SANDBOX_TEMPLATE=cycloid-sandbox-dev-testuser-mem4096-cpu2");
    expect(result.stderr).toContain("E2B template build summary: succeeded=cycloid-sandbox-dev-testuser-mem4096-cpu2");
    expect(result.stderr).toContain("failed=none");
    expect(npmLog).not.toContain("--print-content-hash");
    expect(npmLog.split("\n").at(-1)).toBe(
      "run -w @cycloid/sandbox-e2b build-template -- --name cycloid-sandbox-dev-testuser-mem4096-cpu2 --memory-mb 4096 --cpu-count 2",
    );
  });

  it("skips the 16 GiB repo-spec build in QA", () => {
    const { result, npmLog } = runTemplateScriptWithFakeNpm([
      "--qa",
      "--include-repo-spec-templates",
      "--skip-bundles",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("E2B_SANDBOX_TEMPLATE=cycloid-sandbox-qa-mem4096-cpu2");
    expect(result.stdout).toContain("E2B_REPO_SANDBOX_TEMPLATE=trycycloid/cycloid:cycloid-sandbox-qa-mem8192-cpu4");
    expect(result.stdout).not.toContain("mem16384");
    expect(result.stderr).toContain("skipping repo-spec openevidence/xyla (16384 MiB > QA cap 8192 MiB)");
    expect(result.stderr).toContain(
      "E2B template build summary: succeeded=cycloid-sandbox-qa-mem4096-cpu2,cycloid-sandbox-qa-mem8192-cpu4",
    );
    expect(npmLog).toContain("--memory-mb 4096");
    expect(npmLog).toContain("--memory-mb 8192");
    expect(npmLog).not.toContain("--memory-mb 16384");
  });

  it("keeps the 16 GiB repo-spec build in prod", () => {
    const { result, npmLog } = runTemplateScriptWithFakeNpm([
      "--prod",
      "--include-repo-spec-templates",
      "--skip-bundles",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("E2B_SANDBOX_TEMPLATE=arc-default-template-mem4096-cpu2");
    expect(result.stdout).toContain("E2B_REPO_SANDBOX_TEMPLATE=openevidence/xyla:arc-default-template-mem16384-cpu4");
    expect(result.stderr).toContain(
      "E2B template build summary: succeeded=arc-default-template-mem4096-cpu2,arc-default-template-mem8192-cpu4,arc-default-template-mem16384-cpu4",
    );
    expect(result.stderr).toContain("failed=none");
    expect(npmLog).toContain("--memory-mb 4096");
    expect(npmLog).toContain("--memory-mb 8192");
    expect(npmLog).toContain("--memory-mb 16384");
  });

  it("runs template builds concurrently and collects mixed outcomes in launch order", () => {
    const { result, npmLog } = runTemplateScriptWithFakeNpm(
      [
        "--prod",
        "--include-repo-spec-templates",
        "--skip-bundles",
        "--skip-matching-registry",
        "--registry-url",
        "https://api.example.test",
      ],
      {
        npmBody: `
if [[ "$*" == *"--name arc-default-template-mem8192-cpu4"* ]]; then
  for attempt in $(seq 1 100); do
    [ -f "$FAKE_NPM_STATE_DIR/first-started" ] && break
    /bin/sleep 0.01
  done
  if [ ! -f "$FAKE_NPM_STATE_DIR/first-started" ]; then
    echo "concurrency regression: first build did not start" >&2
    exit 1
  fi
  touch "$FAKE_NPM_STATE_DIR/second-started"
  echo "second build failed" >&2
  exit 1
fi
if [[ "$*" == *"--name arc-default-template-mem16384-cpu4"* ]]; then
  touch "$FAKE_NPM_STATE_DIR/first-started"
  for attempt in $(seq 1 100); do
    [ -f "$FAKE_NPM_STATE_DIR/second-started" ] && break
    /bin/sleep 0.01
  done
  if [ ! -f "$FAKE_NPM_STATE_DIR/second-started" ]; then
    echo "concurrency regression: second build did not start" >&2
    exit 1
  fi
  echo "third build failed" >&2
  exit 1
fi
if [[ "$*" == *"--name arc-default-template-mem4096-cpu2"* ]]; then
  echo "unexpected skipped build" >&2
  exit 1
fi
`,
        curlBody: `
output=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "-o" ]; then output="$arg"; fi
  previous="$arg"
done
if [[ "$*" == *"resourceProfileKey=default"* ]]; then
  printf '{"ok":true,"current":{"contentHash":"hash-4096-2"}}' > "$output"
else
  printf '{"ok":true,"current":{"contentHash":"old-hash"}}' > "$output"
fi
printf '200'
`,
      },
    );

    expect(result.status).toBe(1);
    expect(npmLog).not.toContain("--name arc-default-template-mem4096-cpu2");
    expect(result.stderr).toContain(
      "E2B template build summary: succeeded=arc-default-template-mem4096-cpu2; skipped=arc-default-template-mem4096-cpu2; retried=none; failed=arc-default-template-mem8192-cpu4,arc-default-template-mem16384-cpu4",
    );
    expect(result.stderr).toContain("second build failed");
    expect(result.stderr).toContain("third build failed");
  });

  it("retries a transient E2B internal build error and succeeds", () => {
    const { result, npmLog, sleepLog } = runTemplateScriptWithFakeNpm(["--dev", "--skip-bundles"], {
      npmBody: `
if [[ "$*" == *"--name cycloid-sandbox-dev-testuser-mem4096-cpu2"* && ! -f "$FAKE_NPM_STATE_DIR/transient-seen" ]]; then
  touch "$FAKE_NPM_STATE_DIR/transient-seen"
  echo "[finalize] Finalizing template build" >&2
  echo "ERROR Build failed: An internal error occurred. Please try again or contact support with the build ID." >&2
  exit 1
fi
`,
    });

    expect(result.status).toBe(0);
    expect(npmLog.split("\n").filter((line) => !line.includes("--print-content-hash"))).toEqual([
      "run -w @cycloid/sandbox-e2b build-template -- --name cycloid-sandbox-dev-testuser-mem4096-cpu2 --memory-mb 4096 --cpu-count 2",
      "run -w @cycloid/sandbox-e2b build-template -- --name cycloid-sandbox-dev-testuser-mem4096-cpu2 --memory-mb 4096 --cpu-count 2",
    ]);
    expect(sleepLog).toBe("10");
    expect(result.stderr).toContain("retrying in 10s");
    expect(result.stderr).toContain("retried=cycloid-sandbox-dev-testuser-mem4096-cpu2(2 attempts)");
    expect(result.stderr).toContain("failed=none");
  });

  it("matches transient E2B internal build errors case-insensitively", () => {
    const { result, npmLog, sleepLog } = runTemplateScriptWithFakeNpm(["--dev", "--skip-bundles"], {
      npmBody: `
if [[ "$*" == *"--name cycloid-sandbox-dev-testuser-mem4096-cpu2"* && ! -f "$FAKE_NPM_STATE_DIR/transient-seen" ]]; then
  touch "$FAKE_NPM_STATE_DIR/transient-seen"
  echo "ERROR Build failed: AN INTERNAL ERROR OCCURRED. Please try again or contact support with the build ID." >&2
  exit 1
fi
`,
    });

    expect(result.status).toBe(0);
    expect(npmLog.split("\n")).toHaveLength(2);
    expect(sleepLog).toBe("10");
    expect(result.stderr).toContain("retried=cycloid-sandbox-dev-testuser-mem4096-cpu2(2 attempts)");
  });

  it("keeps building sibling templates after a transient failure exhausts retries", () => {
    const { result, npmLog, sleepLog } = runTemplateScriptWithFakeNpm(
      ["--prod", "--include-repo-spec-templates", "--skip-bundles"],
      {
        npmBody: `
if [[ "$*" == *"--name arc-default-template-mem8192-cpu4"* ]]; then
  echo "[finalize] Finalizing template build" >&2
  echo "ERROR Build failed: An internal error occurred. Please try again or contact support with the build ID." >&2
  exit 1
fi
`,
      },
    );

    expect(result.status).toBe(1);
    const npmLines = npmLog.split("\n").filter((line) => !line.includes("--print-content-hash"));
    expect(npmLines.filter((line) => line.includes("--name arc-default-template-mem4096-cpu2"))).toHaveLength(1);
    expect(npmLines.filter((line) => line.includes("--name arc-default-template-mem8192-cpu4"))).toHaveLength(3);
    expect(npmLines.filter((line) => line.includes("--name arc-default-template-mem16384-cpu4"))).toHaveLength(1);
    expect(sleepLog.split("\n")).toEqual(["10", "30"]);
    expect(result.stderr).toContain("succeeded=arc-default-template-mem4096-cpu2,arc-default-template-mem16384-cpu4");
    expect(result.stderr).toContain("retried=arc-default-template-mem8192-cpu4(3 attempts)");
    expect(result.stderr).toContain("failed=arc-default-template-mem8192-cpu4");
  });

  it("counts template build attempts with fixed-string template names", () => {
    const { result, npmLog } = runTemplateScriptWithFakeNpm(["--tag", "custom.template[prod]", "--skip-bundles"], {
      npmBody: `
if [[ "$*" == *"--name custom.template[prod]"* && ! -f "$FAKE_NPM_STATE_DIR/transient-seen" ]]; then
  touch "$FAKE_NPM_STATE_DIR/transient-seen"
  echo "ERROR Build failed: An internal error occurred. Please try again or contact support with the build ID." >&2
  exit 1
fi
`,
    });

    expect(result.status).toBe(0);
    expect(npmLog.split("\n")).toHaveLength(2);
    expect(result.stderr).toContain("retried=custom.template[prod](2 attempts)");
  });

  it("fails deterministic build errors without retrying", () => {
    const { result, npmLog, sleepLog } = runTemplateScriptWithFakeNpm(["--dev", "--skip-bundles"], {
      npmBody: `
echo "error: E2B_API_KEY is required" >&2
exit 1
`,
    });

    expect(result.status).toBe(1);
    expect(npmLog.split("\n").filter((line) => !line.includes("--print-content-hash"))).toHaveLength(1);
    expect(sleepLog).toBe("");
    expect(result.stderr).toContain("failed with a non-retryable build error");
    expect(result.stderr).toContain("retried=none");
    expect(result.stderr).toContain("failed=cycloid-sandbox-dev-testuser-mem4096-cpu2");
  });

  it("prints content hashes alongside template names when requested", () => {
    const { result } = runTemplateScriptWithFakeNpm([
      "--prod",
      "--include-repo-spec-templates",
      "--skip-bundles",
      "--print-template",
      "--print-content-hashes",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      BACKENDS_LINE,
      "E2B_SANDBOX_TEMPLATE=arc-default-template-mem4096-cpu2",
      "E2B_SANDBOX_TEMPLATE_CONTENT_HASH=hash-4096-2",
      "E2B_REPO_SANDBOX_TEMPLATE=trycycloid/cycloid:arc-default-template-mem8192-cpu4",
      "E2B_REPO_SANDBOX_TEMPLATE_CONTENT_HASH=trycycloid/cycloid:hash-8192-4",
      "E2B_REPO_SANDBOX_TEMPLATE=openevidence/xyla:arc-default-template-mem16384-cpu4",
      "E2B_REPO_SANDBOX_TEMPLATE_CONTENT_HASH=openevidence/xyla:hash-16384-4",
      "E2B_REPO_SANDBOX_TEMPLATE=mialabs/mia:arc-default-template-mem8192-cpu4",
      "E2B_REPO_SANDBOX_TEMPLATE_CONTENT_HASH=mialabs/mia:hash-8192-4",
      "E2B_REPO_SANDBOX_TEMPLATE=trycycloid/mia-copy-4:arc-default-template-mem8192-cpu4",
      "E2B_REPO_SANDBOX_TEMPLATE_CONTENT_HASH=trycycloid/mia-copy-4:hash-8192-4",
    ]);
  });

  it("skips a template build when the registry content hash matches", () => {
    const { result, npmLog, curlLog } = runTemplateScriptWithFakeNpm(
      ["--dev", "--skip-bundles", "--skip-matching-registry", "--registry-url", "https://api.example.test"],
      {
        curlBody: `
output=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "-o" ]; then output="$arg"; fi
  previous="$arg"
done
printf '{"ok":true,"current":{"contentHash":"hash-4096-2"}}' > "$output"
printf '200'
`,
      },
    );

    expect(result.status).toBe(0);
    expect(npmLog.split("\n").filter((line) => !line.includes("--print-content-hash"))).toEqual([]);
    expect(curlLog).toContain("/api/admin/sandbox-base-templates/current");
    expect(result.stderr).toContain("skipping E2B template cycloid-sandbox-dev-testuser-mem4096-cpu2");
    expect(result.stderr).toContain("skipped=cycloid-sandbox-dev-testuser-mem4096-cpu2");
  });

  it("builds when the registry content hash mismatches", () => {
    const { result, npmLog } = runTemplateScriptWithFakeNpm(
      ["--dev", "--skip-bundles", "--skip-matching-registry", "--registry-url", "https://api.example.test"],
      {
        curlBody: `
output=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "-o" ]; then output="$arg"; fi
  previous="$arg"
done
printf '{"ok":true,"current":{"contentHash":"old-hash"}}' > "$output"
printf '200'
`,
      },
    );

    expect(result.status).toBe(0);
    expect(npmLog.split("\n").filter((line) => !line.includes("--print-content-hash"))).toEqual([
      "run -w @cycloid/sandbox-e2b build-template -- --name cycloid-sandbox-dev-testuser-mem4096-cpu2 --memory-mb 4096 --cpu-count 2",
    ]);
    expect(result.stderr).toContain("skipped=none");
    expect(result.stderr).toContain("failed=none");
  });

  it("force rebuild bypasses the registry content-hash lookup", () => {
    const { result, npmLog, curlLog } = runTemplateScriptWithFakeNpm(
      [
        "--dev",
        "--skip-bundles",
        "--skip-matching-registry",
        "--registry-url",
        "https://api.example.test",
        "--force-rebuild",
      ],
      {
        curlBody: `
echo "curl should not be called during force rebuild" >&2
exit 1
`,
      },
    );

    expect(result.status).toBe(0);
    expect(curlLog).toBe("");
    expect(npmLog.split("\n").filter((line) => !line.includes("--print-content-hash"))).toEqual([
      "run -w @cycloid/sandbox-e2b build-template -- --name cycloid-sandbox-dev-testuser-mem4096-cpu2 --memory-mb 4096 --cpu-count 2",
    ]);
    expect(result.stderr).toContain("force rebuild enabled");
    expect(npmLog).not.toContain("--print-content-hash");
  });

  it("records content-hash failures without abandoning sibling templates", () => {
    const { result, npmLog, curlLog } = runTemplateScriptWithFakeNpm(
      [
        "--prod",
        "--include-repo-spec-templates",
        "--skip-bundles",
        "--skip-matching-registry",
        "--registry-url",
        "https://api.example.test",
      ],
      {
        npmBody: `
if [[ "$*" == *"--print-content-hash"* && "$*" == *"--memory-mb 8192"* ]]; then
  echo "hash computation failed" >&2
  exit 1
fi
`,
        curlBody: `
output=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "-o" ]; then output="$arg"; fi
  previous="$arg"
done
printf '{"ok":true,"current":{"contentHash":"old-hash"}}' > "$output"
printf '200'
`,
      },
    );

    expect(result.status).toBe(1);
    const buildLines = npmLog.split("\n").filter((line) => !line.includes("--print-content-hash"));
    expect(buildLines.filter((line) => line.includes("--name arc-default-template-mem4096-cpu2"))).toHaveLength(1);
    expect(buildLines.filter((line) => line.includes("--name arc-default-template-mem8192-cpu4"))).toHaveLength(0);
    expect(buildLines.filter((line) => line.includes("--name arc-default-template-mem16384-cpu4"))).toHaveLength(1);
    expect(curlLog.split("\n")).toHaveLength(2);
    expect(result.stderr).toContain("unable to compute content hash for arc-default-template-mem8192-cpu4");
    expect(result.stderr).toContain("failed=arc-default-template-mem8192-cpu4");
  });
});
