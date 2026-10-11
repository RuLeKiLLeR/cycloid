import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { beforeEach, describe, expect, it, vi } from "vitest";

const freestyleMock = vi.hoisted(() => {
  const vmExec = vi.fn();
  const vmStart = vi.fn();
  const vmGetInfo = vi.fn();
  const vmSuspend = vi.fn();
  const vmWriteTextFile = vi.fn();
  const vmWriteFile = vi.fn();
  const vm = {
    exec: vmExec,
    start: vmStart,
    getInfo: vmGetInfo,
    suspend: vmSuspend,
    fs: { writeTextFile: vmWriteTextFile, writeFile: vmWriteFile },
  };
  const vmsCreate = vi.fn();
  const vmsList = vi.fn();
  const vmsDelete = vi.fn();
  const vmsRef = vi.fn(() => vm);
  const FreestyleCtor = vi.fn(function (this: { vms: unknown }) {
    this.vms = { create: vmsCreate, list: vmsList, delete: vmsDelete, ref: vmsRef };
  });
  return {
    vm,
    vmExec,
    vmStart,
    vmGetInfo,
    vmSuspend,
    vmWriteTextFile,
    vmWriteFile,
    vmsCreate,
    vmsList,
    vmsDelete,
    vmsRef,
    FreestyleCtor,
  };
});

vi.mock("freestyle", () => ({
  Freestyle: freestyleMock.FreestyleCtor,
}));

import { SPAWN_CONNECT_TIMEOUT_MS } from "../../apps/control-plane-worker/src/constants/sessions";
import {
  E2BSandboxClient,
  E2BSandboxRuntimeError,
  RETRYABLE_SANDBOX_SPAWN_ERROR_CODES,
} from "../../apps/control-plane-worker/src/sandbox/e2b-client";
import {
  buildBridgeVerifyCommand,
  buildDetachedStartCommand,
  buildRunCommand,
  buildSessionEnvScript,
  buildVmName,
  FreestyleSandboxClient,
  parseBridgeBundlePointer,
} from "../../apps/control-plane-worker/src/sandbox/freestyle-client";
import { createSandboxProviderClient } from "../../apps/control-plane-worker/src/sandbox/provider-client";
import {
  E2B_CLOUD_RUNTIME_BACKEND,
  FREESTYLE_RUNTIME_BACKEND,
} from "../../apps/control-plane-worker/src/sandbox/runtime-backend";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
}

function newClient(overrides: Record<string, unknown> = {}) {
  return new FreestyleSandboxClient({ apiKey: "test-key", logger: createLogger(), ...overrides });
}

// Faithful reproduction of the SDK's thrown error shape (freestyle/index.mjs
// errorFromJSON): message is "CODE: ...", `body.code` lives on the instance, and
// `statusCode` is a STATIC on the class — there is no instance status/statusCode.
function makeSdkError(name: string, code: string, statusCode: number): Error {
  const ErrorClass = class extends Error {
    body: { code: string; message: string };
    static code: string;
    static statusCode: number;
    constructor() {
      super(`${code}: synthetic ${code} from test`);
      this.name = name;
      this.body = { code, message: `synthetic ${code} from test` };
    }
  };
  ErrorClass.code = code;
  ErrorClass.statusCode = statusCode;
  return new ErrorClass();
}

describe("FreestyleSandboxClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Sane defaults so happy-path calls resolve.
    freestyleMock.vmsCreate.mockResolvedValue({ vm: freestyleMock.vm, vmId: "vm-123", domains: [] });
    freestyleMock.vmExec.mockResolvedValue({ stdout: "4242\n", stderr: "", statusCode: 0 });
    freestyleMock.vmStart.mockResolvedValue(undefined);
    freestyleMock.vmSuspend.mockResolvedValue({
      id: "vm-123",
      vmInstanceId: "vm-123-inst",
      snapshotLayerId: "df-layer",
    });
    freestyleMock.vmWriteTextFile.mockResolvedValue(undefined);
    freestyleMock.vmWriteFile.mockResolvedValue(undefined);
    freestyleMock.vmsDelete.mockResolvedValue(undefined);
    freestyleMock.vmsList.mockResolvedValue({ vms: [] });
  });

  describe("createSandbox", () => {
    it("creates a VM from the configured snapshot, ignoring the E2B template id", async () => {
      const client = newClient({ defaultSnapshotId: "snap-abc", idleTimeoutSeconds: 1200 });

      const result = await client.createSandbox({
        sessionId: "sess-1",
        sandboxId: "sandbox-1",
        template: "cycloid-e2b-template-xyz",
        timeoutMs: 60_000,
        envs: { SESSION_ID: "sess-1" },
        metadata: { source: "test" },
      });

      expect(freestyleMock.vmsCreate).toHaveBeenCalledWith({
        snapshotId: "snap-abc",
        name: "cycloid-sess-1",
        idleTimeoutSeconds: 1200,
        // ARC-1482: idle/retention knobs pinned at create instead of inheriting the
        // account default. 64 KiB sits above the bridge heartbeat and below agent
        // egress; sticky priority 10 retains a suspended VM across the 72h pause promise.
        activityThresholdBytes: 65_536,
        persistence: { type: "sticky", priority: 10 },
      });
      expect(result).toMatchObject({
        runtimeProvider: "freestyle",
        runtimeSandboxId: "vm-123",
        runtimeTemplateId: "snap-abc",
        status: "running",
      });
      expect(typeof result.createDurationMs).toBe("number");
      expect(result.createDurationMs).toBeGreaterThanOrEqual(0);
    });

    it("boots the per-repo prebaked snapshot when the request carries one, not the default", async () => {
      const client = newClient({ defaultSnapshotId: "snap-base" });

      const result = await client.createSandbox({
        sessionId: "sess-1",
        sandboxId: "sandbox-1",
        template: "cycloid-e2b-template-xyz",
        freestyleSnapshotId: " snap-repo-prebaked ",
        timeoutMs: 60_000,
        envs: {},
        metadata: {},
      });

      expect(freestyleMock.vmsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ snapshotId: "snap-repo-prebaked" }),
      );
      expect(result.runtimeTemplateId).toBe("snap-repo-prebaked");
    });

    it("falls back to the base snapshot when the request's per-repo snapshot is blank", async () => {
      const client = newClient({ defaultSnapshotId: "snap-base" });

      await client.createSandbox({
        sandboxId: "sandbox-1",
        template: "",
        freestyleSnapshotId: "   ",
        timeoutMs: 60_000,
        envs: {},
        metadata: {},
      });

      expect(freestyleMock.vmsCreate).toHaveBeenCalledWith(expect.objectContaining({ snapshotId: "snap-base" }));
    });

    it("still fails closed when a blank per-repo snapshot is present and no default is configured", async () => {
      const client = newClient();

      await expect(
        client.createSandbox({
          sandboxId: "sandbox-1",
          template: "",
          freestyleSnapshotId: " ",
          timeoutMs: 60_000,
          envs: {},
          metadata: {},
        }),
      ).rejects.toMatchObject({ name: "E2BSandboxRuntimeError", code: "missing_config", requestSent: false });
      expect(freestyleMock.vmsCreate).not.toHaveBeenCalled();
    });

    it("pins persistence and the activity threshold so idle/retention do not ride account defaults (ARC-1482)", async () => {
      const client = newClient({ defaultSnapshotId: "snap-abc" });

      await client.createSandbox({ sandboxId: "sandbox-1", template: "", timeoutMs: 60_000, envs: {}, metadata: {} });

      const createArgs = freestyleMock.vmsCreate.mock.calls[0][0];
      // Retention: sticky (NOT persistent -- that is plan-gated and would fail closed on
      // create) at max priority so a suspended VM survives the 72h pause promise instead
      // of an ephemeral-default suspend dropping its files.
      expect(createArgs.persistence).toEqual({ type: "sticky", priority: 10 });
      // Idle floor: comfortably above the bridge's ~200-byte 30s heartbeat (so idle VMs
      // still suspend) and far below real agent egress (so active VMs stay awake).
      expect(createArgs.activityThresholdBytes).toBe(65_536);
      expect(createArgs.activityThresholdBytes).toBeGreaterThan(1_024);
    });

    it("fails closed with missing_config when no snapshot is configured (ARC-1480)", async () => {
      const client = newClient();

      // A snapshot-less create would cold-boot bare Debian with no bridge bundle —
      // an unstartable session. Must throw BEFORE vms.create, and requestSent must
      // stay false: no VM exists, and missing_config is not spawn-retryable.
      await expect(
        client.createSandbox({
          sandboxId: "sandbox-1",
          template: "cycloid-e2b-template-xyz",
          timeoutMs: 60_000,
          envs: {},
          metadata: {},
        }),
      ).rejects.toMatchObject({
        name: "E2BSandboxRuntimeError",
        code: "missing_config",
        requestSent: false,
        // Pin the message so this test keeps exercising the snapshot guard, not the
        // apiKey check that shares the missing_config code and runs first.
        message: expect.stringContaining("FREESTYLE_DEFAULT_SNAPSHOT_ID"),
      });
      expect(freestyleMock.vmsCreate).not.toHaveBeenCalled();
    });

    it("defaults idleTimeoutSeconds above the prompt cap when unset (ARC-1476)", async () => {
      const client = newClient({ defaultSnapshotId: "snap-abc" });

      await client.createSandbox({
        sandboxId: "sandbox-1",
        template: "",
        timeoutMs: 60_000,
        envs: {},
        metadata: {},
      });

      // Must exceed PROMPT_MAX_DURATION_MS (30 min = 1800s) with margin so a single
      // max-length prompt cannot network-idle self-suspend mid-run.
      expect(freestyleMock.vmsCreate).toHaveBeenCalledWith(expect.objectContaining({ idleTimeoutSeconds: 2400 }));
    });

    it("normalizes a transport failure into a retryable network error", async () => {
      freestyleMock.vmsCreate.mockRejectedValueOnce(new TypeError("fetch failed"));
      const client = newClient({ defaultSnapshotId: "snap-abc" });

      await expect(
        client.createSandbox({ sandboxId: "sandbox-1", template: "", timeoutMs: 60_000, envs: {}, metadata: {} }),
      ).rejects.toMatchObject({ code: "network", requestSent: true });
    });

    it("forwards per-repo sizing to vms.create (32 GiB / 4 vCPU / 32 GB rootfs)", async () => {
      const client = newClient({ defaultSnapshotId: "snap-abc", idleTimeoutSeconds: 1200 });

      await client.createSandbox({
        sessionId: "sess-1",
        sandboxId: "sandbox-1",
        template: "cycloid-e2b-template-xyz",
        timeoutMs: 60_000,
        envs: {},
        metadata: {},
        resources: { cpuCount: 4, memoryMB: 32768, diskGB: 32 },
      });

      // Sizing rides ALONGSIDE snapshotId; the SDK runtime nests them under `template` on
      // the wire (pinned by freestyle-sdk-contract.test.ts). Memory maps MiB -> GiB.
      // objectContaining, not an exact match: other create knobs (persistence,
      // activityThresholdBytes) coexist on the same call and are pinned by their own tests.
      expect(freestyleMock.vmsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshotId: "snap-abc",
          name: "cycloid-sess-1",
          idleTimeoutSeconds: 1200,
          memSizeGb: 32,
          vcpuCount: 4,
          rootfsSizeGb: 32,
        }),
      );
    });

    it("maps memory + cpu but omits rootfsSizeGb when the spec has no disk dimension", async () => {
      const client = newClient({ defaultSnapshotId: "snap-abc" });

      await client.createSandbox({
        sandboxId: "sandbox-1",
        template: "",
        timeoutMs: 60_000,
        envs: {},
        metadata: {},
        resources: { cpuCount: 4, memoryMB: 8192 },
      });

      const call = freestyleMock.vmsCreate.mock.calls[0]![0] as Record<string, unknown>;
      expect(call).toMatchObject({ memSizeGb: 8, vcpuCount: 4 });
      // No disk dimension -> the snapshot's rootfs is preserved (no rootfsSizeGb sent).
      expect(call).not.toHaveProperty("rootfsSizeGb");
    });

    it("omits every sizing knob when no resources are provided (base snapshot sizing preserved)", async () => {
      const client = newClient({ defaultSnapshotId: "snap-abc" });

      await client.createSandbox({
        sandboxId: "sandbox-1",
        template: "",
        timeoutMs: 60_000,
        envs: {},
        metadata: {},
      });

      const call = freestyleMock.vmsCreate.mock.calls[0]![0] as Record<string, unknown>;
      expect(call).not.toHaveProperty("memSizeGb");
      expect(call).not.toHaveProperty("vcpuCount");
      expect(call).not.toHaveProperty("rootfsSizeGb");
    });

    it("fails closed (missing_config) when memory is not a power of two — 24 GiB is not expressible", async () => {
      const client = newClient({ defaultSnapshotId: "snap-abc" });

      // 24576 MiB = 24 GiB; the firecracker backend requires a power-of-two GiB, so
      // catch it as a decisive missing_config BEFORE the VM is created rather than let
      // the spawn retry burn through an opaque 400.
      await expect(
        client.createSandbox({
          sandboxId: "sandbox-1",
          template: "",
          timeoutMs: 60_000,
          envs: {},
          metadata: {},
          resources: { cpuCount: 4, memoryMB: 24576 },
        }),
      ).rejects.toMatchObject({ name: "E2BSandboxRuntimeError", code: "missing_config", requestSent: false });
      expect(freestyleMock.vmsCreate).not.toHaveBeenCalled();
    });

    it("fails closed when cpuCount is not a power of two", async () => {
      const client = newClient({ defaultSnapshotId: "snap-abc" });

      await expect(
        client.createSandbox({
          sandboxId: "sandbox-1",
          template: "",
          timeoutMs: 60_000,
          envs: {},
          metadata: {},
          resources: { cpuCount: 3, memoryMB: 8192 },
        }),
      ).rejects.toMatchObject({ code: "missing_config", requestSent: false });
      expect(freestyleMock.vmsCreate).not.toHaveBeenCalled();
    });

    it("fails closed when cpuCount exceeds the 32-vCPU cap even as a power of two", async () => {
      const client = newClient({ defaultSnapshotId: "snap-abc" });

      await expect(
        client.createSandbox({
          sandboxId: "sandbox-1",
          template: "",
          timeoutMs: 60_000,
          envs: {},
          metadata: {},
          resources: { cpuCount: 64, memoryMB: 8192 },
        }),
      ).rejects.toMatchObject({ code: "missing_config", requestSent: false });
      expect(freestyleMock.vmsCreate).not.toHaveBeenCalled();
    });

    it("fails closed when memoryMB is not a whole number of GiB", async () => {
      const client = newClient({ defaultSnapshotId: "snap-abc" });

      // 5000 MiB passes the positive-integer check but is not a 1024 multiple, so it
      // must hit the GiB-multiple guard before the power-of-two check ever runs.
      await expect(
        client.createSandbox({
          sandboxId: "sandbox-1",
          template: "",
          timeoutMs: 60_000,
          envs: {},
          metadata: {},
          resources: { cpuCount: 4, memoryMB: 5000 },
        }),
      ).rejects.toMatchObject({ code: "missing_config", requestSent: false });
      expect(freestyleMock.vmsCreate).not.toHaveBeenCalled();
    });

    it("classifies API sizing rejects (e.g. rootfs out of range) as decisive missing_config, not retryable", async () => {
      const client = newClient({ defaultSnapshotId: "snap-abc" });

      // The rootfs range is enforced only by the API (no local bound), so the create is
      // attempted; the deterministic 400 must classify as missing_config — never the
      // retryable `unknown` that would burn the spawn retry loop on a misconfigured spec.
      freestyleMock.vmsCreate.mockRejectedValueOnce(
        makeSdkError("CreateVmRootfsOutOfRangeError", "CREATE_VM_ROOTFS_OUT_OF_RANGE", 400),
      );
      await expect(
        client.createSandbox({
          sandboxId: "sandbox-1",
          template: "",
          timeoutMs: 60_000,
          envs: {},
          metadata: {},
          resources: { cpuCount: 4, memoryMB: 8192, diskGB: 100_000 },
        }),
      ).rejects.toMatchObject({ code: "missing_config", requestSent: true });
      expect(freestyleMock.vmsCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe("connectSandbox", () => {
    it("wakes a suspended VM and returns a connected handle", async () => {
      const client = newClient({ idleTimeoutSeconds: 1500 });

      const connected = await client.connectSandbox("vm-123", 120_000);

      expect(freestyleMock.vmsRef).toHaveBeenCalledWith({ vmId: "vm-123" });
      // Resume re-arms the idle timer AND re-pins the activity threshold (ARC-1482):
      // both are per-start parameters, so omitting the threshold on wake reverts it.
      expect(freestyleMock.vmStart).toHaveBeenCalledWith({
        idleTimeoutSeconds: 1500,
        activityThresholdBytes: 65_536,
      });
      expect(connected.runtimeSandboxId).toBe("vm-123");
    });

    it("re-arms the default idle timeout on resume so a woken VM does not revert to the account default (ARC-1476)", async () => {
      const client = newClient();

      await client.connectSandbox("vm-123", 120_000);

      // The wake MUST pass the configured idle timeout; otherwise the resumed VM would
      // adopt the Freestyle account default and could self-suspend under the prompt cap.
      expect(freestyleMock.vmStart).toHaveBeenCalledWith({
        idleTimeoutSeconds: 2400,
        activityThresholdBytes: 65_536,
      });
    });

    it("classifies a real SDK VmDeletedError as missing_sandbox", async () => {
      // Mirror the real SDK error shape (freestyle/index.mjs errorFromJSON): body.code
      // on the instance, statusCode STATIC on the class, no instance status field.
      freestyleMock.vmStart.mockRejectedValueOnce(makeSdkError("VmDeletedError", "VM_DELETED", 410));
      const client = newClient();

      await expect(client.connectSandbox("vm-gone", 120_000)).rejects.toMatchObject({
        code: "missing_sandbox",
        status: 410,
        requestSent: true,
      });
    });

    it("classifies a real SDK RESUMED_VM_NON_RESPONSIVE as killed", async () => {
      freestyleMock.vmStart.mockRejectedValueOnce(
        makeSdkError("ResumedVmNonResponsiveError", "RESUMED_VM_NON_RESPONSIVE", 500),
      );
      const client = newClient();

      await expect(client.connectSandbox("vm-hung", 120_000)).rejects.toMatchObject({
        code: "killed",
        requestSent: true,
      });
    });

    it("does not retry a terminal error in place", async () => {
      freestyleMock.vmStart.mockRejectedValueOnce(makeSdkError("VmDeletedError", "VM_DELETED", 410));
      const client = newClient();

      await expect(client.connectSandbox("vm-gone", 120_000)).rejects.toMatchObject({ code: "missing_sandbox" });
      expect(freestyleMock.vmStart).toHaveBeenCalledTimes(1);
    });

    // ARC-1479 regression: resume racing a suspend. start() throws VM_IS_SUSPENDING
    // until the suspend completes; connect must wait it out in place instead of
    // rethrowing into the capped, immediate prompt-level spawn retry.
    it("waits out a suspending VM and connects once the suspend completes", async () => {
      vi.useFakeTimers();
      try {
        freestyleMock.vmStart
          .mockRejectedValueOnce(makeSdkError("VmIsSuspendingError", "VM_IS_SUSPENDING", 409))
          .mockRejectedValueOnce(makeSdkError("VmIsSuspendingError", "VM_IS_SUSPENDING", 409));
        const client = newClient();

        const connectPromise = client.connectSandbox("vm-123", 120_000);
        await vi.advanceTimersByTimeAsync(0);
        expect(freestyleMock.vmStart).toHaveBeenCalledTimes(1);
        // 1ms short of the first 500ms backoff the retry must NOT have fired — an
        // instant-hammer regression (dropped sleep) gives the suspend zero time
        // to complete and fails exactly here.
        await vi.advanceTimersByTimeAsync(499);
        expect(freestyleMock.vmStart).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(freestyleMock.vmStart).toHaveBeenCalledTimes(2);
        // Second backoff is 1s; crossing it lets the third attempt succeed.
        await vi.advanceTimersByTimeAsync(1_000);

        const connected = await connectPromise;
        expect(connected.runtimeSandboxId).toBe("vm-123");
        expect(freestyleMock.vmStart).toHaveBeenCalledTimes(3);
        // Every attempt — including the winning one — must re-arm the idle
        // timeout (ARC-1476): dropping it inside the retry loop would let a
        // suspend-race resume adopt the account default and self-suspend.
        for (const call of freestyleMock.vmStart.mock.calls) {
          expect(call[0]).toEqual({ idleTimeoutSeconds: 2400, activityThresholdBytes: 65_536 });
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops retrying when the suspend resolves into a gone VM", async () => {
      vi.useFakeTimers();
      try {
        freestyleMock.vmStart
          .mockRejectedValueOnce(makeSdkError("VmIsSuspendingError", "VM_IS_SUSPENDING", 409))
          .mockRejectedValueOnce(makeSdkError("VmDeletedError", "VM_DELETED", 410));
        const client = newClient();

        const connectPromise = client.connectSandbox("vm-gone", 120_000);
        const assertion = expect(connectPromise).rejects.toMatchObject({
          code: "missing_sandbox",
          status: 410,
        });
        await vi.advanceTimersByTimeAsync(500);

        await assertion;
        // The terminal error must break out mid-retry — one not_ready attempt,
        // then the VM_DELETED rethrows without burning the remaining budget.
        expect(freestyleMock.vmStart).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("surfaces a retryable not_ready error once the in-place budget is exhausted", async () => {
      vi.useFakeTimers();
      try {
        freestyleMock.vmStart.mockRejectedValue(makeSdkError("VmIsSuspendingError", "VM_IS_SUSPENDING", 409));
        const logger = createLogger();
        const client = newClient({ logger });

        const connectPromise = client.connectSandbox("vm-stuck", 120_000);
        const assertion = expect(connectPromise).rejects.toMatchObject({
          code: "not_ready",
          status: 409,
          requestSent: true,
        });
        // Partway through the budget (0.5+1+2+4s elapsed) exactly five attempts
        // have fired and the connect is still pacing itself, not hammering.
        await vi.advanceTimersByTimeAsync(7_500);
        expect(freestyleMock.vmStart).toHaveBeenCalledTimes(5);
        // The remaining 8+10+12+12+12s exhausts the budget; the attempt after the
        // last delay rethrows.
        await vi.advanceTimersByTimeAsync(54_000);

        await assertion;
        // One initial attempt + one per backoff delay.
        expect(freestyleMock.vmStart).toHaveBeenCalledTimes(10);
        const retryDelays = logger.info.mock.calls.map(([fields]) => (fields as { delayMs: number }).delayMs);
        expect(retryDelays).toEqual([500, 1_000, 2_000, 4_000, 8_000, 10_000, 12_000, 12_000, 12_000]);
        const retrySleepBudgetMs = retryDelays.reduce((sum, delayMs) => sum + delayMs, 0);
        expect(retrySleepBudgetMs).toBeGreaterThanOrEqual(54_000);
        expect(retrySleepBudgetMs).toBeLessThanOrEqual(66_000);
        expect(retrySleepBudgetMs).toBeLessThan(SPAWN_CONNECT_TIMEOUT_MS);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("refreshSandbox / pauseSandbox", () => {
    it("refreshSandbox is a synthetic no-op that never touches the SDK", async () => {
      const client = newClient();

      const result = await client.refreshSandbox("vm-123", 60_000);

      expect(result.status).toBe("refreshed");
      expect(typeof result.refreshedUntil).toBe("number");
      expect(freestyleMock.vmsRef).not.toHaveBeenCalled();
      expect(freestyleMock.FreestyleCtor).not.toHaveBeenCalled();
    });

    it("pauseSandbox parks the VM via the memory-preserving suspend and returns paused (ARC-1481)", async () => {
      const client = newClient();

      await expect(client.pauseSandbox("vm-123")).resolves.toEqual({ status: "paused" });
      // Real suspend (POST /v1/vms/{vm_id}/suspend), not the old no-op: the VM must
      // actually park so it stops billing instead of running until its idle timer.
      expect(freestyleMock.vmsRef).toHaveBeenCalledWith({ vmId: "vm-123" });
      expect(freestyleMock.vmSuspend).toHaveBeenCalledTimes(1);
      // Never stop()/snapshot(): those drop memory or mint a new vmId.
      expect(freestyleMock.vmStart).not.toHaveBeenCalled();
    });

    it("pauseSandbox fails closed with missing_config (no suspend) when the SDK drops Vm.suspend()", async () => {
      // suspend() is cast from vms.ref(...) because it is absent from the SDK .d.ts. If an
      // upgrade removes it, the guard must surface a decisive, non-retryable missing_config
      // instead of a TypeError that classifies as retryable `network` (mirrors getInfo).
      freestyleMock.vmsRef.mockReturnValueOnce({} as never);
      const client = newClient();

      await expect(client.pauseSandbox("vm-123")).rejects.toMatchObject({
        code: "missing_config",
        requestSent: false,
      });
      expect(freestyleMock.vmSuspend).not.toHaveBeenCalled();
    });

    it("pauseSandbox converges to paused when suspend() hits VM_IS_SUSPENDING and the probe confirms it parked (ARC-1481)", async () => {
      // A racing/idle-timer suspend makes suspend() throw VM_IS_SUSPENDING (not_ready). For
      // PAUSE that means "already parked", not "retry the start" — probe the real state and
      // converge to paused so the caller's row does not wedge `running` over a suspended VM
      // (which the cleanup sweep, terminating only `paused` rows, would then churn on forever).
      freestyleMock.vmSuspend.mockRejectedValueOnce(makeSdkError("VmIsSuspendingError", "VM_IS_SUSPENDING", 409));
      freestyleMock.vmGetInfo.mockResolvedValueOnce({ id: "vm-123", state: "suspended" });
      const client = newClient();

      await expect(client.pauseSandbox("vm-123")).resolves.toEqual({ status: "paused" });
      expect(freestyleMock.vmGetInfo).toHaveBeenCalledTimes(1);
    });

    it("pauseSandbox converges to paused when suspend() hits VM_NOT_RUNNING and the probe finds it suspended", async () => {
      freestyleMock.vmSuspend.mockRejectedValueOnce(makeSdkError("VmNotRunningError", "VM_NOT_RUNNING", 400));
      freestyleMock.vmGetInfo.mockResolvedValueOnce({ id: "vm-123", state: "suspending" });
      const client = newClient();

      await expect(client.pauseSandbox("vm-123")).resolves.toEqual({ status: "paused" });
    });

    it("pauseSandbox reports missing_sandbox when suspend is rejected and the probe finds the VM stopped/gone", async () => {
      // VM_NOT_RUNNING is ambiguous — suspended OR stopped (memory gone). The probe
      // disambiguates: a stopped VM must respawn, not be projected as paused.
      freestyleMock.vmSuspend.mockRejectedValueOnce(makeSdkError("VmNotRunningError", "VM_NOT_RUNNING", 400));
      freestyleMock.vmGetInfo.mockResolvedValueOnce({ id: "vm-123", state: "stopped" });
      const client = newClient();

      await expect(client.pauseSandbox("vm-123")).rejects.toMatchObject({
        code: "missing_sandbox",
        requestSent: true,
      });
    });

    it("pauseSandbox keeps retryable not_ready when suspend is rejected and the probe finds the VM still running (VM_REACTIVATED)", async () => {
      // Concurrent use woke the VM: it is legitimately running, so pause must not succeed-lie.
      // The retryable not_ready leaves the caller's row running for the next sweep.
      freestyleMock.vmSuspend.mockRejectedValueOnce(makeSdkError("VmReactivatedError", "VM_REACTIVATED", 409));
      freestyleMock.vmGetInfo.mockResolvedValueOnce({ id: "vm-123", state: "running" });
      const client = newClient();

      await expect(client.pauseSandbox("vm-123")).rejects.toMatchObject({
        code: "not_ready",
        status: 409,
        requestSent: true,
      });
    });

    it("pauseSandbox classifies SUSPEND_FAILED_VM_RESUMED as not_ready like its VM_REACTIVATED twin (not unknown)", async () => {
      // 500 "Suspend failed but VM was resumed and is still running (safe to retry)". Left
      // unclassified it fell to `unknown`, polluting the unknown-error signal reserved for
      // genuinely unexplained failures.
      freestyleMock.vmSuspend.mockRejectedValueOnce(
        makeSdkError("SuspendFailedVmResumedError", "SUSPEND_FAILED_VM_RESUMED", 500),
      );
      freestyleMock.vmGetInfo.mockResolvedValueOnce({ id: "vm-123", state: "running" });
      const client = newClient();

      await expect(client.pauseSandbox("vm-123")).rejects.toMatchObject({
        code: "not_ready",
        status: 500,
        requestSent: true,
      });
    });

    it.each([["building"], ["hibernating"]] as const)(
      "pauseSandbox does NOT trust the watchdog live-bias: an unrecognized probe state (%s) keeps not_ready, not paused",
      async (state) => {
        // getSandboxInfo maps an unrecognized-but-alive state to `paused` so the disconnect
        // watchdog never fail-closes on a live VM (ARC-1478). Pause must NOT read that bias as
        // proof of suspension — a `building`/`hibernating` VM is still running/billing, so
        // treating it as parked (persist paused + close sockets) would re-open ARC-1481.
        freestyleMock.vmSuspend.mockRejectedValueOnce(makeSdkError("VmNotRunningError", "VM_NOT_RUNNING", 400));
        freestyleMock.vmGetInfo.mockResolvedValueOnce({ id: "vm-123", state });
        const client = newClient();

        await expect(client.pauseSandbox("vm-123")).rejects.toMatchObject({ code: "not_ready", requestSent: true });
      },
    );

    it("pauseSandbox keeps not_ready when the state probe omits `state` (cannot confirm parked)", async () => {
      freestyleMock.vmSuspend.mockRejectedValueOnce(makeSdkError("VmNotRunningError", "VM_NOT_RUNNING", 400));
      freestyleMock.vmGetInfo.mockResolvedValueOnce({ id: "vm-123" });
      const client = newClient();

      await expect(client.pauseSandbox("vm-123")).rejects.toMatchObject({ code: "not_ready", requestSent: true });
    });

    it("pauseSandbox reports missing_sandbox when the state probe itself reads VM_DELETED", async () => {
      freestyleMock.vmSuspend.mockRejectedValueOnce(makeSdkError("VmNotRunningError", "VM_NOT_RUNNING", 400));
      freestyleMock.vmGetInfo.mockRejectedValueOnce(makeSdkError("VmDeletedError", "VM_DELETED", 410));
      const client = newClient();

      await expect(client.pauseSandbox("vm-123")).rejects.toMatchObject({
        code: "missing_sandbox",
        requestSent: true,
      });
    });

    it("pauseSandbox keeps not_ready when the state probe fails transiently (inconclusive, retry next sweep)", async () => {
      freestyleMock.vmSuspend.mockRejectedValueOnce(makeSdkError("VmNotRunningError", "VM_NOT_RUNNING", 400));
      freestyleMock.vmGetInfo.mockRejectedValueOnce(new TypeError("fetch failed"));
      const client = newClient();

      await expect(client.pauseSandbox("vm-123")).rejects.toMatchObject({ code: "not_ready", requestSent: true });
    });

    it("pauseSandbox classifies a suspend that fell back to STOPPED as killed, not unknown (ARC-1481)", async () => {
      // SUSPEND_FAILED_AND_STOPPED means memory was dropped and the VM is stopped. The
      // caller must respawn (killed), not leave the row `running` over a dead VM.
      freestyleMock.vmSuspend.mockRejectedValueOnce(
        makeSdkError("SuspendFailedAndStoppedError", "SUSPEND_FAILED_AND_STOPPED", 500),
      );
      const client = newClient();

      await expect(client.pauseSandbox("vm-123")).rejects.toMatchObject({
        code: "killed",
        requestSent: true,
      });
    });

    it("pauseSandbox leaves SUSPEND_FAILED_AND_STOP_FAILED as unknown so a still-running VM is not prematurely killed", async () => {
      // Both suspend and the stop fallback failed: the VM may still be running/billing, so
      // classify unknown (leave running for retry) rather than killed (which would orphan it).
      freestyleMock.vmSuspend.mockRejectedValueOnce(
        makeSdkError("SuspendFailedAndStopFailedError", "SUSPEND_FAILED_AND_STOP_FAILED", 500),
      );
      const client = newClient();

      await expect(client.pauseSandbox("vm-123")).rejects.toMatchObject({
        code: "unknown",
        requestSent: true,
      });
    });

    it("pauseSandbox surfaces a VM_DELETED suspend as missing_sandbox so the caller marks it killed", async () => {
      freestyleMock.vmSuspend.mockRejectedValueOnce(makeSdkError("VmDeletedError", "VM_DELETED", 410));
      const client = newClient();

      await expect(client.pauseSandbox("vm-123")).rejects.toMatchObject({
        code: "missing_sandbox",
        requestSent: true,
      });
    });
  });

  describe("runCommand", () => {
    it("maps statusCode to exitCode and passes stdout/stderr through", async () => {
      freestyleMock.vmExec.mockResolvedValueOnce({ stdout: "out", stderr: "err", statusCode: 7 });
      const client = newClient();

      await expect(
        client.runCommand({ runtimeSandboxId: "vm-123", command: "npm test", timeoutMs: 30_000 }),
      ).resolves.toEqual({ exitCode: 7, stdout: "out", stderr: "err" });

      expect(freestyleMock.vmExec).toHaveBeenCalledWith({ command: "npm test", timeoutMs: 30_000 });
    });

    it("defaults a null/absent statusCode to exit code 0", async () => {
      freestyleMock.vmExec.mockResolvedValueOnce({ stdout: null, stderr: null, statusCode: null });
      const client = newClient();

      await expect(client.runCommand({ runtimeSandboxId: "vm-123", command: "true" })).resolves.toEqual({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });
    });

    it("normalizes a transport failure", async () => {
      freestyleMock.vmExec.mockRejectedValueOnce(new TypeError("fetch failed"));
      const client = newClient();

      await expect(client.runCommand({ runtimeSandboxId: "vm-123", command: "true" })).rejects.toMatchObject({
        code: "network",
        requestSent: true,
      });
    });
  });

  describe("transient VM-state classification (ARC-1479)", () => {
    // Real SDK shapes (class name, body.code, static statusCode). These states
    // clear on their own; classifying them `unknown` made a resume that raced a
    // suspend read as an unexplained failure instead of a retryable wait.
    const notReadyCases: Array<[string, string, number]> = [
      ["VmIsSuspendingError", "VM_IS_SUSPENDING", 409],
      ["StillCreatingError", "STILL_CREATING", 409],
      ["VmReactivatedError", "VM_REACTIVATED", 409],
      ["VmNotRunningError", "VM_NOT_RUNNING", 400],
      ["NoLocalStorageCapacityError", "NO_LOCAL_STORAGE_CAPACITY", 503],
      ["InsufficientSwapError", "INSUFFICIENT_SWAP", 503],
    ];

    for (const [name, code, statusCode] of notReadyCases) {
      it(`classifies a real SDK ${code} as not_ready`, async () => {
        freestyleMock.vmExec.mockRejectedValueOnce(makeSdkError(name, code, statusCode));
        const client = newClient();

        await expect(client.runCommand({ runtimeSandboxId: "vm-123", command: "true" })).rejects.toMatchObject({
          code: "not_ready",
          status: statusCode,
          requestSent: true,
        });
      });
    }

    it("keeps not_ready in the shared spawn-retry code set (resume must stay retryable)", () => {
      expect(RETRYABLE_SANDBOX_SPAWN_ERROR_CODES.has("not_ready")).toBe(true);
      // The pre-ARC-1479 members must never silently drop out either: both the
      // in-place create retry and isRetryableSpawnFailure key on this one set.
      for (const code of ["network", "timeout", "rate_limit", "unknown"]) {
        expect(RETRYABLE_SANDBOX_SPAWN_ERROR_CODES.has(code)).toBe(true);
      }
      expect(RETRYABLE_SANDBOX_SPAWN_ERROR_CODES.has("auth")).toBe(false);
      expect(RETRYABLE_SANDBOX_SPAWN_ERROR_CODES.has("missing_sandbox")).toBe(false);
    });
  });

  describe("startCommand", () => {
    it("writes the session env file, chmods it, and launches the bridge detached", async () => {
      const client = newClient();

      const result = await client.startCommand({
        runtimeSandboxId: "vm-123",
        command: "bash /app/start-bridge.sh",
        cwd: "/workspace",
        envs: { SESSION_ID: "sess-1", GITHUB_CLONE_TOKEN: "tok'en" },
      });

      // Env file written via the shared shellQuote: safe tokens stay bare (POSIX-
      // equivalent to quoting), values with shell-special chars are single-quoted
      // with embedded single quotes escaped.
      expect(freestyleMock.vmWriteTextFile).toHaveBeenCalledWith(
        "/etc/cycloid/session-env.sh",
        expect.stringContaining("export SESSION_ID=sess-1"),
      );
      const [, envScript] = freestyleMock.vmWriteTextFile.mock.calls[0];
      expect(envScript).toContain("export GITHUB_CLONE_TOKEN='tok'\\''en'");

      // chmod 600 was issued for the env file.
      expect(freestyleMock.vmExec).toHaveBeenCalledWith({ command: "chmod 600 /etc/cycloid/session-env.sh" });

      // The final exec is the detached launcher: setsid + sources the env file + execs
      // the bridge command, echoing $! so the pid can be parsed.
      const launchCall = freestyleMock.vmExec.mock.calls.find(
        ([arg]) => typeof arg?.command === "string" && arg.command.includes("setsid"),
      );
      expect(launchCall).toBeDefined();
      const launch = launchCall![0].command as string;
      expect(launch).toContain("nohup setsid");
      expect(launch).toContain(". /etc/cycloid/session-env.sh");
      expect(launch).toContain("exec bash /app/start-bridge.sh");
      // cwd `/workspace` is a safe token, so the shared shellQuote leaves it bare;
      // the outer bash -lc wrapper has no single quotes to re-escape, so the inner
      // shell ultimately sees `cd /workspace`.
      expect(launch).toContain("cd /workspace;");
      expect(launch).toContain("echo $!");

      expect(result).toMatchObject({ pid: 4242 });
      expect(typeof result.startedAt).toBe("number");
    });

    it("stamps E2B_SANDBOX_ID with the vmId so the bridge report resolves the resume health gate (ARC-1475)", async () => {
      const client = newClient();

      await client.startCommand({
        runtimeSandboxId: "vm-abc",
        command: "bash /app/start-bridge.sh",
        cwd: "/workspace",
        envs: { SESSION_ID: "sess-1" },
      });

      // The bridge's buildRuntimeReport reads E2B_SANDBOX_ID first; without this the
      // report falls back to the internal SANDBOX_ID and the resume bridge-health gate
      // (keyed on the persisted runtime_sandbox_id = vmId) never matches, so the woken
      // VM is terminated. The env file must export E2B_SANDBOX_ID = the vmId.
      const [, envScript] = freestyleMock.vmWriteTextFile.mock.calls[0];
      expect(envScript).toContain("export E2B_SANDBOX_ID=vm-abc");
      expect(envScript).toContain("export SESSION_ID=sess-1");
    });

    it("does not let the injected E2B_SANDBOX_ID clobber a caller-provided value", async () => {
      const client = newClient();

      await client.startCommand({
        runtimeSandboxId: "vm-abc",
        command: "bash /app/start-bridge.sh",
        envs: { E2B_SANDBOX_ID: "caller-wins" },
      });

      const [, envScript] = freestyleMock.vmWriteTextFile.mock.calls[0];
      expect(envScript).toContain("export E2B_SANDBOX_ID=caller-wins");
      expect(envScript).not.toContain("export E2B_SANDBOX_ID=vm-abc");
    });

    it("falls back to pid 0 when $! cannot be parsed from stdout", async () => {
      // mkdir + chmod resolve normally; the launcher returns empty stdout.
      freestyleMock.vmExec.mockResolvedValue({ stdout: "", stderr: "", statusCode: 0 });
      const client = newClient();

      const result = await client.startCommand({
        runtimeSandboxId: "vm-123",
        command: "bash /app/start-bridge.sh",
        envs: {},
      });

      expect(result.pid).toBe(0);
    });
  });

  // ARC-1512: inject the current bridge bundle from R2 at session start; fall back to the
  // baked bundle on any trouble without ever failing the spawn.
  describe("startCommand bridge-bundle injection (ARC-1512)", () => {
    const POINTER_KEY = "bridge/current.json";
    const RAW_BUNDLE = Buffer.from("console.log('fresh bridge bundle');");
    const GZ = gzipSync(RAW_BUNDLE);
    const SHA256 = createHash("sha256").update(RAW_BUNDLE).digest("hex");
    const BLOB_KEY = `bridge/${SHA256}.js.gz`;
    const POINTER = {
      sha256: SHA256,
      key: BLOB_KEY,
      bytes: RAW_BUNDLE.length,
      gzBytes: GZ.length,
      builtAt: "2026-07-08T00:00:00.000Z",
      gitSha: "deadbeef",
    };

    function r2TextBody(text: string) {
      return { text: async () => text } as unknown as R2ObjectBody;
    }
    function r2BlobBody(bytes: Uint8Array) {
      // A fresh exact-length ArrayBuffer so Buffer.from(arrayBuffer) sees only the payload
      // (a Node Buffer's own .buffer is the shared 64 KiB pool, not the exact slice).
      const exact = new Uint8Array(bytes.byteLength);
      exact.set(bytes);
      return { arrayBuffer: async () => exact.buffer } as unknown as R2ObjectBody;
    }
    function fakeBucket(objects: Record<string, R2ObjectBody | null>): R2Bucket {
      return { get: vi.fn(async (key: string) => objects[key] ?? null) } as unknown as R2Bucket;
    }
    function injectClient(bucket: R2Bucket | undefined, extra: Record<string, unknown> = {}) {
      const logger = createLogger();
      const client = new FreestyleSandboxClient({
        apiKey: "test-key",
        logger,
        ...(bucket ? { bridgeBundles: bucket } : {}),
        ...extra,
      });
      return { client, logger };
    }
    function writtenEnvScript(): string {
      return freestyleMock.vmWriteTextFile.mock.calls[0]![1] as string;
    }
    async function start(client: FreestyleSandboxClient) {
      return client.startCommand({
        runtimeSandboxId: "vm-123",
        command: "bash /app/start-bridge.sh",
        cwd: "/workspace",
        envs: { SESSION_ID: "sess-1" },
      });
    }

    it("quietly launches the baked bundle when no BRIDGE_BUNDLES binding is configured", async () => {
      const { client, logger } = injectClient(undefined);

      await start(client);

      const env = writtenEnvScript();
      expect(env).toContain("export ARCANIST_BRIDGE_BUNDLE_SOURCE=baked");
      expect(env).not.toContain("export BRIDGE_BUNDLE=");
      // Quiet: no VM binary write, debug-only, never a warning.
      expect(freestyleMock.vmWriteFile).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("falls back with pointer_missing when the bound bucket has no pointer object", async () => {
      const bucket = fakeBucket({ [POINTER_KEY]: null });
      const { client, logger } = injectClient(bucket);

      await start(client);

      const env = writtenEnvScript();
      expect(env).toContain("export ARCANIST_BRIDGE_BUNDLE_SOURCE=baked");
      expect(env).not.toContain("export BRIDGE_BUNDLE=");
      expect(freestyleMock.vmWriteFile).not.toHaveBeenCalled();
      // A bound bucket with no pointer is a publish miss: every session would silently
      // boot the baked bundle, so it must warn + metric rather than quietly skip.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "pointer_missing" }),
        expect.any(String),
      );
    });

    it("injects, verifies, and points BRIDGE_BUNDLE at the fresh bundle on success", async () => {
      const bucket = fakeBucket({ [POINTER_KEY]: r2TextBody(JSON.stringify(POINTER)), [BLOB_KEY]: r2BlobBody(GZ) });
      const { client } = injectClient(bucket);

      const result = await start(client);

      // The gz blob is written into the VM at the session-scoped path.
      expect(freestyleMock.vmWriteFile).toHaveBeenCalledTimes(1);
      const [writePath, writeBuf] = freestyleMock.vmWriteFile.mock.calls[0]!;
      expect(writePath).toBe("/tmp/cycloid-bridge-fresh.js.gz");
      expect(Buffer.isBuffer(writeBuf)).toBe(true);
      expect((writeBuf as Buffer).length).toBe(GZ.length);

      // The gunzip + sha256 verify command was execed with the pointer's sha.
      const verifyCall = freestyleMock.vmExec.mock.calls.find(
        ([arg]) => typeof arg?.command === "string" && arg.command.includes("sha256sum -c"),
      );
      expect(verifyCall).toBeDefined();
      expect(verifyCall![0].command).toContain(SHA256);
      expect(verifyCall![0].command).toContain(
        "gunzip -c /tmp/cycloid-bridge-fresh.js.gz > /app/bridge/bundle.fresh.js",
      );

      // The session env carries the fresh-bundle override + provenance (PR 3 contract).
      const env = writtenEnvScript();
      // Fresh bundle must live in /app/bridge so its externalized deps (sharp, agent SDKs)
      // resolve from /app/bridge/node_modules; the baked bundle.js stays untouched.
      expect(env).toContain("export BRIDGE_BUNDLE=/app/bridge/bundle.fresh.js");
      expect(env).toContain(`export ARCANIST_BRIDGE_BUNDLE_SHA256=${SHA256}`);
      expect(env).toContain("export ARCANIST_BRIDGE_BUNDLE_SOURCE=injected");
      expect(env).not.toContain("export ARCANIST_BRIDGE_BUNDLE_SOURCE=baked");
      // The spawn still completes normally.
      expect(result).toMatchObject({ pid: 4242 });
    });

    it("falls back to the baked bundle when the pointer's blob is missing", async () => {
      const bucket = fakeBucket({ [POINTER_KEY]: r2TextBody(JSON.stringify(POINTER)), [BLOB_KEY]: null });
      const { client, logger } = injectClient(bucket);

      await start(client);

      const env = writtenEnvScript();
      expect(env).toContain("export ARCANIST_BRIDGE_BUNDLE_SOURCE=baked");
      expect(env).not.toContain("export BRIDGE_BUNDLE=");
      expect(freestyleMock.vmWriteFile).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "pointer_blob_missing" }),
        expect.any(String),
      );
    });

    it("falls back to the baked bundle on a sha256 verify mismatch (non-zero exec statusCode)", async () => {
      const bucket = fakeBucket({ [POINTER_KEY]: r2TextBody(JSON.stringify(POINTER)), [BLOB_KEY]: r2BlobBody(GZ) });
      // sha256sum -c exits non-zero on mismatch; vm.exec surfaces that as statusCode, no throw.
      freestyleMock.vmExec.mockImplementation(async (arg: { command: string }) =>
        arg.command.includes("sha256sum -c")
          ? { stdout: "", stderr: "bundle.js: FAILED", statusCode: 1 }
          : { stdout: "4242\n", stderr: "", statusCode: 0 },
      );
      const { client, logger } = injectClient(bucket);

      await start(client);

      const env = writtenEnvScript();
      expect(env).toContain("export ARCANIST_BRIDGE_BUNDLE_SOURCE=baked");
      expect(env).not.toContain("export BRIDGE_BUNDLE=");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "verify_failed" }),
        expect.any(String),
      );
    });

    it("falls back with verify_failed when the verify exec returns an indeterminate statusCode", async () => {
      const bucket = fakeBucket({ [POINTER_KEY]: r2TextBody(JSON.stringify(POINTER)), [BLOB_KEY]: r2BlobBody(GZ) });
      // A null statusCode must NOT pass the integrity gate: only a literal 0 injects.
      freestyleMock.vmExec.mockImplementation(async (arg: { command: string }) =>
        arg.command.includes("sha256sum -c")
          ? { stdout: "", stderr: "", statusCode: null }
          : { stdout: "4242\n", stderr: "", statusCode: 0 },
      );
      const { client, logger } = injectClient(bucket);

      await start(client);

      const env = writtenEnvScript();
      expect(env).toContain("export ARCANIST_BRIDGE_BUNDLE_SOURCE=baked");
      expect(env).not.toContain("export BRIDGE_BUNDLE=");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "verify_failed" }),
        expect.any(String),
      );
    });

    it("falls back with blob_too_large when the gz exceeds the VM fs write cap", async () => {
      const bigGz = Buffer.alloc(8 * 1024 * 1024);
      const bucket = fakeBucket({ [POINTER_KEY]: r2TextBody(JSON.stringify(POINTER)), [BLOB_KEY]: r2BlobBody(bigGz) });
      const { client, logger } = injectClient(bucket);

      await start(client);

      expect(writtenEnvScript()).toContain("export ARCANIST_BRIDGE_BUNDLE_SOURCE=baked");
      expect(freestyleMock.vmWriteFile).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "blob_too_large" }),
        expect.any(String),
      );
    });

    it("falls back with vm_write_failed when writing the gz into the VM throws", async () => {
      const bucket = fakeBucket({ [POINTER_KEY]: r2TextBody(JSON.stringify(POINTER)), [BLOB_KEY]: r2BlobBody(GZ) });
      freestyleMock.vmWriteFile.mockRejectedValueOnce(new Error("disk full"));
      const { client, logger } = injectClient(bucket);

      await start(client);

      expect(writtenEnvScript()).toContain("export ARCANIST_BRIDGE_BUNDLE_SOURCE=baked");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "vm_write_failed" }),
        expect.any(String),
      );
    });

    it("falls back with reason error on a malformed pointer", async () => {
      const bucket = fakeBucket({ [POINTER_KEY]: r2TextBody("{ not json") });
      const { client, logger } = injectClient(bucket);

      await start(client);

      expect(writtenEnvScript()).toContain("export ARCANIST_BRIDGE_BUNDLE_SOURCE=baked");
      expect(freestyleMock.vmWriteFile).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "error" }), expect.any(String));
    });

    it("emits the fallback count metric tagged with the reason when a DD key is configured (no network)", async () => {
      const fetchSpy = vi.fn(async () => ({ ok: true, status: 202, statusText: "Accepted" }));
      vi.stubGlobal("fetch", fetchSpy);
      try {
        const bucket = fakeBucket({ [POINTER_KEY]: r2TextBody(JSON.stringify(POINTER)), [BLOB_KEY]: null });
        const { client } = injectClient(bucket, { ddApiKey: "dd-key", workerEnv: "production" });

        await start(client);
        // Metric emission is fire-and-forget; flush the microtask queue.
        await Promise.resolve();
        await Promise.resolve();

        const fallbackPost = fetchSpy.mock.calls.find(([, init]) =>
          String((init as RequestInit | undefined)?.body ?? "").includes("bridge_bundle_fallback"),
        );
        expect(fallbackPost).toBeDefined();
        const body = JSON.parse(String((fallbackPost![1] as RequestInit).body));
        expect(body.series[0].metric).toBe("arcanist.freestyle.bridge_bundle_fallback");
        expect(body.series[0].tags).toContain("reason:pointer_blob_missing");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("checks only the bundle/script pointers and writes nothing when both are absent", async () => {
      const bucket = fakeBucket({});
      const { client } = injectClient(bucket);
      await start(client);
      expect((bucket.get as ReturnType<typeof vi.fn>).mock.calls.map(([k]) => k)).toEqual([
        "start-bridge/current.json",
        POINTER_KEY,
      ]);
      expect(freestyleMock.vmWriteFile).not.toHaveBeenCalled();
    });
  });

  describe("startCommand start-bridge injection (ARC-1566)", () => {
    const BUNDLE_POINTER_KEY = "bridge/current.json";
    const RAW_BUNDLE = Buffer.from("console.log('fresh bridge bundle');");
    const BUNDLE_GZ = gzipSync(RAW_BUNDLE);
    const BUNDLE_SHA256 = createHash("sha256").update(RAW_BUNDLE).digest("hex");
    const BUNDLE_BLOB_KEY = `bridge/${BUNDLE_SHA256}.js.gz`;
    const BUNDLE_POINTER = {
      sha256: BUNDLE_SHA256,
      key: BUNDLE_BLOB_KEY,
      bytes: RAW_BUNDLE.length,
      gzBytes: BUNDLE_GZ.length,
      builtAt: "2026-07-09T00:00:00.000Z",
      gitSha: "deadbeef",
    };
    const START_BRIDGE_POINTER_KEY = "start-bridge/current.json";
    const RAW_START_BRIDGE = Buffer.from("#!/usr/bin/env bash\nprintf 'fresh-start-bridge\\n'\n");
    const START_BRIDGE_GZ = gzipSync(RAW_START_BRIDGE);
    const START_BRIDGE_SHA256 = createHash("sha256").update(RAW_START_BRIDGE).digest("hex");
    const START_BRIDGE_BLOB_KEY = `start-bridge/${START_BRIDGE_SHA256}.sh.gz`;
    const START_BRIDGE_POINTER = {
      sha256: START_BRIDGE_SHA256,
      key: START_BRIDGE_BLOB_KEY,
      bytes: RAW_START_BRIDGE.length,
      gzBytes: START_BRIDGE_GZ.length,
      builtAt: "2026-07-09T00:00:00.000Z",
      gitSha: "deadbeef",
    };

    function r2TextBody(text: string) {
      return { text: async () => text } as unknown as R2ObjectBody;
    }
    function r2BlobBody(bytes: Uint8Array) {
      const exact = new Uint8Array(bytes.byteLength);
      exact.set(bytes);
      return { arrayBuffer: async () => exact.buffer } as unknown as R2ObjectBody;
    }
    function fakeBucket(objects: Record<string, R2ObjectBody | null>): R2Bucket {
      return { get: vi.fn(async (key: string) => objects[key] ?? null) } as unknown as R2Bucket;
    }
    function injectClient(bucket: R2Bucket | undefined) {
      const logger = createLogger();
      const client = new FreestyleSandboxClient({
        apiKey: "test-key",
        logger,
        ...(bucket ? { bridgeBundles: bucket } : {}),
      });
      return { client, logger };
    }
    async function start(client: FreestyleSandboxClient) {
      return client.startCommand({
        runtimeSandboxId: "vm-123",
        command: "bash /app/start-bridge.sh",
        cwd: "/workspace",
        envs: { SESSION_ID: "sess-1" },
      });
    }

    it("injects, verifies, and launches the fresh start-bridge script on success", async () => {
      const bucket = fakeBucket({
        [BUNDLE_POINTER_KEY]: r2TextBody(JSON.stringify(BUNDLE_POINTER)),
        [BUNDLE_BLOB_KEY]: r2BlobBody(BUNDLE_GZ),
        [START_BRIDGE_POINTER_KEY]: r2TextBody(JSON.stringify(START_BRIDGE_POINTER)),
        [START_BRIDGE_BLOB_KEY]: r2BlobBody(START_BRIDGE_GZ),
      });
      const { client, logger } = injectClient(bucket);

      await start(client);

      const startBridgeWrite = freestyleMock.vmWriteFile.mock.calls.find(
        ([path]) => path === "/tmp/cycloid-start-bridge.fresh.sh.gz",
      );
      expect(startBridgeWrite).toBeDefined();

      const verifyCall = freestyleMock.vmExec.mock.calls.find(
        ([arg]) =>
          typeof arg?.command === "string" &&
          arg.command.includes("gunzip -c /tmp/cycloid-start-bridge.fresh.sh.gz > /tmp/cycloid-start-bridge.fresh.sh"),
      );
      expect(verifyCall).toBeDefined();
      expect(verifyCall![0].command).toContain(START_BRIDGE_SHA256);
      expect(verifyCall![0].command).toContain("chmod 755 /tmp/cycloid-start-bridge.fresh.sh");

      const launchCall = freestyleMock.vmExec.mock.calls.find(
        ([arg]) => typeof arg?.command === "string" && arg.command.includes("setsid"),
      );
      expect(launchCall).toBeDefined();
      expect(launchCall![0].command).toContain("exec bash /tmp/cycloid-start-bridge.fresh.sh");
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ startBridgeSource: "injected", startBridgeSha256: START_BRIDGE_SHA256 }),
        expect.any(String),
      );
    });

    it("falls back to the baked start-bridge script when the start-bridge pointer is missing", async () => {
      const bucket = fakeBucket({
        [BUNDLE_POINTER_KEY]: r2TextBody(JSON.stringify(BUNDLE_POINTER)),
        [BUNDLE_BLOB_KEY]: r2BlobBody(BUNDLE_GZ),
        [START_BRIDGE_POINTER_KEY]: null,
      });
      const { client, logger } = injectClient(bucket);

      await start(client);

      expect(
        freestyleMock.vmWriteFile.mock.calls.some(([path]) => path === "/tmp/cycloid-start-bridge.fresh.sh.gz"),
      ).toBe(false);
      const launchCall = freestyleMock.vmExec.mock.calls.find(
        ([arg]) => typeof arg?.command === "string" && arg.command.includes("setsid"),
      );
      expect(launchCall).toBeDefined();
      expect(launchCall![0].command).toContain("exec bash /app/start-bridge.sh");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: "freestyle_start_bridge_fallback", reason: "pointer_missing" }),
        expect.any(String),
      );
    });
  });

  describe("terminateSandbox", () => {
    it("deletes the VM and reports killed, logging the reason", async () => {
      const logger = createLogger();
      const client = new FreestyleSandboxClient({ apiKey: "test-key", logger });

      await expect(client.terminateSandbox("vm-123", "runtime_cleanup")).resolves.toEqual({ status: "killed" });

      expect(freestyleMock.vmsDelete).toHaveBeenCalledWith({ vmId: "vm-123" });
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ method: "terminateSandbox", reason: "runtime_cleanup", outcome: "success" }),
        expect.any(String),
      );
    });

    it("treats a real SDK NOT_FOUND delete as a missing result", async () => {
      freestyleMock.vmsDelete.mockRejectedValueOnce(makeSdkError("NotFoundError", "NOT_FOUND", 404));
      const client = newClient();

      await expect(client.terminateSandbox("vm-gone", "runtime_cleanup")).resolves.toEqual({ status: "missing" });
    });

    it("treats a real SDK VM_DELETED delete as a missing result", async () => {
      freestyleMock.vmsDelete.mockRejectedValueOnce(makeSdkError("VmDeletedError", "VM_DELETED", 410));
      const client = newClient();

      await expect(client.terminateSandbox("vm-gone", "runtime_cleanup")).resolves.toEqual({ status: "missing" });
    });
  });

  describe("getSandboxInfo", () => {
    it.each([
      ["running", "running"],
      ["starting", "running"],
      ["suspended", "paused"],
      ["suspending", "paused"],
      ["stopped", "missing"],
      ["lost", "missing"],
      // `deleted` normally arrives as a thrown VM_DELETED (see below), but the
      // lifecycle docs expose it as a state, so a returned `deleted` record must
      // classify decisively as missing rather than live-biasing to paused.
      ["deleted", "missing"],
    ] as const)("maps VM state %s to %s via the per-VM read, without waking the VM", async (state, status) => {
      freestyleMock.vmGetInfo.mockResolvedValueOnce({ id: "vm-123", state });
      const client = newClient();

      await expect(client.getSandboxInfo("vm-123", { requestTimeoutMs: 5_000 })).resolves.toEqual({ status });
      // Per-VM metadata read: never the account-wide list, never start (which wakes).
      expect(freestyleMock.vmsRef).toHaveBeenCalledWith({ vmId: "vm-123" });
      expect(freestyleMock.vmsList).not.toHaveBeenCalled();
      expect(freestyleMock.vmStart).not.toHaveBeenCalled();
    });

    it.each([
      ["Running", "running"],
      ["SUSPENDED", "paused"],
      [" stopped ", "missing"],
    ] as const)("maps a recased/padded state %s to %s", async (state, status) => {
      freestyleMock.vmGetInfo.mockResolvedValueOnce({ id: "vm-123", state });
      const client = newClient();

      await expect(client.getSandboxInfo("vm-123")).resolves.toEqual({ status });
    });

    it.each(["building", "hibernating"])(
      "biases an unrecognized state (%s) on an existing VM to paused, preserving rawState",
      async (state) => {
        freestyleMock.vmGetInfo.mockResolvedValueOnce({ id: "vm-123", state });
        const client = newClient();

        // The read succeeded, so the VM exists: an unmapped state must NOT feed the
        // watchdog's fail-closed terminate. `paused` defers within the bounded hold.
        await expect(client.getSandboxInfo("vm-123")).resolves.toEqual({ status: "paused", rawState: state });
      },
    );

    it.each([["running"], ["suspended"], ["building"]] as const)(
      "classifies an explicit deleted flag on a %s VM as missing, overriding the live bias",
      async (state) => {
        // Deletion is a boolean flag, not a state value (the SDK `state` enum has no
        // "deleted"). A soft-deleted VM can still report a live-ish state during the
        // delete window; without the flag guard, state alone would live-bias to
        // paused/running and defer a dead VM (ARC-1478). The flag must win → respawn.
        freestyleMock.vmGetInfo.mockResolvedValueOnce({ id: "vm-123", state, deleted: true });
        const client = newClient();

        await expect(client.getSandboxInfo("vm-123")).resolves.toEqual({ status: "missing" });
      },
    );

    it.each([[null], [undefined]] as const)(
      'live-biases an absent state (%s) to paused but omits rawState, never logging "null"/"undefined"',
      async (state) => {
        freestyleMock.vmGetInfo.mockResolvedValueOnce({ id: "vm-123", state });
        const client = newClient();

        // The read succeeded, so the VM exists — bias live, not the fail-closed
        // terminate. But String(null)/String(undefined) would emit the literal
        // "null"/"undefined" in rawState, indistinguishable from a real state so
        // named; an absent field must drop rawState entirely.
        const result = await client.getSandboxInfo("vm-123");
        expect(result).toEqual({ status: "paused" });
        expect(result).not.toHaveProperty("rawState");
      },
    );

    it("fails closed with missing_config (no retry) when the SDK drops Vm.getInfo()", async () => {
      // The probe casts vms.ref(...) to a getInfo() reader because the method is
      // absent from the SDK .d.ts. If an SDK upgrade removes it, the guard must
      // surface a decisive, non-retryable missing_config — not a TypeError that
      // classifies as retryable `network` and masquerades as an outage before the
      // watchdog terminates a live VM (ARC-1478).
      freestyleMock.vmsRef.mockReturnValueOnce({} as never);
      const client = newClient();

      await expect(client.getSandboxInfo("vm-123")).resolves.toEqual({
        status: "unknown",
        errorCode: "missing_config",
      });
      expect(freestyleMock.vmGetInfo).not.toHaveBeenCalled();
    });

    it("treats a VM_DELETED read as missing", async () => {
      freestyleMock.vmGetInfo.mockRejectedValueOnce(makeSdkError("VmDeletedError", "VM_DELETED", 410));
      const client = newClient();

      await expect(client.getSandboxInfo("vm-123")).resolves.toEqual({ status: "missing" });
      expect(freestyleMock.vmGetInfo).toHaveBeenCalledTimes(1);
    });

    it("retries a transient network failure and returns the successful read", async () => {
      vi.useFakeTimers();
      try {
        freestyleMock.vmGetInfo
          .mockRejectedValueOnce(new TypeError("fetch failed"))
          .mockResolvedValueOnce({ id: "vm-123", state: "running" });
        const client = newClient();

        const resultPromise = client.getSandboxInfo("vm-123");
        await vi.advanceTimersByTimeAsync(2_000);

        await expect(resultPromise).resolves.toEqual({ status: "running" });
        expect(freestyleMock.vmGetInfo).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns unknown with the classified errorCode after exhausting transient retries", async () => {
      vi.useFakeTimers();
      try {
        freestyleMock.vmGetInfo.mockRejectedValue(new TypeError("fetch failed"));
        const client = newClient();

        const resultPromise = client.getSandboxInfo("vm-123");
        await vi.advanceTimersByTimeAsync(10_000);

        await expect(resultPromise).resolves.toEqual({ status: "unknown", errorCode: "network" });
        expect(freestyleMock.vmGetInfo).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not retry a deterministic auth failure", async () => {
      freestyleMock.vmGetInfo.mockRejectedValue(makeSdkError("BadKeyError", "BAD_KEY", 401));
      const client = newClient();

      await expect(client.getSandboxInfo("vm-123")).resolves.toEqual({ status: "unknown", errorCode: "auth" });
      expect(freestyleMock.vmGetInfo).toHaveBeenCalledTimes(1);
    });

    it("retries a 429 rate limit and returns the successful read", async () => {
      // The shared account makes 429s a real transient class: a single rate-limited
      // probe must not read a live VM as unknown (-> watchdog kill, ARC-1478).
      vi.useFakeTimers();
      try {
        freestyleMock.vmGetInfo
          .mockRejectedValueOnce(makeSdkError("RateLimitError", "RATE_LIMITED", 429))
          .mockResolvedValueOnce({ id: "vm-123", state: "running" });
        const client = newClient();

        const resultPromise = client.getSandboxInfo("vm-123");
        await vi.advanceTimersByTimeAsync(2_000);

        await expect(resultPromise).resolves.toEqual({ status: "running" });
        expect(freestyleMock.vmGetInfo).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("times out each hung attempt at requestTimeoutMs and returns unknown(timeout), never waking", async () => {
      vi.useFakeTimers();
      try {
        freestyleMock.vmGetInfo.mockImplementation(() => new Promise(() => {}));
        const client = newClient();

        const resultPromise = client.getSandboxInfo("vm-123", { requestTimeoutMs: 5_000 });
        await vi.advanceTimersByTimeAsync(20_000);

        await expect(resultPromise).resolves.toEqual({ status: "unknown", errorCode: "timeout" });
        expect(freestyleMock.vmGetInfo).toHaveBeenCalledTimes(3);
        expect(freestyleMock.vmStart).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("missing config", () => {
    it("fails closed with missing_config before constructing the SDK when no apiKey is set", async () => {
      const client = new FreestyleSandboxClient({ logger: createLogger() });

      await expect(client.terminateSandbox("vm-123", "runtime_cleanup")).rejects.toBeInstanceOf(E2BSandboxRuntimeError);
      await expect(client.connectSandbox("vm-123", 60_000)).rejects.toMatchObject({
        code: "missing_config",
        requestSent: false,
      });
      expect(freestyleMock.FreestyleCtor).not.toHaveBeenCalled();
    });
  });
});

// ARC-1486: freestyle-client now escapes via the shared control-plane shellQuote
// (../utils) instead of a divergent local copy. The shared helper leaves POSIX-safe
// tokens bare and single-quotes anything with shell-special chars (escaping embedded
// single quotes as '\''). These assert the generated env script / commands stay
// byte-correct for a POSIX shell across the env-injection cases that matter.
describe("shell-escaping in generated env script / commands (shared shellQuote)", () => {
  it("buildSessionEnvScript escapes a representative env map (empty value + single quote)", () => {
    const script = buildSessionEnvScript(
      {
        PLAIN: "safe_value-1", // safe token -> bare
        EMPTY: "", // -> ''
        WITH_QUOTE: "a'b", // -> 'a'\''b'
        WITH_SPACE: "hello world", // -> 'hello world'
        WITH_DOLLAR: "a$b", // -> 'a$b'
      },
      "vm-abc123",
    );

    expect(script).toBe(
      [
        "export E2B_SANDBOX_ID=vm-abc123",
        "export PLAIN=safe_value-1",
        "export EMPTY=''",
        "export WITH_QUOTE='a'\\''b'",
        "export WITH_SPACE='hello world'",
        "export WITH_DOLLAR='a$b'",
        "",
      ].join("\n"),
    );
  });

  it("buildDetachedStartCommand leaves a safe cwd bare and needs no outer re-escape", () => {
    const cmd = buildDetachedStartCommand({
      runtimeSandboxId: "vm-123",
      command: "bash /app/start-bridge.sh",
      cwd: "/workspace",
    });

    expect(cmd).toBe(
      "nohup setsid bash -lc 'set -a; . /etc/cycloid/session-env.sh; set +a; " +
        "cd /workspace; exec bash /app/start-bridge.sh' " +
        ">/tmp/cycloid-start-bridge.out 2>&1 & echo $!",
    );
  });

  it("buildDetachedStartCommand single-quotes a special cwd and re-escapes it through bash -lc", () => {
    const cmd = buildDetachedStartCommand({
      runtimeSandboxId: "vm-123",
      command: "bash /app/start-bridge.sh",
      cwd: "/work space",
    });

    // Inner sees `cd '/work space'`; the outer bash -lc wrapper escapes each single
    // quote as '\'' so the inner shell reconstructs the quoted path exactly.
    expect(cmd).toContain("cd '\\''/work space'\\''; exec bash /app/start-bridge.sh");
  });

  it("buildRunCommand inlines cwd + envs with shared escaping (empty value + single quote)", () => {
    const cmd = buildRunCommand({
      runtimeSandboxId: "vm-123",
      command: "npm test",
      cwd: "/workspace",
      envs: { FOO: "bar", EMPTY: "", Q: "a'b" },
    });

    expect(cmd).toBe("cd /workspace && env FOO=bar EMPTY='' Q='a'\\''b' npm test");
  });

  it("buildRunCommand with no cwd/envs is just the command", () => {
    expect(buildRunCommand({ runtimeSandboxId: "vm-123", command: "npm test" })).toBe("npm test");
  });
});

describe("parseBridgeBundlePointer (ARC-1512 pointer contract)", () => {
  const SHA = "a".repeat(64);
  const goodPointer = {
    sha256: SHA,
    key: `bridge/${SHA}.js.gz`,
    bytes: 100,
    gzBytes: 40,
    builtAt: "2026-07-08T00:00:00.000Z",
    gitSha: "deadbeef",
  };

  it("parses a well-formed pointer, preserving sha256 + key", () => {
    const parsed = parseBridgeBundlePointer(JSON.stringify(goodPointer));
    expect(parsed).toMatchObject({ sha256: SHA, key: `bridge/${SHA}.js.gz`, bytes: 100, gzBytes: 40 });
  });

  it("defaults the informational fields when absent but keeps the load-bearing sha256/key", () => {
    const parsed = parseBridgeBundlePointer(JSON.stringify({ sha256: SHA, key: `bridge/${SHA}.js.gz` }));
    expect(parsed).toEqual({ sha256: SHA, key: `bridge/${SHA}.js.gz`, bytes: 0, gzBytes: 0, builtAt: "", gitSha: "" });
  });

  it.each([
    ["non-JSON text", "{ not json"],
    ["missing sha256", JSON.stringify({ key: `bridge/${SHA}.js.gz` })],
    ["short sha256", JSON.stringify({ sha256: "abc", key: `bridge/${SHA}.js.gz` })],
    ["non-hex sha256", JSON.stringify({ sha256: "z".repeat(64), key: `bridge/${SHA}.js.gz` })],
    ["missing key", JSON.stringify({ sha256: SHA })],
    ["key outside the bridge/ prefix", JSON.stringify({ sha256: SHA, key: "evil/payload.js.gz" })],
  ])("throws on a malformed pointer: %s", (_label, text) => {
    expect(() => parseBridgeBundlePointer(text)).toThrow();
  });
});

describe("buildBridgeVerifyCommand (ARC-1512 in-VM verify)", () => {
  it("gunzips then checks the raw bundle's sha256, failing the exec on mismatch", () => {
    const sha = "b".repeat(64);
    const cmd = buildBridgeVerifyCommand(sha);
    expect(cmd).toBe(
      "gunzip -c /tmp/cycloid-bridge-fresh.js.gz > /app/bridge/bundle.fresh.js && " +
        "rm -f /tmp/cycloid-bridge-fresh.js.gz && " +
        `printf '%s  %s\\n' ${sha} /app/bridge/bundle.fresh.js | sha256sum -c -`,
    );
  });
});

describe("buildVmName", () => {
  const baseRequest = {
    sandboxId: "560919ac-cfcb-43d8-8ce3-07dfdb29f0d4",
    template: "",
    timeoutMs: 60_000,
    envs: {},
    metadata: {},
  };

  it("names the VM with the repo slug and an 8-char session-id prefix", () => {
    expect(
      buildVmName({
        ...baseRequest,
        sessionId: "34fc062f-68a0-454d-9517-4e53edf116ea",
        metadata: { repo_name: "mia-copy-4" },
      }),
    ).toBe("cycloid-mia-copy-4-34fc062f");
  });

  it("slugifies repo names: lowercases and collapses non-alphanumerics to single dashes", () => {
    expect(
      buildVmName({
        ...baseRequest,
        sessionId: "34fc062f-68a0-454d-9517-4e53edf116ea",
        metadata: { repo_name: "My_Repo..Name" },
      }),
    ).toBe("cycloid-my-repo-name-34fc062f");
  });

  it("caps long repo slugs without leaving a trailing dash", () => {
    const name = buildVmName({
      ...baseRequest,
      sessionId: "34fc062f-68a0-454d-9517-4e53edf116ea",
      metadata: { repo_name: "a".repeat(29) + "-tail-overflowing-the-cap" },
    });
    expect(name).toBe(`cycloid-${"a".repeat(29)}-34fc062f`);
  });

  it("omits the repo segment when metadata carries no usable repo name", () => {
    expect(
      buildVmName({
        ...baseRequest,
        sessionId: "34fc062f-68a0-454d-9517-4e53edf116ea",
        metadata: { repo_name: "---" },
      }),
    ).toBe("cycloid-34fc062f");
    expect(buildVmName({ ...baseRequest, sessionId: "34fc062f-68a0-454d-9517-4e53edf116ea" })).toBe("cycloid-34fc062f");
  });

  it("keeps the full internal sandboxId for sessionless creates (their only handle)", () => {
    expect(buildVmName({ ...baseRequest, metadata: { repo_name: "cycloid" } })).toBe(
      "cycloid-cycloid-560919ac-cfcb-43d8-8ce3-07dfdb29f0d4",
    );
  });
});

describe("createSandboxProviderClient (freestyle arm)", () => {
  it("returns a FreestyleSandboxClient for the freestyle backend", () => {
    const client = createSandboxProviderClient(FREESTYLE_RUNTIME_BACKEND, { apiKey: "test-key" });
    expect(client).toBeInstanceOf(FreestyleSandboxClient);
  });

  it("still returns an E2BSandboxClient for the e2b_cloud backend", () => {
    const client = createSandboxProviderClient(E2B_CLOUD_RUNTIME_BACKEND, { apiKey: "test-key" });
    expect(client).toBeInstanceOf(E2BSandboxClient);
  });
});
