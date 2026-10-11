#!/usr/bin/env node
// Build the FULL-PARITY Freestyle base snapshot for Cycloid prod traffic.
//
// This is a throwaway live-infra tool run from a dev machine (NOT part of the
// control-plane worker). It boots a fresh Freestyle builder VM, reproduces the
// ENTIRE E2B template (apps/sandbox-e2b/template.ts) so ANY Cycloid session can
// run on Freestyle -- crucially codex (the DEFAULT prod agent backend), which the
// earlier claude_code-minimal snapshot could not run. It snapshots the builder VM
// and prints the snapshotId to set as FREESTYLE_DEFAULT_SNAPSHOT_ID. The builder
// VM is always deleted (try/finally), even on failure, so nothing leaks.
//
// FULL is the only mode. There is no --minimal: the prior minimal path is gone
// because codex/opencode/browser/toolchain parity is mandatory for prod. The
// template.ts is the ground truth; every version is read from the same source
// template.ts reads it from (shared/constants/*.ts) or from template.ts's own
// pinned consts, so the two stay in lockstep.
//
// BASE-IMAGE DELTAS vs the E2B template (Freestyle base is Debian 13 "trixie"
// with node 24 via nvm and native docker; E2B base is python:3.12-slim-bookworm
// with node 22 and DinD):
//   * node: NOT installed. The base ships node 24 (E2B pins 22). We smoke
//     `codex --version` + `node --version` to prove node 24 runs the toolchain.
//   * docker: NOT installed (native docker-ce daemon already runs). We drop the
//     DinD install + docker-compose smoke and ADD a `docker info` +
//     `docker run --rm hello-world` smoke so native docker is proven for prod.
//   * python: system python 3.13 is PEP-668 externally-managed, so pip installs
//     use --break-system-packages (E2B's python:3.12 base pip is unmanaged).
//   * exec/user model: node lives under /root/.nvm (traversable only by root),
//     so Freestyle runs the bridge as ROOT, not the `user` account E2B uses. We
//     still create `user` + the sudoers drops for parity, but do NOT chown the
//     tree to `user` (root already owns/accesses everything). See report.
//
// The bridge is NOT started or baked to autostart: at session time the control
// plane issues `bash /app/start-bridge.sh` via startCommand with per-session env,
// so egress + env injection precede `node bundle.js`. Layer resolution is forced
// off for freestyle, so this base snapshot is the sole runtime image.
//
// Usage:
//   FREESTYLE_API_KEY=... node scripts/freestyle-build-base-snapshot.mjs [--verify]
//
// Preflight: build the bridge bundle first if it is stale/missing:
//   npm run bundle -w @cycloid/sandbox-bridge
//
// SDK quirks handled below: vm.exec returns { statusCode } (not exitCode) and does
// NOT throw on non-zero; vms.create returns { vm, vmId, domains }; the fs write API
// caps at 8MB so the 8.7MB bundle is gzipped locally, written as .gz, gunzipped in-VM.
// CRITICAL: a single vm.exec HTTP request dies after ~5 minutes ("TypeError: fetch
// failed") regardless of timeoutMs -- the first full-parity run lost a 6-minute
// chromium install to this. Every multi-minute step therefore runs DETACHED in-VM
// (setsid; stdout+stderr to .log, exit code to .rc) and is polled with short execs.
// The launch is marker-guarded so a retried HTTP call can never double-launch an
// install, and all short API calls retry on transient network failures.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { Freestyle } from "freestyle";

// In-VM exec/timing helpers shared with freestyle-build-repo-snapshot.mjs.
import {
  fail,
  FS_WRITE_CAP_BYTES,
  HEAVY_TIMEOUT_MS,
  IDLE_TIMEOUT_SECONDS,
  LONG_TIMEOUT_MS,
  phase,
  pickLastPath,
  run,
  runScript,
  shellSingleQuote,
  snapshotNameStamp,
  timings,
  withRetry,
  writeText,
} from "./freestyle-build-common.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

export const SNAPSHOT_METADATA_PATH = "/app/cycloid-snapshot-metadata.json";

// Checked-in provenance of the CURRENT prod base snapshot: which repo files and
// pinned toolchain versions still ship ONLY via a base rebuild + rotation.
// Written by this script after a successful build and committed with the
// rotation PR. A lockstep drift-gate test used to fail CI whenever the working
// tree drifted from it (those baked files are otherwise silently inert in
// Freestyle sessions, 2026-07-08 incident); that test was removed while Freestyle
// is benched (2026-07-09) — re-add it when Freestyle comes back off the bench.
//
// Runtime-injected artifacts are intentionally excluded from this manifest's
// drift gate. Today that means:
//   * apps/sandbox-bridge/dist/bundle.js (session-start R2 injection; provenance-only)
//   * apps/sandbox-e2b/start-bridge.sh (session-start R2 injection; baked copy is fallback)
export const BASE_MANIFEST_REPO_PATH = "apps/sandbox-e2b/freestyle-base-manifest.json";

// File drops applied before smokes. Egress wrappers (curl/git/gh) are dropped
// LATE (after all curl-based downloads) so the downloads use the real curl and a
// git wrapper never shadows a still-present /usr/bin/git mid-install. Module
// scope so the baked-content manifest and the build share one source of truth.
const FILE_DROPS = [
  { src: "apps/sandbox-e2b/start-bridge.sh", dest: "/app/start-bridge.sh", mode: "0755" },
  { src: "apps/sandbox-e2b/ready-check.sh", dest: "/app/ready-check.sh", mode: "0755" },
  { src: "apps/sandbox-e2b/enforce-egress.sh", dest: "/usr/local/sbin/cycloid-enforce-egress", mode: "0755" },
  { src: "apps/sandbox-e2b/github-meta-cidrs.snapshot", dest: "/app/github-meta-cidrs.snapshot", mode: "0644" },
  { src: "apps/sandbox-e2b/cycloid-record-demo.mjs", dest: "/usr/local/bin/cycloid-record-demo", mode: "0755" },
  { src: "apps/sandbox-e2b/cycloid-recorder.mjs", dest: "/usr/local/bin/cycloid-recorder", mode: "0755" },
];

// Egress wrappers + real-binary moves (curl/git/gh), dropped after downloads.
const EGRESS_WRAPPERS = [
  { src: "apps/sandbox-e2b/curl-egress-wrapper.sh", dest: "/usr/local/bin/curl" },
  { src: "apps/sandbox-e2b/git-command-wrapper.sh", dest: "/usr/local/bin/git" },
  { src: "apps/sandbox-e2b/gh-command-wrapper.sh", dest: "/usr/local/bin/gh" },
];

// These files are still dropped into the base snapshot but no longer need a base
// rebuild to ship behavior changes, because the control plane injects fresh copies
// at session start. Keep the baked copy as the fallback, but exclude it from the
// manifest drift gate.
const RUNTIME_INJECTED_FALLBACK_FILES = new Set(["apps/sandbox-e2b/start-bridge.sh"]);

function listBakedScriptNames() {
  return readdirSync(path.join(repoRoot, "apps/sandbox-e2b/scripts"), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function readPinnedVersions() {
  return {
    codexCli: readPinnedConst("shared/constants/codex-runtime.ts", "PINNED_CODEX_CLI_VERSION"),
    opencodeCli: readPinnedConst("shared/constants/opencode-runtime.ts", "PINNED_OPENCODE_CLI_VERSION"),
    opencodeSdk: readPinnedConst("shared/constants/opencode-runtime.ts", "PINNED_OPENCODE_SDK_VERSION"),
    claudeAgentSdk: readPinnedConst("shared/constants/claude-code-runtime.ts", "PINNED_CLAUDE_AGENT_SDK_VERSION"),
    cycloidCli: readPinnedConst("shared/constants/cycloid-cli-runtime.ts", "PINNED_CYCLOID_CLI_VERSION"),
    sharp: readPkgDepVersion("apps/sandbox-bridge/package.json", "sharp"),
    just: readTemplateConst("JUST_VERSION"),
    playwright: readTemplateConst("PLAYWRIGHT_VERSION"),
    agentBrowser: readTemplateConst("AGENT_BROWSER_VERSION"),
    preCommit: readTemplateConst("PRE_COMMIT_VERSION"),
    typescript: readTemplateConst("TYPESCRIPT_VERSION"),
    terraform: readTemplateConst("TERRAFORM_VERSION"),
    googleFontsCommit: readTemplateConst("GOOGLE_FONTS_COMMIT"),
    geistFontCommit: readTemplateConst("GEIST_FONT_COMMIT"),
  };
}

/**
 * Collect the baked-content manifest for the CURRENT working tree: sha256 of
 * every repo file the base build drops into the image, the pinned toolchain
 * versions it installs, and (provenance only, not drift-gated — it is a build
 * artifact of the entire bridge source) the bridge bundle. Pure read; used by
 * the build to write the manifest and by the lockstep test to recompute it.
 */
export function collectBaseManifest({ snapshotId, builtAt }) {
  const bakedFiles = {};
  const sources = [
    ...FILE_DROPS.map((d) => d.src).filter((src) => !RUNTIME_INJECTED_FALLBACK_FILES.has(src)),
    ...listBakedScriptNames().map((name) => `apps/sandbox-e2b/scripts/${name}`),
    ...EGRESS_WRAPPERS.map((w) => w.src),
  ].sort();
  for (const src of sources) {
    bakedFiles[src] = createHash("sha256")
      .update(readFileSync(path.join(repoRoot, src)))
      .digest("hex");
  }
  let bundle = null;
  try {
    const buf = readFileSync(path.join(repoRoot, "apps/sandbox-bridge/dist/bundle.js"));
    bundle = { sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
  } catch {
    // dist/ is a local build artifact (absent in CI); the manifest keeps the
    // build-time record and the test does not drift-gate it.
  }
  return { snapshotId, builtAt, bakedFiles, pinnedVersions: readPinnedVersions(), bundle };
}

// Read a `export const NAME = "x.y.z";` constant out of a shared TS module without
// building it, so the pinned versions stay in lockstep with the E2B template.
function readPinnedConst(relPath, name) {
  const src = readFileSync(path.join(repoRoot, relPath), "utf8");
  const match = src.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`));
  if (!match) fail(`Could not read ${name} from ${relPath}`);
  return match[1];
}

// Read a `const NAME = "x.y.z";` pin out of template.ts (JUST/PLAYWRIGHT/etc are
// hardcoded there, not in shared/constants). template.ts is the single source of
// truth for these, so re-reading them keeps the Freestyle snapshot in lockstep.
function readTemplateConst(name) {
  return readPinnedConst("apps/sandbox-e2b/template.ts", name);
}

function readPkgDepVersion(relPath, dep) {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, relPath), "utf8"));
  const version = pkg.dependencies?.[dep] ?? pkg.devDependencies?.[dep];
  if (!version) fail(`Could not read ${dep} version from ${relPath}`);
  return version;
}

export function buildEnvShim({ chromiumInstalled, typescriptVersion }) {
  const browserLine = chromiumInstalled ? `export AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chromium\n` : "";
  return (
    `export HOME=/home/user\n` +
    `export NODE_ENV=development\n` +
    browserLine +
    `export ARCANIST_TYPESCRIPT_VERSION=${typescriptVersion}\n` +
    `export PYTHONPATH=/app\n`
  );
}

export function buildSnapshotMetadata({ chromiumInstalled, chromiumStatus }) {
  return `${JSON.stringify({ hasBrowser: chromiumInstalled, chromiumStatus })}\n`;
}

function browserEnvCheckCommand(chromiumInstalled) {
  return chromiumInstalled
    ? `bash -lc 'test "\${AGENT_BROWSER_EXECUTABLE_PATH:-}" = "/usr/local/bin/chromium"'`
    : `bash -lc 'test -z "\${AGENT_BROWSER_EXECUTABLE_PATH:-}"'`;
}

export function snapshotMetadataCheckCommand({ chromiumInstalled, chromiumStatus }) {
  const script = [
    "const fs=require('node:fs')",
    `const meta=JSON.parse(fs.readFileSync(${JSON.stringify(SNAPSHOT_METADATA_PATH)},'utf8'))`,
    "const expectedHasBrowser=process.env.EXPECTED_HAS_BROWSER === 'true'",
    "const expectedChromiumStatus=process.env.EXPECTED_CHROMIUM_STATUS",
    "if(meta.hasBrowser!==expectedHasBrowser||meta.chromiumStatus!==expectedChromiumStatus){console.error(JSON.stringify(meta)); process.exit(1)}",
    "console.log('snapshot-metadata-ok')",
  ].join(";");
  return `EXPECTED_HAS_BROWSER=${shellSingleQuote(String(chromiumInstalled))} EXPECTED_CHROMIUM_STATUS=${shellSingleQuote(chromiumStatus)} node -e ${shellSingleQuote(script)}`;
}

// ---- in-VM execution helpers -------------------------------------------------

const smokeLog = [];

async function smoke(vm, label, command, opts = {}) {
  const res = await run(vm, command, { ...opts, label: `smoke: ${label}` });
  smokeLog.push(label);
  return res;
}

async function dropFile(vm, { src, dest, mode }) {
  const buf = readFileSync(path.join(repoRoot, src));
  if (buf.length >= FS_WRITE_CAP_BYTES) {
    throw new Error(`${src} is ${buf.length}B, over the ${FS_WRITE_CAP_BYTES}B fs write cap (gzip it like the bundle)`);
  }
  process.stdout.write(`  drop ${src} -> ${dest} (${buf.length}B)\n`);
  await withRetry(`write ${dest}`, () => vm.fs.writeFile(dest, buf));
  await run(vm, `chmod ${mode} ${dest}`, { label: `chmod ${mode} ${dest}` });
}

async function dropBundle(vm, bundleBuf) {
  const gz = gzipSync(bundleBuf);
  if (gz.length >= FS_WRITE_CAP_BYTES) {
    throw new Error(`gzipped bundle is ${gz.length}B, still over the ${FS_WRITE_CAP_BYTES}B fs write cap`);
  }
  process.stdout.write(`  drop bundle.js (raw ${bundleBuf.length}B, gz ${gz.length}B) -> /app/bridge/bundle.js\n`);
  await withRetry("write bundle.js.gz", () => vm.fs.writeFile("/app/bridge/bundle.js.gz", gz));
  await run(vm, "gunzip -f /app/bridge/bundle.js.gz", { label: "gunzip bundle.js.gz" });
  await run(vm, "chmod 0644 /app/bridge/bundle.js", { label: "chmod 0644 /app/bridge/bundle.js" });
}

// ---- smoke checks (cross-cutting; per-tool smokes run inline at install) ------

async function finalSmokeChecks(vm, expectedBundleBytes, { chromiumInstalled, chromiumStatus }) {
  console.log("Running cross-cutting in-VM smoke checks (any failure aborts the build)...");
  await smoke(vm, "start-bridge.sh syntax", "bash -n /app/start-bridge.sh");
  // ESM-resolution smokes for all three externalized bridge deps. The bundle statically
  // imports @opencode-ai/sdk, so it must resolve even for a claude_code-only session.
  await smoke(
    vm,
    "claude-agent-sdk import",
    `cd /app/bridge && node -e "import('@anthropic-ai/claude-agent-sdk').then((m)=>{if(typeof m.query!=='function')throw new Error('claude-agent-sdk query export missing');console.log('claude-agent-sdk-ok')}).catch((e)=>{console.error(e);process.exit(1)})"`,
  );
  await smoke(
    vm,
    "opencode-sdk import",
    `cd /app/bridge && node -e "import('@opencode-ai/sdk').then((m)=>{if(typeof m.createOpencode!=='function'||typeof m.createOpencodeServer!=='function')throw new Error('opencode sdk exports missing');console.log('opencode-sdk-ok')}).catch((e)=>{console.error(e);process.exit(1)})"`,
  );
  await smoke(
    vm,
    "sharp import",
    `cd /app/bridge && node -e "import('sharp').then(()=>console.log('sharp-ok')).catch((e)=>{console.error(e);process.exit(1)})"`,
  );
  await smoke(vm, "iptables list (egress prereq)", "iptables -L -n");
  await smoke(vm, "node --version", "node --version");
  // Through a login shell so the /etc/profile.d shims are exercised the same way the
  // detached bridge launcher (bash -lc) and agent shells will resolve PATH. codex is
  // the DEFAULT prod backend -- this proves it resolves on the agent's PATH.
  await smoke(vm, "codex on login-shell PATH", `bash -lc 'command -v codex && codex --version'`);
  await smoke(vm, "opencode on login-shell PATH", `bash -lc 'command -v opencode && opencode --version'`);
  await smoke(vm, "cycloid on login-shell PATH", `bash -lc 'command -v cycloid && cycloid --version'`);
  await smoke(
    vm,
    chromiumInstalled ? "browser env var exported" : "browser env var omitted",
    browserEnvCheckCommand(chromiumInstalled),
  );
  if (chromiumInstalled) {
    await smoke(vm, "chromium symlink present", "test -x /usr/local/bin/chromium");
  } else {
    console.log("  (skipping chromium smoke: chromium-less build)");
  }
  await smoke(vm, "snapshot metadata marker", snapshotMetadataCheckCommand({ chromiumInstalled, chromiumStatus }));
  await smoke(vm, "curl wrapper execs real curl", "curl --version");
  await smoke(vm, "git wrapper execs real git", "git --version");
  const stat = await run(vm, "stat -c %s /app/bridge/bundle.js", { label: "smoke: bundle byte count" });
  const actual = Number((stat.stdout ?? "").trim());
  if (actual !== expectedBundleBytes) {
    throw new Error(`bundle size mismatch after gunzip: VM ${actual}B vs local ${expectedBundleBytes}B`);
  }
  smokeLog.push(`bundle byte count (${actual}B == local)`);
  console.log(`  bundle size OK (${actual}B)`);
}

async function verifySnapshot(client, snapshotId, { chromiumInstalled, chromiumStatus }) {
  console.log(`\nVerifying snapshot ${snapshotId} boots with the expected artifacts...`);
  const { vm, vmId } = await withRetry("create verify VM", () =>
    client.vms.create({ snapshotId, idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS }),
  );
  console.log(`  verify vmId=${vmId}`);
  try {
    await run(vm, "test -f /app/bridge/bundle.js && test -f /app/start-bridge.sh", {
      label: "verify: bundle.js + start-bridge.sh present",
    });
    // The agent's login shell must resolve the default codex backend + opencode + cycloid.
    await run(vm, `bash -lc 'command -v codex && codex --version'`, { label: "verify: codex on login PATH" });
    await run(vm, `bash -lc 'command -v opencode && opencode --version'`, { label: "verify: opencode on login PATH" });
    await run(vm, `bash -lc 'command -v cycloid && cycloid --version'`, { label: "verify: cycloid on login PATH" });
    await run(vm, browserEnvCheckCommand(chromiumInstalled), {
      label: chromiumInstalled ? "verify: browser env var exported" : "verify: browser env var omitted",
    });
    if (chromiumInstalled) {
      await run(vm, "test -x /usr/local/bin/chromium", { label: "verify: chromium binary present" });
    } else {
      console.log("  (skipping chromium verify: chromium-less build)");
    }
    await run(vm, snapshotMetadataCheckCommand({ chromiumInstalled, chromiumStatus }), {
      label: "verify: snapshot metadata marker",
    });
    await run(vm, "/app/bridge-tools/terraform version", { label: "verify: terraform" });
    await run(vm, "/usr/local/lib/cycloid/real-bin/gh --version", { label: "verify: real gh" });
    // Native docker must come back on a snapshot boot (start-dockerd is a no-op if
    // the daemon is already live, else it starts one).
    await run(vm, "bash /app/scripts/start-dockerd.sh && docker info >/dev/null && echo docker-ok", {
      label: "verify: docker up",
      timeoutMs: 120_000,
    });
    console.log("  snapshot verify OK");
  } finally {
    console.log(`  deleting verify VM ${vmId}...`);
    await withRetry("delete verify VM", () => client.vms.delete({ vmId })).catch((error) =>
      console.error(`  verify cleanup failed: ${error.message}`),
    );
  }
}

async function main() {
  const verify = process.argv.includes("--verify");
  const buildStart = Date.now();

  const apiKey = process.env.FREESTYLE_API_KEY;
  if (!apiKey) {
    fail("FREESTYLE_API_KEY is not set. Export it in your shell (never commit it) and re-run.");
  }

  // Preflight: the bridge bundle must exist locally to drop into the snapshot.
  const bundlePath = path.join(repoRoot, "apps/sandbox-bridge/dist/bundle.js");
  let bundleBuf;
  try {
    bundleBuf = readFileSync(bundlePath);
  } catch {
    fail(
      `Bridge bundle missing at apps/sandbox-bridge/dist/bundle.js.\nBuild it first:\n  npm run bundle -w @cycloid/sandbox-bridge`,
    );
  }

  // Versions, read from the SAME sources template.ts reads them from (shared
  // with the baked-content manifest so the two can never disagree).
  const pins = readPinnedVersions();
  const codexCliVersion = pins.codexCli;
  const opencodeCliVersion = pins.opencodeCli;
  const opencodeSdkVersion = pins.opencodeSdk;
  const claudeSdkVersion = pins.claudeAgentSdk;
  const cycloidCliVersion = pins.cycloidCli;
  const sharpVersion = pins.sharp;
  const justVersion = pins.just;
  const playwrightVersion = pins.playwright;
  const agentBrowserVersion = pins.agentBrowser;
  const preCommitVersion = pins.preCommit;
  const typescriptVersion = pins.typescript;
  const terraformVersion = pins.terraform;
  const googleFontsCommit = pins.googleFontsCommit;
  const geistFontCommit = pins.geistFontCommit;

  console.log("Pinned versions:");
  console.log(`  @openai/codex@${codexCliVersion}`);
  console.log(`  opencode-ai@${opencodeCliVersion}`);
  console.log(`  @anthropic-ai/claude-agent-sdk@${claudeSdkVersion}`);
  console.log(`  @opencode-ai/sdk@${opencodeSdkVersion}`);
  console.log(`  sharp@${sharpVersion}`);
  console.log(`  @trycycloid/cli@${cycloidCliVersion}`);
  console.log(`  agent-browser@${agentBrowserVersion} playwright@${playwrightVersion}`);
  console.log(`  typescript@${typescriptVersion} just@${justVersion} terraform@${terraformVersion}`);
  console.log(`  pre-commit==${preCommitVersion}`);

  const fileDrops = FILE_DROPS;
  const scriptNames = listBakedScriptNames();
  const egressWrappers = EGRESS_WRAPPERS;

  const client = new Freestyle({ apiKey });

  console.log("\nCreating builder VM (cold, no snapshot)...");
  const { vmId } = await withRetry("create builder VM", () =>
    client.vms.create({ idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS }),
  );
  const vm = client.vms.ref({ vmId });
  console.log(`  builder vmId=${vmId}`);

  let snapshotId;
  let nodeVersion = "unknown";
  let npmGlobalBin = "";
  let npmRoot = "";
  let aptSummary = "";
  let chromiumStatus = "installed (curl+unzip seed; playwright install no-op gate passed)";
  const chromiumInstalled = () => !chromiumStatus.startsWith("SKIPPED");
  try {
    // 1. apt base-package parity. The template installs its full list against a
    //    Debian 12 base; here we dpkg-probe against Debian 13 and install only what
    //    is missing, with a t64-rename fallback (harmless: trixie kept the original
    //    names). gzip is required for the in-VM bundle gunzip step.
    await phase("apt base packages (parity, dpkg-filtered)", async () => {
      const pkgs = [
        "build-essential",
        "ca-certificates",
        "curl",
        "fd-find",
        "ffmpeg",
        "file",
        "fontconfig",
        "fonts-firacode",
        "fonts-inter",
        "fonts-jetbrains-mono",
        "fonts-liberation2",
        "fonts-noto-color-emoji",
        "fonts-noto-core",
        "git",
        "gnupg",
        "iproute2",
        "iptables",
        "jq",
        "libasound2",
        "libatk-bridge2.0-0",
        "libgbm1",
        "libgtk-3-0",
        "libicu-dev",
        "libnss3",
        "libxshmfence1",
        "libzstd-dev",
        "lsof",
        "netcat-openbsd",
        "openssh-client",
        "pkg-config",
        "procps",
        "ripgrep",
        "sqlite3",
        "sudo",
        "tree",
        "unzip",
        "gzip",
      ].join(" ");
      const res = await runScript(
        vm,
        "apt install base packages",
        `export DEBIAN_FRONTEND=noninteractive
apt-get update
pkgs="${pkgs}"
to_install=""; already=""; renamed=""; missing=""
for p in $pkgs; do
  if dpkg -s "$p" >/dev/null 2>&1; then already="$already $p"; continue; fi
  if apt-cache show "$p" >/dev/null 2>&1; then to_install="$to_install $p"; continue; fi
  if apt-cache show "\${p}t64" >/dev/null 2>&1; then to_install="$to_install \${p}t64"; renamed="$renamed \${p}->\${p}t64"; continue; fi
  missing="$missing $p"
done
if [ -n "$to_install" ]; then apt-get install -y --no-install-recommends $to_install; fi
# fd is invoked as \`fd\` but the Debian package ships it as \`fdfind\`.
ln -sf /usr/bin/fdfind /usr/local/bin/fd
fc-cache -f
rm -rf /var/lib/apt/lists/*
# Summary echoed LAST: runScript returns only the log tail, and apt's install
# output would otherwise push these lines out of the returned window.
echo "APT_ALREADY:$already"
echo "APT_RENAMED:$renamed"
echo "APT_MISSING:$missing"
echo "APT_INSTALLING:$to_install"`,
        { timeoutMs: HEAVY_TIMEOUT_MS },
      );
      aptSummary = (res.stdout ?? "")
        .split("\n")
        .filter((l) => l.startsWith("APT_"))
        .join("\n");
      console.log(aptSummary);
    });

    await phase("product font fallbacks", async () => {
      await runScript(
        vm,
        "install product font fallbacks",
        `set -eux
font_dir="/usr/local/share/fonts/cycloid-product"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
install -d -m 0755 "$font_dir"
printf '%s\\n' \\
  '7e65201e9b79159e2300267cc885e16c8dcef2424cdfa09a29bfb0980a94a7ba|https://raw.githubusercontent.com/google/fonts/${googleFontsCommit}/ofl/poppins/Poppins-Regular.ttf|Poppins-Regular.ttf' \\
  '4fa76ae75b40f926420514044722cb97f32186cafd3b38263cc34dad7174d46d|https://raw.githubusercontent.com/google/fonts/${googleFontsCommit}/ofl/poppins/Poppins-Italic.ttf|Poppins-Italic.ttf' \\
  '650ba57fa99d12ec40c31ccfb680be656be4497fbe14164617d67e32ffe9cd46|https://raw.githubusercontent.com/google/fonts/${googleFontsCommit}/ofl/poppins/Poppins-Light.ttf|Poppins-Light.ttf' \\
  'b8f9c5be59723fadf8e5447fa1245c2c53b60a3464a24d6ece9ee3c283d8917b|https://raw.githubusercontent.com/google/fonts/${googleFontsCommit}/ofl/poppins/Poppins-LightItalic.ttf|Poppins-LightItalic.ttf' \\
  '90373e7d838d32468438fc3e152dca0bdb12edcab99ea639f158790b1ba1fd05|https://raw.githubusercontent.com/google/fonts/${googleFontsCommit}/ofl/poppins/Poppins-Medium.ttf|Poppins-Medium.ttf' \\
  '983676516167748b74de6f4771fb384c664fd913acb8b471122ecacf5da5ea6c|https://raw.githubusercontent.com/google/fonts/${googleFontsCommit}/ofl/poppins/Poppins-Bold.ttf|Poppins-Bold.ttf' \\
  '3572ac8116a0ac7317d342262b29937bcbaf94d8f03f90df6fe666fa7e2fb43a|https://raw.githubusercontent.com/google/fonts/${googleFontsCommit}/ofl/poppins/Poppins-BoldItalic.ttf|Poppins-BoldItalic.ttf' \\
  '8cd08d97e89c24d0aa92edd2f0f4c8ee6195eee9b7c9f154865a58b02f0c1c0d|https://raw.githubusercontent.com/google/fonts/${googleFontsCommit}/ofl/dmsans/DMSans%5Bopsz%2Cwght%5D.ttf|DMSans-Variable.ttf' \\
  '22259c0cc8237221b80f44c76ba8d36e6bce3cda72779f5b2773643d499720ae|https://raw.githubusercontent.com/google/fonts/${googleFontsCommit}/ofl/dmsans/DMSans-Italic%5Bopsz%2Cwght%5D.ttf|DMSans-Italic-Variable.ttf' \\
  '6ceeadf6be8e1fd7687011c7fa38ed0edd1abe967a0b73d97caec183552e823d|https://raw.githubusercontent.com/google/fonts/${googleFontsCommit}/ofl/schibstedgrotesk/SchibstedGrotesk%5Bwght%5D.ttf|SchibstedGrotesk-Variable.ttf' \\
  'b49fedb6f3a2ff9b43e13351888641505dc8e5f300941e597eecbc3f52ba357b|https://raw.githubusercontent.com/google/fonts/${googleFontsCommit}/ofl/schibstedgrotesk/SchibstedGrotesk-Italic%5Bwght%5D.ttf|SchibstedGrotesk-Italic-Variable.ttf' \\
  '822a6621ccbe8d97d20ac88c1c41f5615c9c2c202eaa75f272cd452aac6475a7|https://raw.githubusercontent.com/google/fonts/${googleFontsCommit}/ofl/lora/Lora%5Bwght%5D.ttf|Lora-Variable.ttf' \\
  '22d8d8854b53807aa664ca34f2031a9ed57a1d0dea296b8b96cdd3aad937a2b3|https://raw.githubusercontent.com/google/fonts/${googleFontsCommit}/ofl/lora/Lora-Italic%5Bwght%5D.ttf|Lora-Italic-Variable.ttf' \\
  '73894e0448cae90a92b6c2f8732b7bb9acb7b94c418bff559dad4a18e1de9659|https://raw.githubusercontent.com/vercel/geist-font/${geistFontCommit}/packages/next/dist/fonts/geist-sans/Geist-Variable.ttf|Geist-Variable.ttf' \\
  '87c2aff9723544a9adaea19d92e42a33705c9723624801b6e0224c2206a6af0d|https://raw.githubusercontent.com/vercel/geist-font/${geistFontCommit}/packages/next/dist/fonts/geist-mono/GeistMono-Variable.ttf|GeistMono-Variable.ttf' \\
  > "$tmp_dir/fonts.manifest"
while IFS='|' read -r expected_sha url filename; do
  curl -fsSL --retry 3 --retry-delay 2 "$url" -o "$tmp_dir/$filename"
  printf '%s  %s\\n' "$expected_sha" "$tmp_dir/$filename" | sha256sum -c -
  install -m 0644 "$tmp_dir/$filename" "$font_dir/$filename"
done < "$tmp_dir/fonts.manifest"
fc-cache -f
fc-match "Poppins" | grep -qi "Poppins"
fc-match "DM Sans" | grep -qi "DM Sans"
fc-match "Schibsted Grotesk" | grep -qi "Schibsted Grotesk"
fc-match "Lora" | grep -qi "Lora"
fc-match "Geist" | grep -qi "Geist"
fc-match "Geist Mono" | grep -qi "Geist Mono"`,
      );
      smokeLog.push("product font fallbacks resolve via fontconfig");
    });

    // 2. user account (parity for the sudoers drops), runtime dirs, real-bin dir.
    //    We run the bridge as ROOT (node lives under /root/.nvm), but create `user`
    //    so the sudoers references resolve and /home/user exists for HOME.
    await phase("user account + runtime dirs", async () => {
      await runScript(
        vm,
        "create user + dirs",
        `getent group docker >/dev/null 2>&1 || groupadd docker || true
id -u user >/dev/null 2>&1 || useradd -m -s /bin/bash user
usermod -aG docker user || true
mkdir -p /workspace/repo /app/bridge /app/bridge-tools /app/scripts /home/user /tmp/codex-home /usr/local/lib/cycloid/real-bin
chmod 0755 /home/user`,
      );
    });

    // 3. Discover the npm global bin + module root. Newly npm-installed -g bins are
    //    NOT on the non-login exec PATH here (nvm layout), so build smokes invoke by
    //    absolute path and the login-shell PATH shim (step 15) makes them resolvable.
    await phase("discover npm global bin/root", async () => {
      const binRes = await run(vm, `echo "$(npm prefix -g)/bin"`, { label: "npm prefix -g /bin" });
      npmGlobalBin = pickLastPath(binRes.stdout);
      const rootRes = await run(vm, "npm root -g", { label: "npm root -g" });
      npmRoot = pickLastPath(rootRes.stdout);
      if (!npmGlobalBin.startsWith("/") || !npmRoot.startsWith("/")) {
        throw new Error(
          `Could not discover npm global dirs (bin=${JSON.stringify(npmGlobalBin)} root=${JSON.stringify(npmRoot)})`,
        );
      }
      const nv = await run(vm, "node --version", { label: "node --version" });
      nodeVersion = (nv.stdout ?? "").trim();
      console.log(`  npm global bin: ${npmGlobalBin}`);
      console.log(`  npm root:       ${npmRoot}`);
      console.log(`  node:           ${nodeVersion} (E2B template pins node 22; base ships node 24)`);
    });

    // 4. Bridge runtime deps (/app/bridge). All three externals are required -- the
    //    bundle statically imports @opencode-ai/sdk even for claude_code-only sessions.
    await phase("bridge runtime deps (/app/bridge)", async () => {
      await runScript(
        vm,
        "install /app/bridge runtime deps",
        `cd /app/bridge
npm init -y
npm pkg set type=module
npm install sharp@${sharpVersion} @anthropic-ai/claude-agent-sdk@${claudeSdkVersion} @opencode-ai/sdk@${opencodeSdkVersion}
node -e "import('@anthropic-ai/claude-agent-sdk').then((m)=>{if(typeof m.query!=='function')throw new Error('claude-agent-sdk query export missing');console.log('bridge-claude-agent-sdk-ok')})"
node -e "import('@opencode-ai/sdk').then((m)=>{if(typeof m.createOpencode!=='function'||typeof m.createOpencodeServer!=='function')throw new Error('opencode sdk exports missing');console.log('bridge-opencode-sdk-ok')})"
npm cache clean --force`,
      );
    });

    // 5. Global agent CLIs: codex (DEFAULT prod backend), opencode, cycloid.
    await phase("global CLIs: codex + opencode + cycloid", async () => {
      await runScript(
        vm,
        "install codex + opencode + cycloid",
        `npm install -g @openai/codex@${codexCliVersion}
"${npmGlobalBin}/codex" --version
npm install -g opencode-ai@${opencodeCliVersion}
"${npmGlobalBin}/opencode" --version
npm install -g @trycycloid/cli@${cycloidCliVersion}
"${npmGlobalBin}/cycloid" --version
npm cache clean --force`,
      );
      smokeLog.push("codex --version (install)");
      smokeLog.push("opencode --version (install)");
      smokeLog.push("cycloid --version (install)");
    });

    // 6. agent-browser + playwright + a single shared Chromium. agent-browser is
    //    pointed at Playwright's Chromium (AGENT_BROWSER_EXECUTABLE_PATH) instead of
    //    downloading its own ~684MB Chrome-for-Testing build.
    //
    //    Playwright's own downloader deterministically WEDGES on Freestyle: three
    //    observed runs all end at "100% of 170.4 MiB" of chrome-linux64.zip and then
    //    hang >20 min with no extract/complete log line. So the browsers are seeded
    //    MANUALLY: curl the exact CFT/ffmpeg zips (curl is proven fast in-VM), unzip
    //    into the registry layout playwright-core expects (dir `<name with - -> _>-
    //    <revision>` under ~/.cache/ms-playwright + INSTALLATION_COMPLETE marker),
    //    then GATE on `playwright install chromium` no-opping fast and
    //    chromium.executablePath() resolving to a real binary.
    //
    //    If the manual seed ALSO wedges/fails, the build continues CHROMIUM-LESS
    //    (fallback policy: browser-driving sessions are a small minority; a
    //    fast-follow snapshot rebuild adds the browser) instead of blocking the
    //    whole snapshot.
    await phase("agent-browser + playwright + chromium", async () => {
      await runScript(
        vm,
        "install agent-browser + playwright",
        `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g agent-browser@${agentBrowserVersion} playwright@${playwrightVersion}
NODE_PATH="${npmRoot}" node -e "require('playwright')"
npm cache clean --force`,
        { timeoutMs: LONG_TIMEOUT_MS },
      );
      smokeLog.push("playwright require('playwright') ok");
      try {
        // 6a. Browser system libs via playwright's own resolver (apt-only, no CDN
        //     downloads; this sub-step completed cleanly on every prior attempt).
        await runScript(
          vm,
          "playwright install-deps chromium (apt only)",
          `export DEBIAN_FRONTEND=noninteractive
apt-get update
HOME=/home/user "${npmGlobalBin}/playwright" install-deps chromium
rm -rf /var/lib/apt/lists/*`,
          { timeoutMs: LONG_TIMEOUT_MS },
        );

        // 6b. Manual browser seeding. Versions/revisions come from the installed
        //     playwright's own browsers.json so the seed always matches the pin.
        //     Instrumented (df/ls/time/du) so a wedge here tells us whether the
        //     unzip or the disk is the problem.
        await runScript(
          vm,
          "seed playwright browsers (curl+unzip)",
          `export HOME=/home/user
BJSON="${npmRoot}/playwright/node_modules/playwright-core/browsers.json"
[ -f "$BJSON" ] || BJSON="${npmRoot}/playwright-core/browsers.json"
test -f "$BJSON"
command -v unzip
REG="$HOME/.cache/ms-playwright"
mkdir -p "$REG"
echo "DISK BEFORE:"; df -h / | tail -1
jver() { node -e "const b=require('$BJSON').browsers.find((x)=>x.name==='$1');process.stdout.write(String((b&&b.$2)||''))"; }
cver="$(jver chromium browserVersion)"; crev="$(jver chromium revision)"
hver="$(jver chromium-headless-shell browserVersion)"; hrev="$(jver chromium-headless-shell revision)"
frev="$(jver ffmpeg revision)"
echo "SEED chromium=$cver/$crev headless-shell=$hver/$hrev ffmpeg=$frev"
test -n "$cver"; test -n "$crev"; test -n "$hver"; test -n "$hrev"; test -n "$frev"
seed_zip() {
  url="$1"; dest="$2"
  curl -fsSL --retry 3 --retry-delay 2 -o /tmp/seed.zip "$url"
  ls -l /tmp/seed.zip
  mkdir -p "$dest"
  time unzip -q /tmp/seed.zip -d "$dest"
  rm -f /tmp/seed.zip
}
seed_zip "https://cdn.playwright.dev/builds/cft/$cver/linux64/chrome-linux64.zip" "$REG/chromium-$crev"
chmod a+rx "$REG/chromium-$crev/chrome-linux64/chrome"
touch "$REG/chromium-$crev/INSTALLATION_COMPLETE"
seed_zip "https://cdn.playwright.dev/builds/cft/$hver/linux64/chrome-headless-shell-linux64.zip" "$REG/chromium_headless_shell-$hrev"
chmod a+rx "$REG/chromium_headless_shell-$hrev/chrome-headless-shell-linux64/chrome-headless-shell"
touch "$REG/chromium_headless_shell-$hrev/INSTALLATION_COMPLETE"
seed_zip "https://cdn.playwright.dev/builds/ffmpeg/$frev/ffmpeg-linux.zip" "$REG/ffmpeg-$frev"
chmod a+rx "$REG/ffmpeg-$frev/ffmpeg-linux"
touch "$REG/ffmpeg-$frev/INSTALLATION_COMPLETE"
du -sh "$REG"
echo "DISK AFTER:"; df -h / | tail -1`,
          { timeoutMs: LONG_TIMEOUT_MS },
        );

        // 6c. Validation gate: `playwright install chromium` must NO-OP quickly
        //     against the seeded cache (a re-download attempt hits the in-script
        //     `timeout` and fails the gate), and executablePath must resolve.
        await runScript(
          vm,
          "playwright install no-op gate + chromium symlink",
          `export HOME=/home/user
timeout 240 "${npmGlobalBin}/playwright" install chromium
chromium_path="$(NODE_PATH="${npmRoot}" node -e 'process.stdout.write(require("playwright").chromium.executablePath())')"
echo "chromium_path=$chromium_path"
test -x "$chromium_path"
chmod a+rx "$chromium_path"
ln -sf "$chromium_path" /usr/local/bin/chromium
"${npmGlobalBin}/playwright" --version
/usr/local/bin/chromium --version || echo "WARN: chromium --version failed (binary present; launch not gated per fallback policy)"`,
          { timeoutMs: 420_000 },
        );
        smokeLog.push("playwright install no-op gate (seeded cache)");
        smokeLog.push("chromium executablePath resolves + symlinked");
        smokeLog.push("playwright --version (install)");
      } catch (error) {
        chromiumStatus = `SKIPPED (chromium-less build): ${String(error?.message ?? error).split("\n")[0]}`;
        console.log(`  !! ${chromiumStatus}`);
        console.log("  !! continuing without chromium per fallback policy; cleaning partial cache...");
        await run(
          vm,
          `pkill -f 'cycloid-build-[0-9]*[.]sh' 2>/dev/null; pkill -f 'unzip -q /tmp/seed[.]zip' 2>/dev/null; pkill -f 'cdn[.]playwright[.]dev' 2>/dev/null; rm -rf /home/user/.cache/ms-playwright /tmp/seed.zip; true`,
          { label: "cleanup partial chromium cache", timeoutMs: 120_000 },
        ).catch(() => {});
      }
    });

    // 7. gh CLI via the official apt repo, then move the real binary aside for the
    //    gh policy wrapper (dropped in the egress-wrapper phase).
    await phase("gh CLI (apt repo) + real-bin move", async () => {
      await runScript(
        vm,
        "install gh + move to real-bin",
        `export DEBIAN_FRONTEND=noninteractive
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
apt-get update
apt-get install -y --no-install-recommends gh
mkdir -p /usr/local/lib/cycloid/real-bin
mv "$(command -v gh)" /usr/local/lib/cycloid/real-bin/gh
/usr/local/lib/cycloid/real-bin/gh --version
rm -rf /var/lib/apt/lists/*`,
      );
      smokeLog.push("real gh --version (install)");
    });

    // 8. ngrok via its apt repo (bookworm channel works on trixie).
    await phase("ngrok (apt repo)", async () => {
      await runScript(
        vm,
        "install ngrok",
        `export DEBIAN_FRONTEND=noninteractive
curl -fsSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc | tee /etc/apt/trusted.gpg.d/ngrok.asc > /dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com bookworm main" > /etc/apt/sources.list.d/ngrok.list
apt-get update
apt-get install -y --no-install-recommends ngrok
ngrok version
rm -rf /var/lib/apt/lists/*`,
      );
      smokeLog.push("ngrok version (install)");
    });

    // 9. just (checksum-verified release tarball) -> /usr/local/bin/just.
    await phase("just", async () => {
      await runScript(
        vm,
        "install just",
        `just_arch="$(uname -m)"
case "$just_arch" in
  x86_64) just_arch="x86_64-unknown-linux-musl" ;;
  aarch64|arm64) just_arch="aarch64-unknown-linux-musl" ;;
  *) echo "unsupported just architecture: $just_arch" >&2; exit 1 ;;
esac
just_archive="just-${justVersion}-$just_arch.tar.gz"
curl -fsSL "https://github.com/casey/just/releases/download/${justVersion}/SHA256SUMS" -o /tmp/just_SHA256SUMS
curl -fsSL "https://github.com/casey/just/releases/download/${justVersion}/$just_archive" -o "/tmp/$just_archive"
grep " $just_archive$" /tmp/just_SHA256SUMS | sed "s# $just_archive# /tmp/$just_archive#" | sha256sum -c -
tar -xzf "/tmp/$just_archive" -C /usr/local/bin just
chmod 755 /usr/local/bin/just
just --version
rm -f "/tmp/$just_archive" /tmp/just_SHA256SUMS`,
      );
      smokeLog.push("just --version (install)");
    });

    // 10. terraform (checksum-verified) -> /app/bridge-tools/terraform, symlinked onto
    //     /usr/local/bin so agent shells resolve it (live-session-proven requirement:
    //     the E2B image's Docker ENV covers all processes; profile.d alone does not).
    await phase("terraform", async () => {
      await runScript(
        vm,
        "install terraform",
        `terraform_arch="$(uname -m)"
case "$terraform_arch" in
  x86_64) terraform_arch="amd64" ;;
  aarch64|arm64) terraform_arch="arm64" ;;
  *) echo "unsupported terraform architecture: $terraform_arch" >&2; exit 1 ;;
esac
terraform_zip="terraform_${terraformVersion}_linux_\${terraform_arch}.zip"
curl -fsSL "https://releases.hashicorp.com/terraform/${terraformVersion}/terraform_${terraformVersion}_SHA256SUMS" -o /tmp/terraform_SHA256SUMS
curl -fsSL "https://releases.hashicorp.com/terraform/${terraformVersion}/$terraform_zip" -o "/tmp/$terraform_zip"
grep " $terraform_zip$" /tmp/terraform_SHA256SUMS | sed "s# $terraform_zip# /tmp/$terraform_zip#" | sha256sum -c -
unzip -q "/tmp/$terraform_zip" -d /app/bridge-tools
chmod 0755 /app/bridge-tools/terraform
ln -sf /app/bridge-tools/terraform /usr/local/bin/terraform
terraform version
rm -f "/tmp/$terraform_zip" /tmp/terraform_SHA256SUMS`,
      );
      smokeLog.push("terraform version (install)");
    });

    // 11. bun -> /usr/local/bin/bun.
    await phase("bun", async () => {
      await runScript(
        vm,
        "install bun",
        `curl -fsSL https://bun.sh/install | bash
cp /root/.bun/bin/bun /usr/local/bin/bun
chmod 755 /usr/local/bin/bun
bun --version
rm -rf /root/.bun`,
      );
      smokeLog.push("bun --version (install)");
    });

    // 12. pnpm / yarn / typescript (global).
    await phase("pnpm + yarn + typescript", async () => {
      await runScript(
        vm,
        "install pnpm + yarn + typescript",
        `npm install -g pnpm yarn typescript@${typescriptVersion}
"${npmGlobalBin}/pnpm" --version
"${npmGlobalBin}/yarn" --version
"${npmGlobalBin}/tsc" --version
NODE_PATH="${npmRoot}" node -e "const ts=require('typescript'); if (ts.version !== '${typescriptVersion}') throw new Error('unexpected TypeScript '+ts.version)"
npm cache clean --force`,
      );
      smokeLog.push("pnpm --version (install)");
      smokeLog.push("yarn --version (install)");
      smokeLog.push(`tsc --version == ${typescriptVersion} (install)`);
    });

    // 13. python toolchain via pip. trixie's system python is PEP-668
    //     externally-managed, so --break-system-packages is required.
    await phase("python toolchain (pip)", async () => {
      await runScript(
        vm,
        "install python toolchain",
        `pip install --no-cache-dir --break-system-packages \\
  black \\
  httpx \\
  mypy \\
  "pydantic>=2.0" \\
  pytest \\
  pytest-asyncio \\
  pytest-cov \\
  pytest-mock \\
  pytest-timeout \\
  "pre-commit==${preCommitVersion}" \\
  ruff \\
  uv
uv --version
pytest --version
pre-commit --version
ruff --version
python -c "import pytest; print('python-test-tooling-ok')"`,
      );
      smokeLog.push("uv --version (install)");
      smokeLog.push("pytest --version (install)");
      smokeLog.push("pre-commit --version (install)");
      smokeLog.push("ruff --version (install)");
      smokeLog.push("python import pytest (install)");
    });

    // 14. File drops (scripts, egress enforcer, github-meta snapshot, recorder tools,
    //     start-bridge, ready-check) + the bridge bundle.
    await phase("file drops (scripts, recorder, bundle)", async () => {
      for (const drop of fileDrops) {
        await dropFile(vm, drop);
      }
      for (const name of scriptNames) {
        await dropFile(vm, { src: `apps/sandbox-e2b/scripts/${name}`, dest: `/app/scripts/${name}`, mode: "0755" });
      }
      await dropBundle(vm, bundleBuf);
      await run(vm, "chmod +x /app/start-bridge.sh /app/ready-check.sh /app/scripts/*", {
        label: "chmod +x app scripts",
      });
    });

    // 15. Login-shell PATH/ENV shims: agents run `bash -lc` and Debian's /etc/profile
    //     resets PATH, so re-export the template's ENV block via profile.d. The npm
    //     global bin (which also holds node) is included so codex/opencode/cycloid and
    //     `node` resolve; NODE_PATH includes the actual nvm module root.
    await phase("login-shell shims (profile.d)", async () => {
      const pathShim =
        `export PATH="/app/scripts:${npmGlobalBin}:\${PATH}"\n` +
        `export NODE_PATH="${npmRoot}:/usr/local/lib/node_modules:/usr/lib/node_modules"\n`;
      await writeText(vm, "/etc/profile.d/cycloid-path.sh", pathShim, "0644");

      const hasBrowser = chromiumInstalled();
      const envShim = buildEnvShim({ chromiumInstalled: hasBrowser, typescriptVersion });
      await writeText(vm, "/etc/profile.d/cycloid-env.sh", envShim, "0644");
      await writeText(
        vm,
        SNAPSHOT_METADATA_PATH,
        buildSnapshotMetadata({ chromiumInstalled: hasBrowser, chromiumStatus }),
        "0644",
      );

      // ngrok authtoken bootstrap (verbatim from template.ts).
      const ngrokShim =
        `if [ -n "\${NGROK_AUTHTOKEN:-\${NGROK_AUTH_TOKEN:-}}" ] && command -v ngrok >/dev/null 2>&1; then\n` +
        `  export NGROK_AUTHTOKEN="\${NGROK_AUTHTOKEN:-\${NGROK_AUTH_TOKEN}}"\n` +
        `  if [ ! -s "\${HOME:-/home/user}/.config/ngrok/ngrok.yml" ]; then\n` +
        `    ngrok_auth_log="/var/log/cycloid-egress.log"\n` +
        `    if [ ! -w "$ngrok_auth_log" ]; then\n` +
        `      ngrok_auth_log="/tmp/cycloid-ngrok-auth.log"\n` +
        `    fi\n` +
        `    ngrok config add-authtoken "$NGROK_AUTHTOKEN" >>"$ngrok_auth_log" 2>&1 || true\n` +
        `  fi\n` +
        `fi\n`;
      await writeText(vm, "/etc/profile.d/cycloid-ngrok.sh", ngrokShim, "0644");
    });

    // 16. Egress wrappers + real-git move. Done AFTER downloads so nothing shadowed
    //     the real curl/git during the build. The git wrapper execs the moved-aside
    //     real git at /usr/local/lib/cycloid/real-bin/git.
    await phase("egress wrappers (curl/git/gh) + real-git move", async () => {
      await run(vm, "mv /usr/bin/git /usr/local/lib/cycloid/real-bin/git", { label: "move real git aside" });
      for (const w of egressWrappers) {
        await dropFile(vm, { ...w, mode: "0755" });
      }
      await runScript(
        vm,
        "chown + chmod egress wrappers",
        `chown root:root /usr/local/sbin/cycloid-enforce-egress /usr/local/bin/curl /usr/local/bin/git /usr/local/bin/gh /usr/local/bin/cycloid-record-demo /usr/local/bin/cycloid-recorder /usr/local/lib/cycloid/real-bin/git /usr/local/lib/cycloid/real-bin/gh
chmod 0755 /usr/local/sbin/cycloid-enforce-egress /usr/local/bin/curl /usr/local/bin/git /usr/local/bin/gh /usr/local/bin/cycloid-record-demo /usr/local/bin/cycloid-recorder`,
      );
    });

    // 17. Recorder tool --help smokes (mirrors template). NODE_PATH set so a real
    //     record run could resolve playwright; --help itself does not require it.
    await phase("recorder --help smokes", async () => {
      await smoke(vm, "cycloid-record-demo --help", `NODE_PATH="${npmRoot}" /usr/local/bin/cycloid-record-demo --help`);
      await smoke(vm, "cycloid-recorder --help", `NODE_PATH="${npmRoot}" /usr/local/bin/cycloid-recorder --help`);
    });

    // 18. Native docker smoke. The base ships a running docker-ce daemon; start-dockerd
    //     is a no-op when `docker info` already works, else it starts one. hello-world
    //     proves an actual container runs (prod repos rely on native docker).
    await phase("docker smoke (native)", async () => {
      await smoke(
        vm,
        "docker info + run hello-world",
        `bash /app/scripts/start-dockerd.sh && docker info >/dev/null && docker run --rm hello-world | grep -q "Hello from Docker" && echo docker-hello-ok`,
        { timeoutMs: 300_000 },
      );
    });

    // 19. sudoers drops for egress + native dockerd (exactly as template, minus the
    //     DinD install). Valid because `user` was created in step 2.
    await phase("sudoers drops (egress + dockerd)", async () => {
      await runScript(
        vm,
        "write sudoers drops",
        `echo 'user ALL=(root) NOPASSWD:SETENV: /usr/local/sbin/cycloid-enforce-egress' > /etc/sudoers.d/cycloid-egress
chmod 0440 /etc/sudoers.d/cycloid-egress
echo 'user ALL=(root) NOPASSWD:SETENV: /app/scripts/start-dockerd.sh' > /etc/sudoers.d/cycloid-dockerd
chmod 0440 /etc/sudoers.d/cycloid-dockerd
visudo -cf /etc/sudoers.d/cycloid-egress
visudo -cf /etc/sudoers.d/cycloid-dockerd`,
      );
    });

    // 20. Cross-cutting smoke checks (abort on any failure so a broken snapshot is
    //     never minted).
    await phase("cross-cutting smoke checks", async () => {
      await finalSmokeChecks(vm, bundleBuf.length, {
        chromiumInstalled: chromiumInstalled(),
        chromiumStatus,
      });
    });

    // 21. Snapshot the never-started-bridge VM. Build artifacts are scrubbed
    //     first: snapshots capture /tmp, and baked /tmp/cycloid-build-* files
    //     collide with the detached-script markers of any later build that
    //     boots FROM this snapshot (this bit the first repo-snapshot build).
    await phase("snapshot", async () => {
      await run(vm, "rm -rf /tmp/cycloid-build-*", { label: "scrub /tmp build artifacts before snapshot" });
      console.log("Snapshotting builder VM...");
      // Retried on transient transport failure; a duplicate server-side snapshot is
      // identifiable by its timestamped name and can be pruned via the CLI.
      const snapshotName = `base-${snapshotNameStamp().slice(0, 10)}`;
      const snapshot = await withRetry("snapshot builder VM", () => vm.snapshot({ name: snapshotName }), {
        delayMs: 15_000,
      });
      snapshotId = snapshot.snapshotId;
      // Record what this snapshot was baked from. The lockstep test gates CI on
      // this file, so committing it with the rotation PR is mandatory.
      const manifest = collectBaseManifest({ snapshotId, builtAt: new Date().toISOString() });
      writeFileSync(path.join(repoRoot, BASE_MANIFEST_REPO_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(`  baked-content manifest written to ${BASE_MANIFEST_REPO_PATH} — commit it with the rotation PR`);
    });

    console.log("\n========================================");
    console.log("  FREESTYLE FULL-PARITY BASE SNAPSHOT READY");
    console.log(`  snapshotId: ${snapshotId}`);
    console.log(`  chromium:   ${chromiumStatus}`);
    console.log("  Set FREESTYLE_DEFAULT_SNAPSHOT_ID to this value.");
    console.log(
      "  ALSO register its advertised agent backends: add this snapshot id to\n" +
        "  FREESTYLE_SNAPSHOT_ADVERTISED_AGENT_RUNTIME_BACKENDS in\n" +
        "  apps/control-plane-worker/src/sandbox/base-template-service.ts (this build\n" +
        "  installs+smokes codex, claude_code, and opencode). Skipping this leaves the\n" +
        "  opencode spawn preflight failing closed for the new snapshot.",
    );
    console.log("========================================\n");
  } finally {
    console.log(`Deleting builder VM ${vmId}...`);
    await withRetry("delete builder VM", () => client.vms.delete({ vmId })).catch((error) =>
      console.error(`  builder cleanup failed: ${error.message}`),
    );
  }

  if (verify && snapshotId) {
    await phase("verify snapshot boot", async () => {
      await verifySnapshot(client, snapshotId, {
        chromiumInstalled: chromiumInstalled(),
        chromiumStatus,
      });
    });
  }

  // ---- final report -----------------------------------------------------------
  const totalMs = Date.now() - buildStart;
  console.log("\n########################################");
  console.log("  BUILD SUMMARY");
  console.log("########################################");
  console.log(`  snapshotId:      ${snapshotId ?? "(none -- build failed before snapshot)"}`);
  console.log(`  total duration:  ${(totalMs / 1000 / 60).toFixed(1)} min (${(totalMs / 1000).toFixed(0)}s)`);
  console.log(`  node in base:    ${nodeVersion} (E2B template pins node 22)`);
  console.log(`  chromium:        ${chromiumStatus}`);
  console.log("\n  per-phase durations:");
  for (const t of timings) {
    console.log(`    ${(t.ms / 1000).toFixed(1).padStart(7)}s  ${t.name}`);
  }
  console.log("\n  apt filter summary:");
  for (const line of aptSummary.split("\n")) {
    if (line.trim()) console.log(`    ${line}`);
  }
  console.log(`\n  smokes passed (${smokeLog.length}):`);
  for (const s of smokeLog) {
    console.log(`    OK  ${s}`);
  }
  console.log("########################################\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    fail(error?.stack ?? error?.message ?? String(error));
  });
}
