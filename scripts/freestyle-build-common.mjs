// Shared in-VM execution helpers for the Freestyle snapshot build scripts
// (freestyle-build-base-snapshot.mjs, freestyle-build-repo-snapshot.mjs).
// Extracted verbatim from freestyle-build-base-snapshot.mjs — see that script's
// header for the SDK quirks these encode (statusCode not exitCode, ~5-minute
// exec-transport cap forcing detached runs, marker-guarded launches, transient
// API retries).

export const IDLE_TIMEOUT_SECONDS = 1800;
export const FS_WRITE_CAP_BYTES = 8 * 1024 * 1024;
export const LONG_TIMEOUT_MS = 600_000; // 10 min: npm/pip/apt installs
// 30 min: the builder VM's egress has been observed as slow as ~220KB/s.
export const HEAVY_TIMEOUT_MS = 1_800_000;

export function fail(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

// Human-readable UTC stamp for snapshot names (e.g. "2026-07-08-0518"): the
// Freestyle dashboard lists snapshots by name and there is no rename API, so
// the name minted here is the one operators triage by forever.
export function snapshotNameStamp() {
  return new Date().toISOString().slice(0, 16).replace("T", "-").replaceAll(":", "");
}

// Single-quote a value for the VM's shell-interpreting exec transport. vm.exec
// runs the command string through a shell, so any embedded script MUST be
// single-quote escaped with this — JSON.stringify's double-quote escaping does
// NOT survive that parse (backslash-n reaches the inner bash as literal text).
export function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

// Detached-script artifact names must be unique PER BUILD PROCESS, not just per
// call: snapshots capture /tmp, so a VM booted from a snapshot minted by another
// build still carries that build's /tmp/cycloid-build-* files. With a shared
// name, the marker-guarded launcher sees the BAKED .started marker, skips the
// launch, and the first poll reads the baked .rc — the script "succeeds"
// instantly without running (this exact failure ate the first repo-snapshot
// build: the base snapshot carried baked artifacts from its own build).
const RUN_ID = crypto.randomUUID().slice(0, 8);
let scriptCounter = 0;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Transient Freestyle-API/network failures (the exec transport, not the command).
export const TRANSIENT_API_ERROR_RE =
  /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|socket hang up|UND_ERR|other side closed|network error/i;

// Retry transient API failures. ONLY use for idempotent operations (direct execs
// are short/idempotent, fs writes are last-write-wins, detached launches are
// marker-guarded).
export async function withRetry(label, fn, { attempts = 4, delayMs = 5_000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const text = `${error?.message ?? error} ${error?.cause?.message ?? ""}`;
      if (attempt >= attempts || !TRANSIENT_API_ERROR_RE.test(text)) throw error;
      console.log(`  (transient API error on ${label}; retry ${attempt}/${attempts - 1} in ${delayMs / 1000}s)`);
      await sleep(delayMs);
    }
  }
}

// Direct exec for SHORT commands only (< ~2 min): the Freestyle exec transport drops
// requests after ~5 minutes, so anything long-running must go through runScript.
export async function run(vm, command, { timeoutMs = 120_000, label, quiet = false } = {}) {
  const name = label ?? command;
  if (!quiet) process.stdout.write(`  $ ${name}\n`);
  const result = await withRetry(name, () => vm.exec({ command, timeoutMs }));
  const statusCode = typeof result.statusCode === "number" ? result.statusCode : 0;
  if (statusCode !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    throw new Error(`Command failed (status ${statusCode}): ${name}\n${stderr || stdout || "(no output)"}`);
  }
  return result;
}

// Write a bash script into the VM and run it DETACHED, polling for completion.
// Survives the ~5-minute exec-transport cap: the script keeps running in-VM no
// matter what happens to the HTTP calls. Returns { stdout } = the tail of the
// script's combined output. NOTE: the script body runs under `set -euxo pipefail`,
// so its xtrace (every expanded command) lands in the in-VM .log — never
// interpolate or expand a secret VALUE in a script body (reference secret FILES
// and wrap any read in `set +x` ... `set -x`).
export async function runScript(vm, label, body, { timeoutMs = LONG_TIMEOUT_MS } = {}) {
  scriptCounter += 1;
  const base = `/tmp/cycloid-build-${RUN_ID}-${scriptCounter}`;
  const full = `#!/usr/bin/env bash\nset -euxo pipefail\n${body}\n`;
  await withRetry(`write ${base}.sh`, () => vm.fs.writeTextFile(`${base}.sh`, full));
  // Marker-guarded idempotent launch: a retried launch exec is a no-op. The
  // detached env is BARE, so a sane root HOME is exported for every detached
  // script; individual scripts override it where needed.
  const launcher = [
    "#!/usr/bin/env bash",
    "set -eu",
    'export HOME="${HOME:-/root}"',
    `if [ ! -f ${base}.started ]; then`,
    `  touch ${base}.started`,
    `  setsid nohup bash -c "bash ${base}.sh >${base}.log 2>&1; echo \\$? >${base}.rc" </dev/null >/dev/null 2>&1 &`,
    "fi",
    "echo launched",
  ].join("\n");
  await withRetry(`write ${base}-launch.sh`, () => vm.fs.writeTextFile(`${base}-launch.sh`, launcher));
  process.stdout.write(`  $ ${label} (detached, ${base}.sh)\n`);
  await run(vm, `bash ${base}-launch.sh`, { label: `launch ${label}`, quiet: true, timeoutMs: 60_000 });

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastNote = startedAt;
  for (;;) {
    const poll = await run(vm, `if [ -f ${base}.rc ]; then cat ${base}.rc; else echo RUNNING; fi`, {
      label: `poll ${label}`,
      quiet: true,
      timeoutMs: 60_000,
    });
    const state = (poll.stdout ?? "").trim();
    if (state !== "RUNNING" && state !== "") {
      const rc = Number(state);
      if (rc !== 0) {
        const log = await run(vm, `tail -c 6000 ${base}.log`, { label: `tail ${label}`, quiet: true }).catch(
          () => null,
        );
        throw new Error(`Detached script failed (rc ${rc}): ${label}\n${(log?.stdout ?? "(no log)").trim()}`);
      }
      break;
    }
    if (Date.now() > deadline) {
      const log = await run(vm, `tail -c 6000 ${base}.log`, { label: `tail ${label}`, quiet: true }).catch(() => null);
      throw new Error(
        `Detached script timed out after ${Math.round(timeoutMs / 1000)}s: ${label}\n${(log?.stdout ?? "(no log)").trim()}`,
      );
    }
    if (Date.now() - lastNote >= 60_000) {
      process.stdout.write(`    ... ${label} still running (${Math.round((Date.now() - startedAt) / 1000)}s)\n`);
      lastNote = Date.now();
    }
    await sleep(10_000);
  }
  const logRes = await run(vm, `tail -c 20000 ${base}.log`, { label: `log ${label}`, quiet: true });
  return { stdout: logRes.stdout ?? "" };
}

export async function writeText(vm, dest, content, mode) {
  process.stdout.write(`  write ${dest}\n`);
  await withRetry(`write ${dest}`, () => vm.fs.writeTextFile(dest, content));
  await run(vm, `chmod ${mode} ${dest}`, { label: `chmod ${mode} ${dest}` });
}

// ---- phase timing ------------------------------------------------------------

export const timings = [];
export async function phase(name, fn) {
  const start = Date.now();
  console.log(`\n=== ${name} ===`);
  const result = await fn();
  const ms = Date.now() - start;
  timings.push({ name, ms });
  console.log(`--- ${name} done in ${(ms / 1000).toFixed(1)}s ---`);
  return result;
}

export function pickLastPath(stdout) {
  const line = (stdout ?? "")
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return line ?? "";
}
