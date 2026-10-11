import { Buffer } from "node:buffer";

import { Freestyle } from "freestyle";

import { createLogger, type Logger } from "../logger";
import { baseControlPlaneMetricTags } from "../observability/metric-tags";
import { postCountMetric, postGaugeMetricSeries } from "../observability/pr-metrics";
import { shellQuote } from "../utils";
import {
  E2BConnectedSandbox,
  type E2BCreateSandboxRequest,
  type E2BCreateSandboxResponse,
  type E2BListedSandbox,
  type E2BSandboxInfoResult,
  E2BSandboxRuntimeError,
  type E2BSandboxRuntimeErrorCode,
  type RunCommandRequest,
  type RunCommandResult,
  type SandboxResourceSpec,
  type SandboxTerminateReason,
  type StartCommandRequest,
} from "./e2b-client";
import type { SandboxProviderClient } from "./provider-client";

// Finite idle timeout, never null: an untracked VM that never suspends is runaway
// billing; too short and it suspends mid-prompt (Freestyle idle detection is
// network-only and the bridge's 30s heartbeat is below the activity threshold, so a
// long network-quiet compute phase — big build/test/install — reads as idle).
// ARC-1476: this MUST exceed PROMPT_MAX_DURATION_MS (constants/sessions.ts, 30 min =
// 1800s) with margin, or a single max-length prompt can outlast the idle window and
// self-suspend mid-run, losing the in-flight work. 2400s = 1800s cap + 600s margin;
// a genuinely idle VM still suspends ~40 min after its last network activity.
// Overridable via FREESTYLE_IDLE_TIMEOUT_SECONDS (keep the wrangler default >= this).
const DEFAULT_IDLE_TIMEOUT_SECONDS = 2400;

// ARC-1482: pin the idle detector's activity floor instead of inheriting Freestyle's
// unpinned account default. Freestyle counts a check interval as "active" (resets the
// idle timer) only when its network traffic reaches activityThresholdBytes; below that
// the interval is idle, and after idleTimeoutSeconds of idle intervals the VM suspends
// (SDK: "Minimum bytes of network traffic per check interval to count as real activity
// for the idle timer"). Left unset this rides the default: if that default is low the
// bridge's 30s keepalive heartbeat (a ~200-byte JSON frame + its echo, well under any
// KB-scale value) reads as activity and an idle VM never suspends -> runaway billing
// until the 72h retention window; if it is high a lightly-active session suspends
// mid-work. 64 KiB sits in the wide gap between idle keepalive chatter (at most a few
// KB per interval) and real agent egress (git clone / npm install / model streaming =
// MB per interval), so idle VMs still suspend and active ones stay awake regardless of
// the account default. It is a per-start idle-timer parameter (absent from the VM
// record, like idleTimeoutSeconds), so it MUST also be re-passed on start()/resume or
// the create-time pin reverts to the default on the first wake.
const ACTIVITY_THRESHOLD_BYTES = 64 * 1024;

// ARC-1482: pin how long a suspended VM's files are retained instead of inheriting the
// account default. pauseSandbox parks the VM with the memory-preserving suspend()
// (ARC-1481) and the control plane promises 72h retention (runtime_state_expires_at =
// now + 72h). If the account default is `ephemeral` (deleteEvent OnSuspend/OnStop) that
// suspend DROPS the VM's files, so a resume inside the window throws VM_DELETED ("This
// VM was ephemeral and its files were removed") and the user silently loses every
// uncommitted in-VM change the pause was meant to preserve. Pin `sticky` priority 10
// (max): the VM is retained until the account hits its storage quota, at which point
// priority 10 makes it the LAST evicted. Deliberately NOT `persistent`: that mode is
// plan-gated (PERSISTENT_VMS_NOT_ALLOWED, 403 -- the SDK error itself says "use sticky
// or ephemeral instead"), so an unconditional persistent create would fail closed on a
// plan that disallows it and break every spawn. sticky is universally available and, at
// priority 10, the strongest retention we can pin without that regression. Set at create
// only: persistence is a VM-record attribute that survives suspend/resume, not a
// per-start parameter.
const VM_PERSISTENCE = { type: "sticky", priority: 10 } as const;

// Per-session env is injected by writing this file (0600) and sourcing it in the
// detached bridge launcher — `vms.create`/`vm.exec` take no envs map. start-bridge.sh
// sources /etc/cycloid/layer-env.sh (a per-repo-layer artifact absent on the base
// snapshot); this is the separate session-scoped file the launcher sources explicitly.
const SESSION_ENV_FILE_PATH = "/etc/cycloid/session-env.sh";

// ARC-1512 / ARC-1566: fresh Freestyle boot-artifact injection. The Freestyle base
// snapshot bakes the bridge bundle and start-bridge.sh and goes silently stale
// between rebuilds. Deploys publish the current copies to R2:
//   * bridge/current.json -> content-addressed bundle.js.gz blob
//   * start-bridge/current.json -> content-addressed start-bridge.sh.gz blob
// At session start the worker fetches them and injects them into the VM. Any trouble
// falls back to the baked copies — the spawn is never failed for an injection problem.
//
// The pointer key + shape are a FIXED contract with publish-bridge-bundle.mjs (POINTER_KEY
// / buildPointer). Duplicated as a literal here rather than imported: that script pulls in
// node:child_process and is not part of the worker bundle.
const BRIDGE_BUNDLE_POINTER_KEY = "bridge/current.json";
const START_BRIDGE_POINTER_KEY = "start-bridge/current.json";
// In-VM paths mirroring the base builder's dropBundle mechanics: write the gz, gunzip,
// verify the raw bundle's sha256. The fresh bundle MUST live in /app/bridge: the esbuild
// bundle externalizes sharp/@anthropic-ai/claude-agent-sdk/@opencode-ai/sdk, and node
// resolves those ESM imports from the module file's own directory — only
// /app/bridge/node_modules has them. Distinct name so the baked bundle.js is never
// touched and remains the fallback. The gz staging file stays under /tmp (wiped per boot).
const BRIDGE_BUNDLE_GZ_VM_PATH = "/tmp/cycloid-bridge-fresh.js.gz";
const BRIDGE_BUNDLE_VM_PATH = "/app/bridge/bundle.fresh.js";
const START_BRIDGE_GZ_VM_PATH = "/tmp/cycloid-start-bridge.fresh.sh.gz";
const START_BRIDGE_VM_PATH = "/tmp/cycloid-start-bridge.fresh.sh";
// Hard bound on the whole injection so a slow R2 read or VM op cannot blow the spawn
// budget; overrun -> baked fallback.
const BRIDGE_BUNDLE_INJECT_TIMEOUT_MS = 25_000;
const START_BRIDGE_INJECT_TIMEOUT_MS = 5_000;
// The Freestyle fs write API caps at 8 MB (docs/freestyle-snapshots.md); the gz is ~2-3 MB
// so it fits, but guard anyway so an oversized blob falls back instead of failing the write.
const FS_WRITE_CAP_BYTES = 8 * 1024 * 1024;
// FIXED contract with PR 3: these env var / metric names must not be renamed.
const BRIDGE_BUNDLE_SOURCE_ENV = "ARCANIST_BRIDGE_BUNDLE_SOURCE";
const BRIDGE_BUNDLE_SHA256_ENV = "ARCANIST_BRIDGE_BUNDLE_SHA256";
const BRIDGE_BUNDLE_ENV = "BRIDGE_BUNDLE";
const BRIDGE_BUNDLE_SOURCE_BAKED = "baked";
const BRIDGE_BUNDLE_SOURCE_INJECTED = "injected";
const BRIDGE_BUNDLE_FALLBACK_METRIC = "arcanist.freestyle.bridge_bundle_fallback";
const BRIDGE_BUNDLE_INJECT_MS_METRIC = "arcanist.freestyle.bridge_bundle_inject_ms";
const BAKED_START_BRIDGE_COMMAND = "bash /app/start-bridge.sh";

// A minimal handle over the Freestyle Vm the injection uses (exec + fs.writeFile). The
// concrete SDK Vm satisfies it; kept narrow so the unit tests mock only what is exercised.
type FreestyleVmForInject = {
  exec(options: { command: string; timeoutMs?: number }): Promise<{ statusCode?: number | null }>;
  fs: { writeFile(path: string, content: Buffer): Promise<void> };
};

type BridgeBundleFallbackReason =
  | "pointer_missing"
  | "pointer_blob_missing"
  | "blob_too_large"
  | "vm_write_failed"
  | "verify_failed"
  | "timeout"
  | "error";

// Outcome of an injection attempt. `skip` is the QUIET path (no binding, i.e. local dev):
// baked bundle, debug log, no metric. `fallback` fired when the bound bucket could not
// deliver a verified fresh bundle (including a missing pointer): baked bundle, warn log,
// fallback metric. `injected` is the win.
type BridgeBundleInjectOutcome =
  { kind: "skip" } | { kind: "injected"; sha256: string } | { kind: "fallback"; reason: BridgeBundleFallbackReason };

export type BridgeBundlePointer = {
  sha256: string;
  key: string;
  bytes: number;
  gzBytes: number;
  builtAt: string;
  gitSha: string;
};

// A resume that lands while the VM is mid-suspend throws VM_IS_SUSPENDING
// (classified not_ready) until the suspend completes — tens of seconds. Rethrowing
// instead hands the failure to the prompt-level spawn retry, whose attempts are
// immediate and capped (SPAWN_RETRY_CAP=2), so they burn out in seconds and the
// prompt hard-fails (ARC-1479). Waiting it out in place is the correct move; the
// Front-loaded probes let quickly-ready warm resumes reconnect sooner, while the
// 61.5s sleep budget stays near the previous 60s budget and well inside the
// 3-minute warm SPAWN_CONNECT_TIMEOUT_MS deadline. The prompt-level retry remains
// the backstop past exhaustion.
const CONNECT_NOT_READY_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 10_000, 12_000, 12_000, 12_000];

/**
 * Raw account-wide VM listing entry surfaced ONLY to the alert-only audit
 * (ARC-1477). `createdAt` is the SDK's optional ISO timestamp — callers must
 * tolerate null.
 */
export type FreestyleAuditVm = {
  id: string;
  state: string;
  createdAt: string | null;
  deleted: boolean;
};

// ARC-1478: getSandboxInfo feeds the disconnect watchdog's one-shot kill decision
// (only an affirmative alive defers), so a single transient API blip must not read a
// live VM as `unknown`. Observed live: a per-VM GET that timed out at 15s, took 11.6s
// on the second try, and was back to ~0.35s within ~30s — 3 attempts spaced by these
// backoffs (with the caller's requestTimeoutMs bounding each attempt) ride out that
// class of blip. Worst case ≈ 3×requestTimeoutMs + 750ms on the 90s watchdog path.
const FREESTYLE_INFO_MAX_ATTEMPTS = 3;
const FREESTYLE_INFO_RETRY_BACKOFF_MS = [250, 500] as const;
// Transient-only: auth/quota/missing_config are deterministic (retry burns watchdog
// time for the same answer) and missing_sandbox/killed are decisive.
const FREESTYLE_INFO_RETRYABLE_CODES: ReadonlySet<E2BSandboxRuntimeErrorCode> = new Set([
  "timeout",
  "network",
  "rate_limit",
  "unknown",
]);

// Per-attempt bound for the state probe pauseSandbox runs when suspend() reports a VM
// that is already parked/parking (not_ready). getSandboxInfo does up to 3 attempts, so
// the worst case (~3x this + backoff) stays inside the DO's 30s pause timeout.
const FREESTYLE_PAUSE_STATE_PROBE_TIMEOUT_MS = 5_000;

// The SDK's Vm.getInfo() (GET /v1/vms/{vm_id}) is implemented but absent from the
// package's .d.ts; this pins the minimal response shape the probe reads. `deleted`
// is a boolean flag SEPARATE from `state` (the SDK `state` enum has no "deleted"
// member); the account-wide list path keyed on it, and the per-VM record carries it
// too — a soft-deleted VM can still report a live-ish `state` during the delete
// window, so the flag must be read, not just the state.
type FreestyleVmInfoReader = {
  getInfo(): Promise<{ id?: string; state?: string | null; deleted?: boolean }>;
};

// The SDK's Vm.suspend() (POST /v1/vms/{vm_id}/suspend) is implemented but, like
// getInfo(), ABSENT from the package's .d.ts. It parks the VM to disk with memory
// preserved (RAM contents AND running processes) and keeps the SAME vmId — verified
// live (ARC-1481): a /dev/shm marker, a running heartbeat PID, and the kernel boot_id
// all survived a suspend->start cycle, so it is a warm resume, not a stop/reboot. The
// 200 body carries the vmId + a snapshotLayerId; pauseSandbox ignores it (success alone
// means the VM is parked).
type FreestyleVmSuspender = {
  suspend(): Promise<{ id?: string; vmInstanceId?: string; snapshotLayerId?: string }>;
};

// start() forwards its options verbatim to the wire (POST /v1/vms/{vm_id}/start, SDK
// `body: options`), so it accepts activityThresholdBytes there, but the package .d.ts
// only declares idleTimeoutSeconds. Pin the shape connectSandbox actually sends so
// re-arming the idle timer on resume ALSO re-pins the activity threshold (ARC-1482);
// both are per-start idle-timer parameters, so a start that omits activityThresholdBytes
// reverts it to the account default and unpins what createSandbox set.
type FreestyleVmStarter = {
  start(options: { idleTimeoutSeconds?: number; activityThresholdBytes?: number }): Promise<unknown>;
};

export type FreestyleClientConfig = {
  apiKey?: string;
  // Repurposes the E2B "defaultTemplate" slot: the Freestyle base snapshot to
  // boot from. Required for createSandbox — a cold boot (bare Debian, no bridge
  // bundle) can never produce a usable session, so spawn fails closed without it.
  // Terminate-only clients (buildCleanupClient) may omit it.
  defaultSnapshotId?: string;
  idleTimeoutSeconds?: number;
  baseUrl?: string;
  // Injectable fetch for the Cloudflare Workers runtime.
  fetch?: typeof fetch;
  logger?: Logger;
  // ARC-1512 fresh-bridge injection (Freestyle-only, all optional). Absent binding ->
  // quiet skip: the VM launches with the baked bundle, never failing the spawn.
  bridgeBundles?: R2Bucket;
  // Telemetry context for the fallback/inject-duration metrics; absent -> metrics no-op.
  ddApiKey?: string;
  workerEnv?: string;
};

/**
 * Freestyle implementation of the SandboxProviderClient contract. Reuses the E2B
 * error taxonomy (E2BSandboxRuntimeError + codes) verbatim — the control plane's
 * dead-VM detection branches on `code ∈ {missing_sandbox, killed}` and the spawn
 * retry classifier keys on `err.name === "E2BSandboxRuntimeError"` + code, so every
 * failure MUST normalize into that error class or those paths silently break.
 * `runtimeProvider` is the honest vendor tag "freestyle": the persisted
 * `runtime_provider` is derived from `runtime_backend` (via `providerForRuntimeBackend`)
 * at every write site, and lifecycle guards admit any known provider
 * (`isKnownRuntimeProvider`), so an honest "freestyle" no longer wedges the runtime.
 * This create-response value is telemetry-only (not the persistence source).
 */
export class FreestyleSandboxClient implements SandboxProviderClient {
  private readonly apiKey?: string;
  private readonly defaultSnapshotId?: string;
  private readonly idleTimeoutSeconds: number;
  private readonly baseUrl?: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly logger: Logger;
  private readonly bridgeBundles?: R2Bucket;
  private readonly ddApiKey?: string;
  private readonly workerEnv?: string;
  private client?: Freestyle;

  constructor(config: FreestyleClientConfig) {
    this.apiKey = config.apiKey;
    this.defaultSnapshotId = config.defaultSnapshotId?.trim() || undefined;
    this.idleTimeoutSeconds =
      config.idleTimeoutSeconds && config.idleTimeoutSeconds > 0
        ? Math.floor(config.idleTimeoutSeconds)
        : DEFAULT_IDLE_TIMEOUT_SECONDS;
    this.baseUrl = config.baseUrl?.trim() || undefined;
    this.fetchImpl = config.fetch;
    this.logger = config.logger ?? createLogger({ bindings: { component: "freestyle-sandbox-client" } });
    this.bridgeBundles = config.bridgeBundles;
    this.ddApiKey = config.ddApiKey;
    this.workerEnv = config.workerEnv;
  }

  async createSandbox(request: E2BCreateSandboxRequest): Promise<E2BCreateSandboxResponse> {
    return this.withRuntimeErrors(
      "createSandbox",
      undefined,
      async () => {
        const client = this.requireClient();
        // IGNORE request.template — it is an E2B template id. Freestyle boots from
        // the per-repo prebaked snapshot when the spawn resolved one (request field,
        // never `template`), else the base snapshot from client config.
        const snapshotId = request.freestyleSnapshotId?.trim() || this.defaultSnapshotId;
        // Fail closed: a snapshot-less create boots bare Debian with no bridge
        // bundle, so the session can never start (ARC-1480). requestSent stays
        // false — no VM exists, so there is nothing to terminate or retry.
        if (!snapshotId) throw missingConfig("FREESTYLE_DEFAULT_SNAPSHOT_ID is required to create a sandbox");
        const createStartedAt = Date.now();
        // Per-repo sizing (from an explicit repo spec) maps to memSizeGb/vcpuCount/
        // rootfsSizeGb; absent it, the spread is empty and the create is byte-identical
        // to the pre-sizing call, so the base snapshot's baked 8 GiB/4 vCPU/16 GB rootfs
        // is preserved for unspecced repos. The SDK's typed create() omits these knobs
        // even though the runtime forwards them (verified on the wire); the cast + the
        // freestyle-sdk-contract test pin that forwarding.
        const sizing = freestyleVmSizing(request.resources);
        const created = await client.vms.create({
          snapshotId,
          // No metadata field exists; the name is the only operator-visible tag.
          name: buildVmName(request),
          idleTimeoutSeconds: this.idleTimeoutSeconds,
          // Pin idle/retention behavior instead of inheriting account defaults (ARC-1482).
          activityThresholdBytes: ACTIVITY_THRESHOLD_BYTES,
          persistence: VM_PERSISTENCE,
          ...sizing,
        } as FreestyleVmCreateOptions);
        const createdAt = Date.now();
        return {
          runtimeProvider: "freestyle" as const,
          runtimeSandboxId: created.vmId,
          runtimeTemplateId: snapshotId,
          status: "running" as const,
          createdAt,
          createDurationMs: createdAt - createStartedAt,
        };
      },
      { runtimeSandboxIdFromResult: (result) => result.runtimeSandboxId },
    );
  }

  async listCycloidSandboxes(): Promise<E2BListedSandbox[]> {
    // Freestyle's vms.list() is account-wide with no metadata/ownership filter, so
    // it cannot safely feed the orphan reaper or any list-then-reap path (it would
    // surface VMs from other sessions/environments). No live consumer calls this on
    // the Freestyle client — the reaper hardcodes the E2B client, and the disconnect
    // cross-check dispatches Freestyle to the per-VM getSandboxInfo read instead of a
    // list (ARC-1484). Returning [] guarantees this client never issues an
    // account-wide operation and the E2B reaper never sees a Freestyle vmId.
    return [];
  }

  /**
   * ACCOUNT-WIDE read-only listing for the ALERT-ONLY VM audit (ARC-1477).
   * Deliberately separate from listCycloidSandboxes (which returns [] so no
   * reap path can consume an account-wide list on the shared account) and
   * deliberately NOT part of SandboxProviderClient. The returned ids must
   * never feed terminate/delete — killing an unregistered VM is gated on
   * ARC-1399 env isolation.
   */
  async listAccountVmsForAudit(options: { requestTimeoutMs?: number } = {}): Promise<FreestyleAuditVm[]> {
    return this.withRuntimeErrors("listAccountVmsForAudit", undefined, async () => {
      const client = this.requireClient();
      const listPromise = client.vms.list();
      const listed = options.requestTimeoutMs
        ? await raceWithTimeout(listPromise, options.requestTimeoutMs)
        : await listPromise;
      return listed.vms.map((vm) => ({
        id: vm.id,
        state: String(vm.state),
        createdAt: vm.createdAt ?? null,
        deleted: Boolean(vm.deleted),
      }));
    });
  }

  async connectSandbox(runtimeSandboxId: string, timeoutMs: number): Promise<E2BConnectedSandbox> {
    return this.withRuntimeErrors("connectSandbox", runtimeSandboxId, async () => {
      const client = this.requireClient();
      validateSandboxId(runtimeSandboxId);
      validatePositiveMs(timeoutMs, "Freestyle sandbox timeout");
      // Wake a suspended VM and re-arm the idle timer. A gone VM throws here and is
      // normalized to missing_sandbox/killed so the caller's resume-failure clear +
      // liveness probe fire exactly as for E2B. A not_ready VM (mid-suspend,
      // mid-create, host capacity) is retried in place below.
      for (let attempt = 0; ; attempt += 1) {
        try {
          // Re-arm the idle timer AND re-pin the activity threshold on wake: both are
          // per-start idle-timer parameters (absent from the VM record), so a start that
          // omits activityThresholdBytes reverts it to the account default and unpins what
          // createSandbox set (ARC-1482). start() forwards these to the wire but the .d.ts
          // only declares idleTimeoutSeconds, so cast (mirrors the getInfo/suspend casts).
          const starter = client.vms.ref({ vmId: runtimeSandboxId }) as unknown as FreestyleVmStarter;
          await starter.start({
            idleTimeoutSeconds: this.idleTimeoutSeconds,
            activityThresholdBytes: ACTIVITY_THRESHOLD_BYTES,
          });
          break;
        } catch (error) {
          const runtimeError = normalizeFreestyleError(error, "connectSandbox");
          const delayMs = CONNECT_NOT_READY_RETRY_DELAYS_MS[attempt];
          if (runtimeError.code !== "not_ready" || delayMs === undefined) throw runtimeError;
          this.logger.info(
            {
              endpoint: "freestyle",
              method: "connectSandbox",
              runtimeSandboxId,
              attempt: attempt + 1,
              maxAttempts: CONNECT_NOT_READY_RETRY_DELAYS_MS.length + 1,
              delayMs,
              status: runtimeError.status,
            },
            "Freestyle VM not ready to start; retrying in place",
          );
          await sleep(delayMs);
        }
      }
      return new E2BConnectedSandbox(runtimeSandboxId);
    });
  }

  async refreshSandbox(
    runtimeSandboxId: string,
    durationMs: number,
  ): Promise<{ status: "refreshed"; refreshedUntil?: number | null }> {
    // Synthetic no-op: Freestyle has no TTL analog and resets its idle timer on
    // network activity automatically. Returning a synthetic refreshedUntil keeps the
    // caller's runtimeProviderTtl bookkeeping + provider_refresh log coherent. It MUST
    // NOT throw — the caller's non-missing/killed catch would log a false failure every
    // refresh tick.
    this.logOperation("refreshSandbox", runtimeSandboxId, Date.now(), "success");
    return { status: "refreshed", refreshedUntil: Date.now() + durationMs };
  }

  async runCommand(request: RunCommandRequest): Promise<RunCommandResult> {
    return this.withRuntimeErrors("runCommand", request.runtimeSandboxId, async () => {
      const client = this.requireClient();
      validateSandboxId(request.runtimeSandboxId);
      const result = await client.vms.ref({ vmId: request.runtimeSandboxId }).exec({
        command: buildRunCommand(request),
        ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
      });
      // vm.exec returns statusCode (not exitCode) and never throws on non-zero.
      return {
        exitCode: typeof result.statusCode === "number" ? result.statusCode : 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    });
  }

  async startCommand(request: StartCommandRequest): Promise<{ pid: number; startedAt: number }> {
    return this.withRuntimeErrors("startCommand", request.runtimeSandboxId, async () => {
      const client = this.requireClient();
      validateSandboxId(request.runtimeSandboxId);
      const vm = client.vms.ref({ vmId: request.runtimeSandboxId });
      // ARC-1566: inject the current start-bridge.sh from R2 before launch so Freestyle
      // sessions do not wait for a base snapshot rebuild to pick up boot-sequencing fixes.
      const command = await this.injectFreshStartBridgeCommand(vm, request.command);
      // ARC-1512: inject the current bridge bundle from R2 before writing the env, so the
      // launcher's BRIDGE_BUNDLE points at the fresh copy. Returns the bridge env overrides
      // (BRIDGE_BUNDLE + CYCLOID_BRIDGE_BUNDLE_*); never throws, never fails the spawn.
      const bridgeEnv = await this.injectFreshBridgeBundle(vm);
      // Write the session env file (shell-quoted exports, 0600) then launch the bridge
      // detached. vm.exec is synchronous with no pid; executing the bridge directly
      // would block forever, so wrap it in nohup/setsid and read $! for the pid.
      await vm.exec({ command: `mkdir -p ${dirName(SESSION_ENV_FILE_PATH)}` });
      await vm.fs.writeTextFile(
        SESSION_ENV_FILE_PATH,
        buildSessionEnvScript({ ...(request.envs ?? {}), ...bridgeEnv }, request.runtimeSandboxId),
      );
      await vm.exec({ command: `chmod 600 ${SESSION_ENV_FILE_PATH}` });
      const result = await vm.exec({ command: buildDetachedStartCommand({ ...request, command }) });
      // pid is cosmetic — the caller never reads it; bridge health is proven by the
      // bridge's outbound WS. Fall back to 0 if $! could not be parsed.
      return { pid: parsePid(result.stdout), startedAt: Date.now() };
    });
  }

  private async injectFreshStartBridgeCommand(vm: FreestyleVmForInject, command: string): Promise<string> {
    if (command.trim() !== BAKED_START_BRIDGE_COMMAND) return command;

    const bucket = this.bridgeBundles;
    if (!bucket) {
      this.logger.debug(
        { endpoint: "freestyle", method: "startCommand", startBridgeSource: "baked" },
        "BRIDGE_BUNDLES binding absent; launching with the baked start-bridge script",
      );
      return command;
    }

    const startedAt = Date.now();
    let outcome: BridgeBundleInjectOutcome;
    try {
      outcome = await raceWithTimeout(this.runStartBridgeInjection(bucket, vm), START_BRIDGE_INJECT_TIMEOUT_MS);
    } catch (error) {
      const code = error instanceof E2BSandboxRuntimeError ? error.code : undefined;
      outcome = { kind: "fallback", reason: code === "timeout" ? "timeout" : "error" };
    }

    const base = { endpoint: "freestyle", method: "startCommand", durationMs: Date.now() - startedAt };
    switch (outcome.kind) {
      case "skip":
        this.logger.debug(
          { ...base, startBridgeSource: "baked" },
          "No start-bridge pointer in R2; launching with the baked start-bridge script",
        );
        return command;
      case "injected":
        this.logger.info(
          { ...base, startBridgeSource: "injected", startBridgeSha256: outcome.sha256 },
          "Injected fresh start-bridge script from R2",
        );
        return `bash ${START_BRIDGE_VM_PATH}`;
      case "fallback":
        this.logger.warn(
          {
            ...base,
            event: "freestyle_start_bridge_fallback",
            startBridgeSource: "baked",
            reason: outcome.reason,
          },
          "Fresh start-bridge injection failed; launching with the baked start-bridge script",
        );
        return command;
    }
  }

  /**
   * Resolve + inject the current bridge bundle from R2, returning the env overrides to
   * fold into session-env.sh. NEVER throws — every failure resolves to a launch decision:
   *  - no binding / no pointer  -> QUIET skip (debug log, no metric), baked bundle
   *  - injected + verified      -> BRIDGE_BUNDLE override + sha + source=injected
   *  - any post-pointer failure -> baked bundle, warn log + fallback metric
   * Bounded by BRIDGE_BUNDLE_INJECT_TIMEOUT_MS so it cannot blow the spawn budget.
   */
  private async injectFreshBridgeBundle(vm: FreestyleVmForInject): Promise<Record<string, string>> {
    const bucket = this.bridgeBundles;
    if (!bucket) {
      // Quiet skip: the binding is optional (absent locally / in unprovisioned envs). The
      // VM boots from its baked bundle exactly as before this change. Debug-only, no metric.
      this.logger.debug(
        { endpoint: "freestyle", method: "startCommand", bridgeBundleSource: BRIDGE_BUNDLE_SOURCE_BAKED },
        "BRIDGE_BUNDLES binding absent; launching with the baked bridge bundle",
      );
      return { [BRIDGE_BUNDLE_SOURCE_ENV]: BRIDGE_BUNDLE_SOURCE_BAKED };
    }
    const startedAt = Date.now();
    let outcome: BridgeBundleInjectOutcome;
    try {
      outcome = await raceWithTimeout(this.runBridgeBundleInjection(bucket, vm), BRIDGE_BUNDLE_INJECT_TIMEOUT_MS);
    } catch (error) {
      // The inner runner never rejects; the only rejection here is the timeout race. Treat
      // an unexpected rejection as a generic error so the spawn still proceeds baked.
      const code = error instanceof E2BSandboxRuntimeError ? error.code : undefined;
      outcome = { kind: "fallback", reason: code === "timeout" ? "timeout" : "error" };
    }
    return this.applyBridgeBundleOutcome(outcome, Date.now() - startedAt);
  }

  private applyBridgeBundleOutcome(outcome: BridgeBundleInjectOutcome, durationMs: number): Record<string, string> {
    const base = { endpoint: "freestyle", method: "startCommand", durationMs };
    switch (outcome.kind) {
      case "skip":
        this.logger.debug(
          { ...base, bridgeBundleSource: BRIDGE_BUNDLE_SOURCE_BAKED },
          "No bridge bundle pointer in R2; launching with the baked bridge bundle",
        );
        return { [BRIDGE_BUNDLE_SOURCE_ENV]: BRIDGE_BUNDLE_SOURCE_BAKED };
      case "injected":
        this.logger.info(
          { ...base, bridgeBundleSource: BRIDGE_BUNDLE_SOURCE_INJECTED, bridgeBundleSha256: outcome.sha256 },
          "Injected fresh bridge bundle from R2",
        );
        this.emitBridgeBundleInjectDuration(durationMs, BRIDGE_BUNDLE_SOURCE_INJECTED);
        return {
          [BRIDGE_BUNDLE_ENV]: BRIDGE_BUNDLE_VM_PATH,
          [BRIDGE_BUNDLE_SHA256_ENV]: outcome.sha256,
          [BRIDGE_BUNDLE_SOURCE_ENV]: BRIDGE_BUNDLE_SOURCE_INJECTED,
        };
      case "fallback":
        this.logger.warn(
          {
            ...base,
            event: "freestyle_bridge_bundle_fallback",
            bridgeBundleSource: BRIDGE_BUNDLE_SOURCE_BAKED,
            reason: outcome.reason,
          },
          "Fresh bridge bundle injection failed; launching with the baked bridge bundle",
        );
        this.emitBridgeBundleFallbackMetric(outcome.reason);
        this.emitBridgeBundleInjectDuration(durationMs, BRIDGE_BUNDLE_SOURCE_BAKED);
        return { [BRIDGE_BUNDLE_SOURCE_ENV]: BRIDGE_BUNDLE_SOURCE_BAKED };
    }
  }

  /**
   * The actual R2 read + in-VM drop/gunzip/verify. Returns a decision instead of throwing
   * so injectFreshBridgeBundle can log/metric uniformly. Only an absent BINDING (local
   * dev) skips quietly — a bound bucket with no pointer is a metriced fallback: the
   * publish step ships in the same deploy as this code (parallel prod jobs, so at worst
   * the very first rollout sees a brief pointer_missing window before its publish lands);
   * steady-state, a missing pointer means the publish was deleted or never ran, and every
   * session would silently boot the baked bundle — the exact regression this feature closes.
   */
  private async runBridgeBundleInjection(
    bucket: R2Bucket,
    vm: FreestyleVmForInject,
  ): Promise<BridgeBundleInjectOutcome> {
    let pointerObject: R2ObjectBody | null;
    try {
      pointerObject = await bucket.get(BRIDGE_BUNDLE_POINTER_KEY);
    } catch {
      return { kind: "fallback", reason: "error" };
    }
    if (!pointerObject) return { kind: "fallback", reason: "pointer_missing" };

    let pointer: BridgeBundlePointer;
    try {
      pointer = parseBridgeBundlePointer(await pointerObject.text());
    } catch {
      // Malformed/partial pointer: the publish wrote garbage. Metric it (silent staleness
      // is exactly the bug this feature exists to surface) and launch baked.
      return { kind: "fallback", reason: "error" };
    }

    let blob: R2ObjectBody | null;
    try {
      blob = await bucket.get(pointer.key);
    } catch {
      return { kind: "fallback", reason: "error" };
    }
    if (!blob) return { kind: "fallback", reason: "pointer_blob_missing" };

    let gz: Buffer;
    try {
      // R2 returns the stored bytes verbatim (the gz); content-encoding metadata is only
      // applied on HTTP serving, not on the binding read. So this is the gzip payload,
      // written as .gz and gunzipped in-VM — mirroring the base builder's dropBundle.
      gz = Buffer.from(await blob.arrayBuffer());
    } catch {
      return { kind: "fallback", reason: "error" };
    }
    if (gz.length >= FS_WRITE_CAP_BYTES) return { kind: "fallback", reason: "blob_too_large" };

    try {
      await vm.fs.writeFile(BRIDGE_BUNDLE_GZ_VM_PATH, gz);
    } catch {
      return { kind: "fallback", reason: "vm_write_failed" };
    }

    // gunzip + sha256 verify. vm.exec returns statusCode (NOT exitCode) and does NOT throw
    // on non-zero, so a sha mismatch surfaces as statusCode !== 0. An indeterminate status
    // (null/undefined) must NOT pass the integrity gate — only a literal 0 injects; the
    // baked bundle is the safe default.
    let verify: { statusCode?: number | null };
    try {
      verify = await vm.exec({ command: buildBridgeVerifyCommand(pointer.sha256) });
    } catch {
      return { kind: "fallback", reason: "verify_failed" };
    }
    if (verify.statusCode !== 0) return { kind: "fallback", reason: "verify_failed" };

    return { kind: "injected", sha256: pointer.sha256 };
  }

  private async runStartBridgeInjection(
    bucket: R2Bucket,
    vm: FreestyleVmForInject,
  ): Promise<BridgeBundleInjectOutcome> {
    let pointerObject: R2ObjectBody | null;
    try {
      pointerObject = await bucket.get(START_BRIDGE_POINTER_KEY);
    } catch {
      return { kind: "fallback", reason: "error" };
    }
    if (!pointerObject) return { kind: "fallback", reason: "pointer_missing" };

    let pointer: BridgeBundlePointer;
    try {
      pointer = parseStartBridgePointer(await pointerObject.text());
    } catch {
      return { kind: "fallback", reason: "error" };
    }

    let blob: R2ObjectBody | null;
    try {
      blob = await bucket.get(pointer.key);
    } catch {
      return { kind: "fallback", reason: "error" };
    }
    if (!blob) return { kind: "fallback", reason: "pointer_blob_missing" };

    let gz: Buffer;
    try {
      gz = Buffer.from(await blob.arrayBuffer());
    } catch {
      return { kind: "fallback", reason: "error" };
    }
    if (gz.length >= FS_WRITE_CAP_BYTES) return { kind: "fallback", reason: "blob_too_large" };

    try {
      await vm.fs.writeFile(START_BRIDGE_GZ_VM_PATH, gz);
    } catch {
      return { kind: "fallback", reason: "vm_write_failed" };
    }

    let verify: { statusCode?: number | null };
    try {
      verify = await vm.exec({ command: buildStartBridgeVerifyCommand(pointer.sha256) });
    } catch {
      return { kind: "fallback", reason: "verify_failed" };
    }
    if (verify.statusCode !== 0) return { kind: "fallback", reason: "verify_failed" };

    return { kind: "injected", sha256: pointer.sha256 };
  }

  // Best-effort telemetry (fire-and-forget; the metric helpers already swallow their own
  // errors and are bounded at 2s). No DD key -> no-op (local/tests, no network). The metric
  // name + reason tags are a FIXED contract with PR 3.
  private emitBridgeBundleFallbackMetric(reason: BridgeBundleFallbackReason): void {
    if (!this.ddApiKey) return;
    const tags = [...baseControlPlaneMetricTags({ WORKER_ENV: this.workerEnv }), `reason:${reason}`];
    void postCountMetric(this.ddApiKey, BRIDGE_BUNDLE_FALLBACK_METRIC, tags, "freestyle-bridge-bundle-fallback").catch(
      () => {},
    );
  }

  private emitBridgeBundleInjectDuration(durationMs: number, source: string): void {
    if (!this.ddApiKey) return;
    const tags = [...baseControlPlaneMetricTags({ WORKER_ENV: this.workerEnv }), `source:${source}`];
    void postGaugeMetricSeries(
      this.ddApiKey,
      [{ metric: BRIDGE_BUNDLE_INJECT_MS_METRIC, tags, value: durationMs }],
      "freestyle-bridge-bundle-inject-ms",
    ).catch(() => {});
  }

  async pauseSandbox(runtimeSandboxId: string): Promise<{ status: "paused" }> {
    return this.withRuntimeErrors("pauseSandbox", runtimeSandboxId, async () => {
      const client = this.requireClient();
      validateSandboxId(runtimeSandboxId);
      // Park the VM NOW via the memory-preserving suspend instead of leaving it running
      // until its own idleTimeoutSeconds fires ~40 min later. The prior no-op flipped the
      // row to `paused` while the VM kept billing at full CPU/mem for the whole idle
      // window (ARC-1481). suspend() writes RAM to disk, keeps the vmId stable, and
      // connectSandbox's start() later wakes it warm — no id desync, no lost state. The
      // create-time idle timeout stays as a backstop if this call fails transiently. Both
      // callers (idle-pause, stop-boundary) only fire with no active prompt, so this never
      // suspends in-flight work. suspend() is absent from the SDK .d.ts (same blind spot
      // as getInfo, ARC-1478): cast + typeof-guard so an SDK bump surfaces as a decisive
      // missing_config rather than a TypeError; freestyle-sdk-contract.test.ts pins the
      // method against the real SDK so the break is caught at CI, not in prod.
      const vm = client.vms.ref({ vmId: runtimeSandboxId }) as unknown as FreestyleVmSuspender;
      if (typeof vm.suspend !== "function") {
        throw missingConfig(
          "Freestyle SDK Vm.suspend() is missing -- the installed SDK dropped the memory-preserving suspend",
        );
      }
      try {
        await vm.suspend();
        return { status: "paused" as const };
      } catch (error) {
        const runtimeError = normalizeFreestyleError(error, "pauseSandbox");
        // suspend() on a VM that is ALREADY suspended/suspending (the idle timer, a prior
        // pause, or a racing pause beat us) rejects with VM_NOT_RUNNING / VM_IS_SUSPENDING,
        // which the shared taxonomy classifies `not_ready` — that means "retry the start"
        // for connectSandbox but "already parked" for pause. Propagating it would leave the
        // caller's row `running` over a VM that is actually parked, and the cleanup sweep
        // (which only terminates `paused` rows) would churn on it forever, leaking a
        // storage-billing VM. So on `not_ready`, read the REAL state to converge the row.
        if (runtimeError.code !== "not_ready") throw runtimeError;
        const parked = await this.probeSuspendedForPause(runtimeSandboxId);
        // Only an EXPLICIT suspended/suspending state proves the VM is parked.
        if (parked === "suspended") return { status: "paused" as const };
        // Stopped/lost/deleted -> memory is gone; report missing so the caller respawns
        // instead of leaving a dead VM projected as paused.
        if (parked === "gone") {
          throw new E2BSandboxRuntimeError("Freestyle VM is gone after a rejected suspend", {
            code: "missing_sandbox",
            requestSent: true,
            cause: error,
          });
        }
        // running/building/unrecognized/absent state, or an inconclusive probe: the VM is
        // (or may be) genuinely up, so keep the retryable not_ready and let the caller leave
        // it running for the next sweep rather than lie that it is paused.
        throw runtimeError;
      }
    });
  }

  /**
   * Confirm a VM is actually parked for pause convergence. Deliberately NOT getSandboxInfo:
   * that method's watchdog live-bias maps an unrecognized/absent state (building, hibernating,
   * a missing `state` field) to `paused` so the disconnect watchdog never fail-closes on a
   * live VM (ARC-1478). That bias is correct for LIVENESS but must NOT be read as proof of
   * suspension — accepting it would let pause persist `paused` + close sockets over a VM that
   * is still running/billing, re-opening ARC-1481. So read the raw state and require an
   * explicit suspended state; anything else stays inconclusive so pause keeps the retryable
   * not_ready. getInfo (GET /v1/vms/{vm_id}) never wakes the VM or touches its idle timer.
   */
  private async probeSuspendedForPause(runtimeSandboxId: string): Promise<"suspended" | "gone" | "unconfirmed"> {
    try {
      const reader = this.requireClient().vms.ref({ vmId: runtimeSandboxId }) as unknown as FreestyleVmInfoReader;
      if (typeof reader.getInfo !== "function") return "unconfirmed";
      const info = await raceWithTimeout(reader.getInfo(), FREESTYLE_PAUSE_STATE_PROBE_TIMEOUT_MS);
      // Deletion is a decisive death flag independent of `state` (ARC-1478).
      if (info?.deleted) return "gone";
      const state = String(info?.state ?? "")
        .trim()
        .toLowerCase();
      if (state === "suspended" || state === "suspending") return "suspended";
      if (state === "stopped" || state === "lost") return "gone";
      // running/starting/building/unrecognized/absent: NOT confirmed parked.
      return "unconfirmed";
    } catch (error) {
      // A decisive VM_DELETED / NOT_FOUND read means the VM is gone -> respawn; any other
      // probe failure is inconclusive, so pause keeps the retryable not_ready.
      return normalizeFreestyleError(error, "pauseSandbox").code === "missing_sandbox" ? "gone" : "unconfirmed";
    }
  }

  async terminateSandbox(
    runtimeSandboxId: string,
    reason: SandboxTerminateReason,
  ): Promise<{ status: "killed" | "missing" }> {
    return this.withRuntimeErrors(
      "terminateSandbox",
      runtimeSandboxId,
      async () => {
        const client = this.requireClient();
        validateSandboxId(runtimeSandboxId);
        await client.vms.delete({ vmId: runtimeSandboxId });
        return { status: "killed" as const };
      },
      { missingSandboxAsResult: true, extraLogFields: { reason } },
    );
  }

  async getSandboxInfo(
    runtimeSandboxId: string,
    options: { requestTimeoutMs?: number } = {},
  ): Promise<E2BSandboxInfoResult> {
    // Liveness probe: per-VM metadata read (GET /v1/vms/{vm_id}) that never wakes the
    // VM or touches its idle timer (verified live: lastNetworkActivity unchanged
    // across reads). NOT vms.list(): the list is account-wide, so its latency grows
    // with the shared account, and a 5s probe timeout on a slow list read a healthy
    // VM as `unknown`. The 90s watchdog fails closed to terminate on unknown, so a
    // single false `unknown` kills a live prompt (ARC-1478) — retry transient
    // failures before giving up, and never throw out of this method. A deleted VM
    // surfaces as a decisive VM_DELETED error → missing_sandbox → `missing`.
    const startedAt = Date.now();
    let lastError: E2BSandboxRuntimeError | undefined;
    for (let attempt = 1; attempt <= FREESTYLE_INFO_MAX_ATTEMPTS; attempt++) {
      try {
        const client = this.requireClient();
        validateSandboxId(runtimeSandboxId);
        // getInfo() exists on the SDK Vm class (GET /v1/vms/{vm_id}) but is missing
        // from its .d.ts; the local reader type pins the shape we rely on. Guard the
        // cast: if an SDK upgrade drops/renames the method, fail with a decisive
        // missing_config (non-retryable, distinct in Datadog) instead of a TypeError
        // that classifies as retryable `network` and masquerades as an outage.
        // freestyle-sdk-contract.test.ts pins the same method against the real
        // (unmocked) SDK so a bump is caught at CI time, not in prod.
        const vm = client.vms.ref({ vmId: runtimeSandboxId }) as unknown as FreestyleVmInfoReader;
        if (typeof vm.getInfo !== "function") {
          throw missingConfig("Freestyle SDK Vm.getInfo() is missing -- the installed SDK dropped the per-VM read");
        }
        const infoPromise = vm.getInfo();
        // getInfo has no per-request timeout; honor the probe's requestTimeoutMs per
        // attempt so a hung read fails toward retry rather than blocking the watchdog.
        const info = options.requestTimeoutMs
          ? await raceWithTimeout(infoPromise, options.requestTimeoutMs)
          : await infoPromise;
        // Deletion is a boolean flag, NOT a state value: a soft-deleted VM can still
        // report a live-ish `state` during the delete window, so biasing on state
        // alone would live-defer a dead VM (ARC-1478). Restore the list path's
        // `deleted` guard — an explicit flag is decisive death → respawn (mirrors the
        // VM_DELETED throw handled in the catch).
        const mapped: E2BSandboxInfoResult = info?.deleted ? { status: "missing" } : mapFreestyleVmState(info?.state);
        this.logOperation(
          "getSandboxInfo",
          runtimeSandboxId,
          startedAt,
          mapped.status === "missing" ? "missing" : "success",
          undefined,
          { attempt, ...("rawState" in mapped && mapped.rawState ? { rawState: mapped.rawState } : {}) },
        );
        return mapped;
      } catch (error) {
        const runtimeError = normalizeFreestyleError(error, "getSandboxInfo");
        if (runtimeError.code === "missing_sandbox") {
          // Decisive death (VM_DELETED / NOT_FOUND): no retry, report missing.
          this.logOperation("getSandboxInfo", runtimeSandboxId, startedAt, "missing", runtimeError, { attempt });
          return { status: "missing" };
        }
        lastError = runtimeError;
        const willRetry =
          attempt < FREESTYLE_INFO_MAX_ATTEMPTS && FREESTYLE_INFO_RETRYABLE_CODES.has(runtimeError.code);
        this.logOperation("getSandboxInfo", runtimeSandboxId, startedAt, "error", runtimeError, {
          attempt,
          willRetry,
        });
        if (!willRetry) break;
        await sleep(FREESTYLE_INFO_RETRY_BACKOFF_MS[attempt - 1] ?? FREESTYLE_INFO_RETRY_BACKOFF_MS[0]);
      }
    }
    return { status: "unknown", errorCode: lastError?.code ?? "unknown" };
  }

  private requireClient(): Freestyle {
    if (!this.apiKey) throw missingConfig("FREESTYLE_API_KEY is required");
    if (!this.client) {
      // Always hand the SDK a wrapper: it stores the function and invokes it with a
      // non-global `this`, which the Workers runtime rejects as an illegal invocation
      // when given the bare global fetch.
      const fetchImpl =
        this.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
      this.client = new Freestyle({
        apiKey: this.apiKey,
        ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
        fetch: fetchImpl,
      });
    }
    return this.client;
  }

  private async withRuntimeErrors<T>(
    method: string,
    runtimeSandboxId: string | undefined,
    run: () => Promise<T>,
    options: {
      missingSandboxAsResult?: boolean;
      runtimeSandboxIdFromResult?: (result: T) => string | undefined;
      extraLogFields?: Record<string, unknown>;
    } = {},
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await run();
      this.logOperation(
        method,
        options.runtimeSandboxIdFromResult?.(result) ?? runtimeSandboxId,
        startedAt,
        "success",
        undefined,
        options.extraLogFields,
      );
      return result;
    } catch (error) {
      const runtimeError = normalizeFreestyleError(error, method);
      if (options.missingSandboxAsResult && runtimeError.code === "missing_sandbox") {
        this.logOperation(method, runtimeSandboxId, startedAt, "missing", runtimeError, options.extraLogFields);
        return { status: "missing" } as T;
      }
      this.logOperation(method, runtimeSandboxId, startedAt, "error", runtimeError, options.extraLogFields);
      throw runtimeError;
    }
  }

  private logOperation(
    method: string,
    runtimeSandboxId: string | undefined,
    startedAt: number,
    outcome: "success" | "missing" | "error",
    error?: E2BSandboxRuntimeError,
    extraLogFields?: Record<string, unknown>,
  ): void {
    const fields = {
      endpoint: "freestyle",
      method,
      runtimeSandboxId,
      durationMs: Date.now() - startedAt,
      outcome,
      ...(extraLogFields ?? {}),
      ...(error ? { errorCode: error.code, status: error.status, requestSent: error.requestSent } : {}),
    };
    if (error) {
      this.logger.error(fields, "Freestyle sandbox runtime operation failed");
    } else {
      this.logger.info(fields, "Freestyle sandbox runtime operation completed");
    }
  }
}

// Repo slugs beyond this read as noise in the dashboard's name column; the
// 8-char session prefix after the slug is what actually disambiguates.
const VM_NAME_REPO_SLUG_MAX_LENGTH = 30;
const VM_NAME_SESSION_PREFIX_LENGTH = 8;

/**
 * The VM `name` is the ONLY operator-visible tag on a Freestyle VM (vms.create
 * has no metadata map and vms.list returns no names). Shape:
 * `cycloid[-<repo slug>]-<session-id prefix>` — readable in the shared
 * Freestyle dashboard, and the 8-hex-char prefix still uniquely finds the
 * session in D1. Sessionless creates keep the full internal sandboxId: they
 * get no reservation-trace row, so the name is their only handle. Exported so
 * the spawn reservation trace (ARC-1477) can persist the exact name a leaked
 * VM carries in the Freestyle dashboard.
 */
export function buildVmName(request: E2BCreateSandboxRequest): string {
  const repoSlug = slugifyVmNameSegment(request.metadata?.repo_name);
  const repoSegment = repoSlug ? `-${repoSlug}` : "";
  if (!request.sessionId) return `cycloid${repoSegment}-${request.sandboxId}`;
  return `cycloid${repoSegment}-${request.sessionId.slice(0, VM_NAME_SESSION_PREFIX_LENGTH)}`;
}

function slugifyVmNameSegment(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, VM_NAME_REPO_SLUG_MAX_LENGTH)
    .replace(/-+$/, "");
}

function mapFreestyleVmState(state: string | null | undefined): E2BSandboxInfoResult {
  // Case-insensitive: a recased SDK/API state must not fall through to the default.
  switch (
    String(state ?? "")
      .trim()
      .toLowerCase()
  ) {
    case "running":
    case "starting":
      return { status: "running" };
    case "suspended":
    case "suspending":
      return { status: "paused" };
    case "stopped":
    case "lost":
      // Memory is gone (stop drops it; lost = host lost) — the bridge cannot come
      // back on this VM, so terminate-and-respawn is the correct recovery.
      return { status: "missing" };
    case "deleted":
      // Defense-in-depth. Deletion normally arrives as the boolean `deleted` flag
      // (guarded in getSandboxInfo before this mapping) or a thrown VM_DELETED (the
      // catch). The SDK `state` enum has no "deleted" member, but the lifecycle docs
      // list it — so if the API ever surfaces `deleted` AS a state, classify it
      // decisively as missing rather than letting the live-biased default defer a
      // dead VM.
      return { status: "missing" };
    default:
      // building, a renamed/future state, or a missing field: the per-VM read
      // SUCCEEDED, so the VM exists — this is not death evidence, and `unknown`
      // feeds the watchdog's fail-closed terminate (ARC-1478). Bias live as
      // `paused`: the watchdog defers within its bounded hold and re-probes, and a
      // real death converges to VM_DELETED/stopped/lost on a later read. Preserve
      // the raw state so state-map drift is diagnosable upstream — but only when the
      // API actually sent one: String(null)/String(undefined) would emit the literal
      // "null"/"undefined", which an operator cannot tell apart from a real state
      // named that, so omit rawState entirely for an absent field.
      return { status: "paused", ...(state != null ? { rawState: String(state) } : {}) };
  }
}

// Detached launcher: nohup + setsid so the bridge survives the exec call returning,
// sourcing the session env with `set -a` so exports reach start-bridge.sh (which reads
// required vars from process env). `echo $!` prints the pid on stdout.
export function buildDetachedStartCommand(request: StartCommandRequest): string {
  const cwd = request.cwd ?? "/workspace";
  const inner = `set -a; . ${SESSION_ENV_FILE_PATH}; set +a; cd ${shellQuote(cwd)}; exec ${request.command}`;
  return `nohup setsid bash -lc '${inner.replace(/'/g, "'\\''")}' >/tmp/cycloid-start-bridge.out 2>&1 & echo $!`;
}

export function buildRunCommand(request: RunCommandRequest): string {
  // vm.exec has no cwd/envs options; inline them. Only the bridge-startup diagnostic
  // uses this path today, but keep parity with the E2B client's cwd/envs support.
  const envPrefix = request.envs
    ? Object.entries(request.envs)
        .map(([key, value]) => `${key}=${shellQuote(value)}`)
        .join(" ")
    : "";
  const prefix = [request.cwd ? `cd ${shellQuote(request.cwd)} && ` : "", envPrefix ? `env ${envPrefix} ` : ""].join(
    "",
  );
  return `${prefix}${request.command}`;
}

// ARC-1475: the bridge's buildRuntimeReport (bridge.ts) sets runtime.sandboxId from
// `E2B_SANDBOX_ID || SANDBOX_ID`. E2B injects E2B_SANDBOX_ID (= the E2B sandbox id =
// runtime_sandbox_id) automatically; Freestyle has no analog, so without this the
// report falls back to SANDBOX_ID (the INTERNAL bootstrap sandbox id). The resume
// bridge-health gate (waitForE2BBridgeHealth) matches the reported id against the
// persisted runtime_sandbox_id (= the Freestyle vmId); on that fallback it never
// matches, the gate times out, and the just-woken live VM is terminated. Stamp
// E2B_SANDBOX_ID = vmId so the report carries the vmId and the gate resolves. This is
// the ONLY read of E2B_SANDBOX_ID in the bridge (auth + WS dial use SANDBOX_ID), so it
// changes nothing else. A caller-supplied value (never set today) still wins.
export function buildSessionEnvScript(envs: Record<string, string> | undefined, vmId: string): string {
  const merged: Record<string, string> = { E2B_SANDBOX_ID: vmId, ...(envs ?? {}) };
  const lines = Object.entries(merged).map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Validate the R2 pointer object (bridge/current.json). Contract with
 * publish-bridge-bundle.mjs `buildPointer`: `sha256` names the RAW bundle, `key` is its
 * content-addressed gz blob. Throws on any shape violation so a malformed/partial pointer
 * routes to the baked-bundle fallback rather than driving a bad inject. Only sha256 + key
 * are load-bearing (the rest is provenance); they are validated strictly.
 */
export function parseBridgeBundlePointer(text: string): BridgeBundlePointer {
  return parseInjectedArtifactPointer(text, "bridge/");
}

function parseStartBridgePointer(text: string): BridgeBundlePointer {
  return parseInjectedArtifactPointer(text, "start-bridge/");
}

function parseInjectedArtifactPointer(text: string, keyPrefix: string): BridgeBundlePointer {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const sha256 = raw.sha256;
  const key = raw.key;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("artifact pointer is missing a valid sha256");
  }
  if (typeof key !== "string" || !key.startsWith(keyPrefix)) {
    throw new Error("artifact pointer is missing a valid key");
  }
  return {
    sha256,
    key,
    bytes: typeof raw.bytes === "number" ? raw.bytes : 0,
    gzBytes: typeof raw.gzBytes === "number" ? raw.gzBytes : 0,
    builtAt: typeof raw.builtAt === "string" ? raw.builtAt : "",
    gitSha: typeof raw.gitSha === "string" ? raw.gitSha : "",
  };
}

/**
 * In-VM gunzip + sha256 verify of the injected bundle. The gz was staged at
 * BRIDGE_BUNDLE_GZ_VM_PATH; `gunzip -c` decompresses it into BRIDGE_BUNDLE_VM_PATH
 * (inside /app/bridge so the bundle's externalized deps resolve), and `sha256sum -c`
 * compares the result against the pointer's raw-bundle sha256, exiting non-zero on
 * mismatch. vm.exec surfaces that non-zero as a statusCode (it does not throw), so the
 * caller treats it as verify_failed. Two spaces separate hash and path (sha256sum's text
 * format). The sha256 is 64-char hex, so shellQuote leaves it bare.
 */
export function buildBridgeVerifyCommand(sha256: string): string {
  return (
    `gunzip -c ${BRIDGE_BUNDLE_GZ_VM_PATH} > ${BRIDGE_BUNDLE_VM_PATH} && ` +
    `rm -f ${BRIDGE_BUNDLE_GZ_VM_PATH} && ` +
    `printf '%s  %s\\n' ${shellQuote(sha256)} ${shellQuote(BRIDGE_BUNDLE_VM_PATH)} | sha256sum -c -`
  );
}

function buildStartBridgeVerifyCommand(sha256: string): string {
  return (
    `gunzip -c ${START_BRIDGE_GZ_VM_PATH} > ${START_BRIDGE_VM_PATH} && ` +
    `chmod 755 ${START_BRIDGE_VM_PATH} && ` +
    `rm -f ${START_BRIDGE_GZ_VM_PATH} && ` +
    `printf '%s  %s\\n' ${shellQuote(sha256)} ${shellQuote(START_BRIDGE_VM_PATH)} | sha256sum -c -`
  );
}

function dirName(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index <= 0 ? "/" : filePath.slice(0, index);
}

function parsePid(stdout: string | null | undefined): number {
  const tokens = String(stdout ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const pid = Number(tokens[tokens.length - 1]);
  return Number.isFinite(pid) && pid > 0 ? pid : 0;
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new E2BSandboxRuntimeError("Freestyle VM info read timed out", { code: "timeout", requestSent: true })),
      timeoutMs,
    );
  });
  // On the timeout branch the losing read stays in flight; swallow its eventual
  // rejection so it cannot surface as an unhandled rejection in the DO.
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validatePositiveMs(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw missingConfig(`${label} must be a positive number of milliseconds`);
}

function validateSandboxId(value: string): void {
  if (!value) throw missingConfig("Freestyle VM id is required");
}

function missingConfig(message: string): E2BSandboxRuntimeError {
  return new E2BSandboxRuntimeError(message, { code: "missing_config", requestSent: false });
}

// The SDK's typed vms.create() options omit memSizeGb/vcpuCount/rootfsSizeGb (absent
// from the package .d.ts) even though the runtime forwards them onto the wire nested
// under `template` (verified against the real SDK in freestyle-sdk-contract.test.ts).
// Augment the typed options with the sizing knobs so the create call is type-checked
// rather than cast to `any`.
type FreestyleVmCreateOptions = NonNullable<Parameters<Freestyle["vms"]["create"]>[0]> & {
  memSizeGb?: number;
  vcpuCount?: number;
  rootfsSizeGb?: number;
};

type FreestyleVmSizing = { memSizeGb?: number; vcpuCount?: number; rootfsSizeGb?: number };

/**
 * Map a resolved per-repo resource spec to Freestyle's create-time sizing knobs, or `{}`
 * when absent — an unspecced repo keeps the base snapshot's baked sizing (8 GiB / 4 vCPU /
 * 16 GB rootfs), so the create call stays byte-identical to the pre-sizing behavior. Fails
 * closed on values the firecracker backend rejects (memory and vCPU must be powers of two)
 * so a misconfigured spec surfaces as a decisive missing_config before the VM is created,
 * not as an opaque 400 that the spawn retry burns through.
 */
function freestyleVmSizing(resources: SandboxResourceSpec | undefined): FreestyleVmSizing {
  if (!resources) return {};
  const vcpuCount = assertPowerOfTwo(resources.cpuCount, "cpuCount");
  if (vcpuCount > 32) {
    throw missingConfig(`Freestyle VM sizing cpuCount must be a power of two <= 32 (got ${vcpuCount})`);
  }
  const memSizeGb = memoryMbToPowerOfTwoGib(resources.memoryMB);
  if (resources.diskGB === undefined) return { memSizeGb, vcpuCount };
  return { memSizeGb, vcpuCount, rootfsSizeGb: assertPositiveInteger(resources.diskGB, "diskGB") };
}

// Freestyle expresses memory in whole GiB and the firecracker backend requires it to be a
// power of two (CREATE_VM_MEM_NOT_POWER_OF_TWO). Repo specs carry MiB, so require a clean
// multiple of 1024 whose GiB value is a power of two: 4096->4, 8192->8, 16384->16,
// 32768->32. 24 GiB (24576 MiB) is deliberately NOT expressible. No upper bound here — the
// account/plan ceiling is enforced by the API (CREATE_VM_MEM_OUT_OF_RANGE).
function memoryMbToPowerOfTwoGib(memoryMB: number): number {
  assertPositiveInteger(memoryMB, "memoryMB");
  if (memoryMB % 1024 !== 0) {
    throw missingConfig(`Freestyle VM sizing memoryMB must be a whole number of GiB (got ${memoryMB} MiB)`);
  }
  return assertPowerOfTwo(memoryMB / 1024, "memSizeGb");
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw missingConfig(`Freestyle VM sizing ${label} must be a positive integer (got ${value})`);
  }
  return value;
}

function assertPowerOfTwo(value: number, label: string): number {
  assertPositiveInteger(value, label);
  // value is a positive integer here, so the bitwise trick is safe for the sizes we
  // handle (all well under 2^31).
  if ((value & (value - 1)) !== 0) {
    throw missingConfig(`Freestyle VM sizing ${label} must be a power of two (got ${value})`);
  }
  return value;
}

function normalizeFreestyleError(error: unknown, method: string): E2BSandboxRuntimeError {
  if (error instanceof E2BSandboxRuntimeError) return error;
  const status = readStatus(error);
  const message = readMessage(error);
  const code = classifyFreestyleError(error, status, message);
  return new E2BSandboxRuntimeError(message || "Freestyle sandbox runtime request failed", {
    code,
    status,
    requestSent: true,
    cause: error,
  });
}

// The SDK's canonical error codes (errorFromJSON in freestyle/index.mjs): instances
// carry `body.code` and a static `statusCode` on the constructor — there is NO
// instance-level `status`. Classification keys on body.code FIRST; the status and
// substring branches are fallbacks for non-SDK transport errors.
const FREESTYLE_MISSING_CODES = new Set([
  "NOT_FOUND",
  "VM_DELETED",
  "VM_NOT_FOUND_IN_FS",
  "SNAPSHOT_NOT_FOUND",
  "SOURCE_SNAPSHOT_DELETED",
  "INVALID_VM_ID",
]);
const FREESTYLE_KILLED_CODES = new Set([
  "RESUMED_VM_NON_RESPONSIVE",
  "VM_EXIT_DURING_START",
  "KERNEL_PANIC",
  "CORRUPT_VM_RECORD",
  // ARC-1481: suspend() fell back to STOPPING the VM, dropping its memory. The VM is
  // dead, not paused — classify killed so the pause caller respawns instead of leaving
  // the row `running` over a stopped VM. Its sibling SUSPEND_FAILED_AND_STOP_FAILED is
  // deliberately NOT here: there both ops failed and the VM may still be running, so it
  // falls to `unknown` (leave running for retry) rather than a premature kill that would
  // orphan a live, billing VM.
  "SUSPEND_FAILED_AND_STOPPED",
]);
const FREESTYLE_AUTH_CODES = new Set([
  "VM_ACCESS_DENIED",
  "NOT_VM_OWNER",
  "FORBIDDEN",
  "MISSING_ACCOUNT_ID",
  "BAD_KEY",
]);
const FREESTYLE_TIMEOUT_CODES = new Set(["VM_START_TIMEOUT", "EXEC_TIMED_OUT", "SNAPSHOT_LOAD_TIMEOUT"]);
// VM/host states that clear on their own shortly (SDK static descriptions quoted).
// Without this bucket these fell to `unknown`, and a resume that raced a suspend
// hard-failed the prompt instead of waiting out the window (ARC-1479).
const FREESTYLE_NOT_READY_CODES = new Set([
  "VM_IS_SUSPENDING", // 409 "VM is currently being suspended"
  "STILL_CREATING", // 409 "VM {vm_id} is still being created"
  "VM_REACTIVATED", // 409 "VM {vm_id} was reactivated by concurrent use before it could be suspended"
  "SUSPEND_FAILED_VM_RESUMED", // 500 "Suspend failed but VM was resumed and is still running (safe to retry)"
  "VM_NOT_RUNNING", // 400 op raced a VM that is not (yet) running
  "NO_LOCAL_STORAGE_CAPACITY", // 503 "No local storage partition has capacity for VM creation"
  "INSUFFICIENT_SWAP", // 503 host swap headroom exhausted; transient capacity
]);
// Deterministic create-sizing rejects: the identical request fails identically on every
// attempt, so classify as the decisive, non-spawn-retryable missing_config (matching the
// local power-of-two guards) instead of falling through to the retryable `unknown`, which
// would burn the spawn retry loop on a misconfigured spec. The …OUT_OF_RANGE account/plan
// ceilings are enforced only by the API, so this is the fail-closed backstop for the
// bounds freestyleVmSizing cannot check locally (e.g. rootfs range).
const FREESTYLE_SIZING_REJECT_CODES = new Set([
  "CREATE_VM_MEM_NOT_POWER_OF_TWO",
  "CREATE_VM_VCPU_NOT_POWER_OF_TWO",
  "CREATE_VM_MEM_OUT_OF_RANGE",
  "CREATE_VM_VCPU_OUT_OF_RANGE",
  "CREATE_VM_ROOTFS_OUT_OF_RANGE",
]);

function classifyFreestyleError(
  error: unknown,
  status: number | undefined,
  message: string,
): E2BSandboxRuntimeErrorCode {
  const bodyCode = readBodyCode(error);
  if (bodyCode) {
    if (FREESTYLE_MISSING_CODES.has(bodyCode)) return "missing_sandbox";
    if (FREESTYLE_KILLED_CODES.has(bodyCode)) return "killed";
    if (FREESTYLE_AUTH_CODES.has(bodyCode)) return "auth";
    if (FREESTYLE_TIMEOUT_CODES.has(bodyCode)) return "timeout";
    if (FREESTYLE_NOT_READY_CODES.has(bodyCode)) return "not_ready";
    if (FREESTYLE_SIZING_REJECT_CODES.has(bodyCode)) return "missing_config";
  }
  const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  const text = `${name} ${message}`.toLowerCase();
  if (
    status === 401 ||
    status === 403 ||
    text.includes("authentication") ||
    text.includes("unauthorized") ||
    text.includes("forbidden")
  ) {
    return "auth";
  }
  if (status === 402 || text.includes("quota") || text.includes("credit")) return "quota";
  if (status === 429 || text.includes("rate limit")) return "rate_limit";
  if (
    status === 404 ||
    status === 410 ||
    text.includes("not found") ||
    text.includes("notfound") ||
    text.includes("no such vm") ||
    text.includes("deleted")
  ) {
    return "missing_sandbox";
  }
  if (status === 408 || status === 504 || text.includes("timeout") || text.includes("timed out")) return "timeout";
  if (text.includes("killed") || text.includes("terminated") || text.includes("no longer exists")) return "killed";
  if (
    error instanceof TypeError ||
    text.includes("fetch failed") ||
    text.includes("econnreset") ||
    text.includes("enotfound") ||
    text.includes("network")
  ) {
    return "network";
  }
  return "unknown";
}

function readBodyCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const body = (error as Record<string, unknown>).body;
  if (typeof body !== "object" || body === null) return undefined;
  const code = (body as Record<string, unknown>).code;
  return typeof code === "string" && code ? code : undefined;
}

function readMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return "Freestyle sandbox runtime request failed";
}

function readStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const direct = readNumber(record.status) ?? readNumber(record.statusCode);
  if (direct !== undefined) return direct;
  const response = record.response;
  if (typeof response === "object" && response !== null) {
    const fromResponse = readNumber((response as Record<string, unknown>).status);
    if (fromResponse !== undefined) return fromResponse;
  }
  // SDK error classes carry statusCode as a STATIC property on the constructor
  // (e.g. VmDeletedError.statusCode = 410), never on the instance.
  const ctor = record.constructor as { statusCode?: unknown } | undefined;
  return readNumber(ctor?.statusCode);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
