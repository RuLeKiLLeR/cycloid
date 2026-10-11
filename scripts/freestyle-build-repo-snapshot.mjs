#!/usr/bin/env node
// Build a PER-REPO PREBAKED Freestyle snapshot: boot a builder VM from the BASE
// snapshot, clone the repo to /workspace/repo, install its dependencies the same
// way start-bridge.sh would on a cold session start, SANITIZE (no clone token or
// other credential may survive into the image), snapshot, and always delete the
// builder VM by exact id (try/finally).
//
// Sessions boot the result via FREESTYLE_REPO_SNAPSHOT_MAP_JSON: start-bridge.sh
// finds /workspace/repo/.git and takes the prebaked path (git fetch + checkout of the
// session branch instead of a clone; node_modules reused instead of reinstalled),
// so the clone + install cost is paid once here instead of on every cold spawn.
//
// NEVER point this at a live session VM: session VMs carry injected credentials
// and dirty workspace state. This script only ever snapshots its own builder VM.
// The shared prod Freestyle account rule applies: one builder VM at a time,
// deleted by exact vmId, never any account-wide list/delete.
//
// TOKEN HYGIENE (the reason this script exists instead of a bare `git clone`):
//   * The clone token reaches the VM only as a root-owned 0600 file written via
//     the fs API (never a shell argument, env var, or script body — runScript
//     bodies run under xtrace and their logs persist until sanitize).
//   * git receives it through a process-local `-c credential.helper` that reads
//     the FILE at fetch time; nothing token-bearing is written to git config.
//   * The token is deleted (trap-guarded) inside the clone script itself, BEFORE
//     any repo-owned code (.cycloid/setup.sh, package-manager lifecycle scripts)
//     runs as root; the sanitize phase re-deletes every build artifact and the
//     build fails if any credential-shaped string survives in the places git or
//     npm could have persisted one.
//
// Usage:
//   FREESTYLE_API_KEY=... GITHUB_TOKEN=... node scripts/freestyle-build-repo-snapshot.mjs \
//     --repo trycycloid/cycloid [--branch main] [--base-snapshot sh-...] \
//     [--disk-gb N] [--public] [--verify]
//
//   --repo           owner/name (required)
//   --branch         branch to bake (default: main; sessions fetch+checkout their
//                    own branch on boot, so the baked branch only seeds objects)
//   --base-snapshot  base snapshot to build on (default: the prod
//                    FREESTYLE_DEFAULT_SNAPSHOT_ID from wrangler.toml, so the
//                    bake stays in lockstep with what prod sessions boot)
//   --disk-gb        builder VM rootfs GiB. WARNING: a snapshot pins a disk
//                    FLOOR — every session booting it inherits at least this
//                    size. Leave unset (base default) unless the repo does not fit.
//   --public         repo is public: skips the tokenless-fetch-must-fail check
//                    in --verify (a public fetch succeeds without credentials)
//   --verify         boot a throwaway VM from the new snapshot and re-check the
//                    prebaked-boot preconditions + sanitize invariants
//
// After a successful build:
//   1. Add the printed entry to FREESTYLE_REPO_SNAPSHOT_MAP_JSON
//      (apps/control-plane-worker/wrangler.toml [vars]).
//   2. Add the snapshot id to FREESTYLE_SNAPSHOT_ADVERTISED_AGENT_RUNTIME_BACKENDS
//      (apps/control-plane-worker/src/sandbox/base-template-service.ts) — the bake
//      inherits the base snapshot's toolchains, so it advertises the same set.
//      Skipping this fail-closes opencode spawns against the new snapshot.
//   3. Rebuild on lockfile drift (the boot-time hash gate re-installs on mismatch,
//      but that forfeits the prebaked win until the snapshot is rebuilt).

import path from "node:path";
import { fileURLToPath } from "node:url";

import { Freestyle } from "freestyle";

import {
  fail,
  HEAVY_TIMEOUT_MS,
  IDLE_TIMEOUT_SECONDS,
  phase,
  run,
  runScript,
  shellSingleQuote,
  timings,
  withRetry,
  writeText,
} from "./freestyle-build-common.mjs";
import { readWranglerVar } from "./validate-control-plane-secrets.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

export const REPO_PATH = "/workspace/repo";
export const TOKEN_PATH = "/root/.cycloid-build-clone-token";
// Matches start-bridge.sh CLONE_DEPTH default: sessions run shallow, so the bake does too.
const CLONE_DEPTH = 1;
// Marker consumed by start-bridge.sh's lockfile-hash gate: node_modules is reused
// on boot only while the lockfile still hashes to this value.
const LOCKFILE_HASH_MARKER = "node_modules/.cycloid-lockfile-hash";
export const REPO_SNAPSHOT_METADATA_PATH = "/app/cycloid-repo-snapshot-metadata.json";

// The base snapshot replaces /usr/local/bin/git with the egress policy wrapper
// (session-oriented); the build talks to github.com directly via the moved-aside
// real binary, exactly like start-bridge.sh's git_auth path.
export const REAL_GIT = "/usr/local/lib/cycloid/real-bin/git";

// Process-local credential helper: reads the token FILE at fetch time, so the
// token value never appears in argv, xtrace, or persisted git config.
const GIT_CRED_HELPER = `!f() { echo username=x-access-token; echo "password=$(cat ${TOKEN_PATH})"; }; f`;

export function parseArgs(argv) {
  const args = { branch: "main", diskGb: null, baseSnapshot: null, repo: null, verify: false, public: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) fail(`Missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--repo") args.repo = next();
    else if (arg === "--branch") args.branch = next();
    else if (arg === "--base-snapshot") args.baseSnapshot = next();
    else if (arg === "--disk-gb") args.diskGb = Number(next());
    else if (arg === "--verify") args.verify = true;
    else if (arg === "--public") args.public = true;
    else fail(`Unknown argument: ${arg}`);
  }
  if (!args.repo || !/^[\w.-]+\/[\w.-]+$/.test(args.repo)) {
    fail("--repo owner/name is required");
  }
  // The branch is interpolated (single-quoted) into a builder-VM shell script that
  // runs while the clone token file exists; ref names can contain shell
  // metacharacters, so only plain path-like names are accepted at all.
  if (!/^[\w./-]+$/.test(args.branch) || args.branch.startsWith("-")) {
    fail(`--branch contains unsupported characters: ${args.branch}`);
  }
  if (args.diskGb !== null && (!Number.isInteger(args.diskGb) || args.diskGb <= 0)) {
    fail("--disk-gb must be a positive integer (GiB)");
  }
  return args;
}

// Default the base snapshot to what prod sessions actually boot, read via the
// same section-scoped wrangler reader the deploy validation uses (readWranglerVar
// is [vars]-scoped and throws on unparseable values, so a reformat or a future
// QA value can never silently swap the base image under the bake).
function readProdDefaultSnapshotId() {
  const tomlPath = path.join(repoRoot, "apps/control-plane-worker/wrangler.toml");
  const value = readWranglerVar("production", "FREESTYLE_DEFAULT_SNAPSHOT_ID", tomlPath)?.trim();
  if (!value) {
    fail(
      "Could not read prod FREESTYLE_DEFAULT_SNAPSHOT_ID from apps/control-plane-worker/wrangler.toml; pass --base-snapshot",
    );
  }
  return value;
}

// Credential-shaped strings that must not survive sanitize, checked in every file
// git/npm could have persisted one to. Value-independent on purpose: the check
// works without re-introducing the token to the VM.
const SECRET_PATTERN = "ghs_|ghp_|gho_|ghu_|github_pat_|x-access-token|authToken|_authToken";
const SECRET_SCAN_PATHS = [
  `${REPO_PATH}/.git/config`,
  "/root/.gitconfig",
  "/root/.git-credentials",
  "/root/.netrc",
  "/root/.npmrc",
  `${REPO_PATH}/.npmrc`,
];

export function sanitizeCheckCommand() {
  const scans = SECRET_SCAN_PATHS.map(
    (p) => `if [ -e ${p} ] && grep -qiE '${SECRET_PATTERN}' ${p}; then echo "TAINTED: ${p}"; exit 1; fi`,
  ).join("\n");
  return [
    "set -eu",
    `test ! -e ${TOKEN_PATH} || { echo "TAINTED: ${TOKEN_PATH} still present"; exit 1; }`,
    scans,
    `origin_url="$(${REAL_GIT} -C ${REPO_PATH} remote get-url origin)"`,
    `case "$origin_url" in https://github.com/*) ;; *) echo "TAINTED: origin url $origin_url"; exit 1 ;; esac`,
    `ls /tmp | grep -E '^cycloid-' && { echo "TAINTED: build artifacts left in /tmp"; exit 1; } || true`,
    'echo "sanitize-ok"',
  ].join("\n");
}

async function verifySnapshot(client, snapshotId, { repo, isPublic, hasLockfileMarker }) {
  console.log(`\nVerifying snapshot ${snapshotId} boots prebaked + sanitized...`);
  const { vm, vmId } = await withRetry("create verify VM", () =>
    client.vms.create({ snapshotId, idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS }),
  );
  console.log(`  verify vmId=${vmId}`);
  try {
    // Prebaked-boot preconditions: exactly what start-bridge.sh probes for the
    // fetch-instead-of-clone path and the node_modules reuse.
    await run(vm, `test -e ${REPO_PATH}/.git && ${REAL_GIT} -C ${REPO_PATH} rev-parse --is-inside-work-tree`, {
      label: "verify: repo present + is a git worktree",
    });
    if (hasLockfileMarker) {
      await run(vm, `test -d ${REPO_PATH}/node_modules && test -s ${REPO_PATH}/${LOCKFILE_HASH_MARKER}`, {
        label: "verify: node_modules + lockfile-hash marker present",
      });
    }
    await run(vm, `test -f ${REPO_SNAPSHOT_METADATA_PATH}`, { label: "verify: repo snapshot metadata present" });
    // Sanitize invariants must hold on a FRESH boot of the image, not just on the
    // builder VM the checks first ran on.
    await run(vm, `bash -c ${shellSingleQuote(sanitizeCheckCommand())}`, { label: "verify: sanitize invariants" });
    if (!isPublic) {
      // The decisive credential check for a private repo: a tokenless fetch MUST
      // fail. If it succeeds, some ambient credential survived the bake.
      // GIT_TERMINAL_PROMPT=0 + empty askPass + closed stdin: git must fail fast,
      // never block on a credential prompt against the exec transport's timeout.
      await run(
        vm,
        `if GIT_TERMINAL_PROMPT=0 ${REAL_GIT} -C ${REPO_PATH} -c credential.helper= -c core.askPass= fetch --dry-run origin </dev/null 2>/dev/null; then echo "TAINTED: tokenless fetch of private ${repo} succeeded"; exit 1; else echo tokenless-fetch-denied-ok; fi`,
        { label: "verify: tokenless fetch of private repo is denied", timeoutMs: 120_000 },
      );
    } else {
      console.log("  (skipping tokenless-fetch check: --public)");
    }
    console.log("  snapshot verify OK");
  } finally {
    console.log(`  deleting verify VM ${vmId}...`);
    await withRetry("delete verify VM", () => client.vms.delete({ vmId })).catch((error) =>
      console.error(`  verify cleanup failed: ${error.message}`),
    );
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const buildStart = Date.now();

  const apiKey = process.env.FREESTYLE_API_KEY;
  if (!apiKey) fail("FREESTYLE_API_KEY is not set. Export it in your shell (never commit it) and re-run.");
  const cloneToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!cloneToken) {
    fail(
      "GITHUB_TOKEN (or GH_TOKEN) is not set. Use a token that can read the repo, e.g.:\n" +
        "  GITHUB_TOKEN=$(gh auth token) FREESTYLE_API_KEY=... node scripts/freestyle-build-repo-snapshot.mjs ...",
    );
  }

  const [repoOwner, repoName] = args.repo.split("/");
  const baseSnapshotId = args.baseSnapshot ?? readProdDefaultSnapshotId();
  const repoUrl = `https://github.com/${args.repo}.git`;

  console.log(`Building per-repo prebaked snapshot for ${args.repo}@${args.branch}`);
  console.log(`  base snapshot: ${baseSnapshotId}`);
  if (args.diskGb) {
    console.log(
      `  builder rootfs: ${args.diskGb} GiB — NOTE: this becomes the snapshot's disk FLOOR for every session`,
    );
  }

  const client = new Freestyle({ apiKey });

  console.log("\nCreating builder VM from the base snapshot...");
  const { vmId } = await withRetry("create builder VM", () =>
    client.vms.create({
      snapshotId: baseSnapshotId,
      idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
      // rootfsSizeGb is forwarded by the SDK runtime but absent from its .d.ts
      // (same knob freestyle-client.ts uses for per-repo session sizing).
      ...(args.diskGb ? { rootfsSizeGb: args.diskGb } : {}),
    }),
  );
  const vm = client.vms.ref({ vmId });
  console.log(`  builder vmId=${vmId}`);

  let snapshotId;
  let headSha = "unknown";
  let lockfileKind = "none";
  let lockfileHash = null;
  let setupKind = "none";
  try {
    // 0. Scrub build artifacts BAKED INTO the base snapshot (snapshots capture
    //    /tmp). Stale /tmp/cycloid-build-* markers from the base build would
    //    otherwise collide with this build's detached scripts (see the RUN_ID
    //    note in freestyle-build-common.mjs) and trip the sanitize /tmp check.
    await phase("scrub baked build artifacts", async () => {
      await run(vm, "rm -rf /tmp/cycloid-build-*", { label: "rm baked /tmp/cycloid-build-*" });
    });

    // 1. Drop the clone token as a root-only file via the fs API (never a shell
    //    argument or script body: runScript bodies run under xtrace).
    await phase("drop clone token (0600, fs API)", async () => {
      await writeText(vm, TOKEN_PATH, `${cloneToken}\n`, "0600");
    });

    // 2. Shallow clone via a process-local credential helper reading the token
    //    file. The persisted origin URL is the tokenless https URL. The token is
    //    deleted HERE, in the same script, the moment the clone finishes: the very
    //    next phase runs repo-owned code (.cycloid/setup.sh, package-manager
    //    lifecycle scripts) as root, which must never overlap with a readable
    //    token file. The branch is validated (parseArgs) AND single-quoted —
    //    branch names may contain shell metacharacters and this script executes
    //    in the builder VM while the token still exists.
    await phase("clone repo + delete token", async () => {
      const res = await runScript(
        vm,
        `clone ${args.repo}`,
        `export HOME=/root
trap 'rm -f ${TOKEN_PATH}' EXIT
test -s ${TOKEN_PATH}
rm -rf ${REPO_PATH}
mkdir -p /workspace
${REAL_GIT} -c credential.helper='${GIT_CRED_HELPER}' clone --depth ${CLONE_DEPTH} --branch ${shellSingleQuote(args.branch)} ${repoUrl} ${REPO_PATH}
rm -f ${TOKEN_PATH}
test ! -e ${TOKEN_PATH}
${REAL_GIT} -C ${REPO_PATH} remote get-url origin
${REAL_GIT} -C ${REPO_PATH} rev-parse HEAD
echo "DISK:"; df -h / | tail -1`,
        { timeoutMs: HEAVY_TIMEOUT_MS },
      );
      const shaMatch = (res.stdout ?? "").match(/^[0-9a-f]{40}$/m);
      if (shaMatch) headSha = shaMatch[0];
      console.log(`  HEAD: ${headSha}`);
    });

    // 3. Install dependencies the way start-bridge.sh would on a cold start:
    //    .cycloid/setup.sh wins when present (idempotent contract — it re-runs on
    //    every session boot, so the bake exists to make that re-run fast); else the
    //    lockfile picks the package manager. Credentials are deliberately absent:
    //    a bake that needs one should fail loudly here, not bake a secret.
    //    The lockfile is detected ONCE and the reuse-gate marker is written in the
    //    same script, so the install and marker cascades can never drift apart
    //    (a marker-less bake would silently disable the drift gate for that repo).
    await phase("install dependencies + bake lockfile-hash marker", async () => {
      const res = await runScript(
        vm,
        "install repo dependencies",
        `export HOME=/root
cd ${REPO_PATH}
lockfile=""
if [ -f package-lock.json ]; then lockfile=package-lock.json
elif [ -f pnpm-lock.yaml ]; then lockfile=pnpm-lock.yaml
elif [ -f yarn.lock ]; then lockfile=yarn.lock
fi
if [ -f .cycloid/setup.sh ]; then
  echo "SETUP_KIND:repo_setup_script"
  timeout -k 10s 3300 bash .cycloid/setup.sh
elif [ "$lockfile" = "package-lock.json" ]; then
  echo "SETUP_KIND:npm"
  npm ci
elif [ "$lockfile" = "pnpm-lock.yaml" ]; then
  echo "SETUP_KIND:pnpm"
  pnpm install --frozen-lockfile
elif [ "$lockfile" = "yarn.lock" ]; then
  echo "SETUP_KIND:yarn"
  if [ -f .yarnrc.yml ]; then yarn install --immutable; else yarn install --frozen-lockfile; fi
else
  echo "SETUP_KIND:none"
fi
if [ -n "$lockfile" ] && [ -d node_modules ]; then
  hash="$(sha256sum "$lockfile" | cut -d' ' -f1)"
  printf '%s\\n' "$hash" > ${LOCKFILE_HASH_MARKER}
  echo "LOCKFILE_KIND:$lockfile"
  echo "LOCKFILE_HASH:$hash"
else
  echo "LOCKFILE_KIND:none"
fi
echo "DISK:"; df -h / | tail -1
avail_kb="$(df -k --output=avail / | tail -1 | tr -d ' ')"
if [ "$avail_kb" -lt 1048576 ]; then echo "DISK_LOW: <1GiB free after install — rebuild with --disk-gb"; exit 1; fi`,
        { timeoutMs: HEAVY_TIMEOUT_MS },
      );
      const stdout = res.stdout ?? "";
      const kindMatch = stdout.match(/^SETUP_KIND:(\S+)$/m);
      setupKind = kindMatch ? kindMatch[1] : "unknown";
      const kind = stdout.match(/^LOCKFILE_KIND:(\S+)$/m);
      const hash = stdout.match(/^LOCKFILE_HASH:([0-9a-f]{64})$/m);
      lockfileKind = kind ? kind[1] : "none";
      lockfileHash = hash ? hash[1] : null;
      console.log(`  setup kind: ${setupKind}`);
      console.log(`  lockfile: ${lockfileKind}${lockfileHash ? ` (${lockfileHash.slice(0, 12)}…)` : ""}`);
    });

    // 5. Repo-snapshot metadata marker (ops breadcrumb: what/when/on-what-base).
    await phase("write repo snapshot metadata", async () => {
      await writeText(
        vm,
        REPO_SNAPSHOT_METADATA_PATH,
        `${JSON.stringify({
          repo: args.repo,
          branch: args.branch,
          headSha,
          baseSnapshotId,
          setupKind,
          lockfileKind,
          lockfileHash,
          builtAt: new Date().toISOString(),
        })}\n`,
        "0644",
      );
    });

    // 6. SANITIZE. Deletes the token file, every runScript artifact (their logs
    //    carry xtrace of everything above), shell/npm history, then asserts no
    //    credential-shaped string survived anywhere git/npm could persist one.
    //    Checks run as a DIRECT exec (no new /tmp artifacts) so the image is
    //    checked in exactly the state it snapshots.
    await phase("sanitize + assert clean", async () => {
      await run(
        vm,
        `rm -rf ${TOKEN_PATH} /tmp/cycloid-build-* /root/.bash_history /root/.npm/_logs /root/.gitconfig /root/.git-credentials /root/.netrc && npm cache clean --force >/dev/null 2>&1; true`,
        { label: "delete token + build artifacts + histories" },
      );
      // shellSingleQuote, NOT JSON.stringify: the exec transport shell-parses the
      // command string, and JSON escapes do not survive that parse.
      await run(vm, `bash -c ${shellSingleQuote(sanitizeCheckCommand())}`, { label: "assert sanitize invariants" });
    });

    // 7. Snapshot.
    await phase("snapshot", async () => {
      // Name = repo + baked commit, nothing else: the dashboard listing already
      // shows createdAt, and the in-image metadata file carries full provenance.
      // Our own org's repos drop the redundant owner; customer repos keep it.
      // The literal "-sha-" delimiter marks where the repo name ends and the
      // commit begins (repo names may contain dashes and hex-ish segments).
      const shortSha = headSha === "unknown" ? "nosha" : headSha.slice(0, 8);
      const namePrefix = repoOwner === "trycycloid" ? repoName : `${repoOwner}-${repoName}`;
      const snapshotName = `${namePrefix}-sha-${shortSha}`;
      const snapshot = await withRetry("snapshot builder VM", () => vm.snapshot({ name: snapshotName }), {
        delayMs: 15_000,
      });
      snapshotId = snapshot.snapshotId;
    });
  } finally {
    console.log(`Deleting builder VM ${vmId}...`);
    await withRetry("delete builder VM", () => client.vms.delete({ vmId })).catch((error) =>
      console.error(`  builder cleanup failed: ${error.message}`),
    );
  }

  if (args.verify && snapshotId) {
    await phase("verify snapshot boot", async () => {
      await verifySnapshot(client, snapshotId, {
        repo: args.repo,
        isPublic: args.public,
        hasLockfileMarker: Boolean(lockfileHash),
      });
    });
  }

  const totalMs = Date.now() - buildStart;
  console.log("\n########################################");
  console.log("  PER-REPO PREBAKED SNAPSHOT READY");
  console.log("########################################");
  console.log(`  repo:           ${args.repo}@${args.branch} (${headSha})`);
  console.log(`  snapshotId:     ${snapshotId ?? "(none -- build failed before snapshot)"}`);
  console.log(`  base snapshot:  ${baseSnapshotId}`);
  console.log(`  setup kind:     ${setupKind}  lockfile: ${lockfileKind}`);
  console.log(`  total duration: ${(totalMs / 1000 / 60).toFixed(1)} min`);
  console.log("\n  per-phase durations:");
  for (const t of timings) {
    console.log(`    ${(t.ms / 1000).toFixed(1).padStart(7)}s  ${t.name}`);
  }
  if (snapshotId) {
    console.log("\n  Next steps:");
    console.log(`  1. Merge into FREESTYLE_REPO_SNAPSHOT_MAP_JSON (wrangler.toml [vars]):`);
    console.log(`       "${args.repo}": {"snapshotId":"${snapshotId}","allowPrivate":${!args.public}}`);
    console.log(
      "  2. Add the snapshot id to FREESTYLE_SNAPSHOT_ADVERTISED_AGENT_RUNTIME_BACKENDS\n" +
        "     (base-template-service.ts) with the base snapshot's advertised set, or\n" +
        "     opencode spawns fail closed against it.",
    );
    console.log("  3. Rebuild after lockfile drift to restore the prebaked-install win.");
    if (args.diskGb) {
      console.log(
        `  4. PAIRING RULE: this snapshot pins a ${args.diskGb} GiB disk floor. If the repo\n` +
          "     has (or later gains) an explicit REPO_SANDBOX_SPECS sizing entry, its diskGB\n" +
          `     must be >= ${args.diskGb} or creates for the repo can reject.`,
      );
    }
  }
  console.log("########################################\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    fail(error?.stack ?? error?.message ?? String(error));
  });
}
