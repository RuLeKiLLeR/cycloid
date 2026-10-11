/// <reference types="@cloudflare/workers-types" />
/**
 * Tests for R1: terminate the runtime a cold attach is about to overwrite.
 *
 * `recordRunningE2BRuntimeForSpawn` column-patches the new runtime_sandbox_id
 * over the prior one with no read-before-write, so once the attach lands the
 * prior id is orphaned from every sweep. `decideSupersededRuntimeTerminate` is
 * the pure decider that turns the prior row + the incoming id into either a
 * terminate target (the prior VM's id + its OWN persisted backend) or a no-op,
 * so it unit-tests without the session DO (mirroring `decideResumeFailureClear`).
 */
import { describe, expect, it } from "vitest";

import {
  E2B_CLOUD_RUNTIME_BACKEND,
  FREESTYLE_RUNTIME_BACKEND,
} from "../../apps/control-plane-worker/src/sandbox/runtime-backend";
import {
  decideSupersededRuntimeTerminate,
  runtimeTerminateSource,
} from "../../apps/control-plane-worker/src/session/e2b-runtime-lifecycle";

describe("decideSupersededRuntimeTerminate", () => {
  it("returns the prior VM's id + its own backend when a distinct prior VM exists (freestyle)", () => {
    expect(
      decideSupersededRuntimeTerminate({
        priorRuntimeSandboxId: "fs-prior",
        priorRuntimeBackend: FREESTYLE_RUNTIME_BACKEND,
        nextRuntimeSandboxId: "fs-next",
      }),
    ).toEqual({ runtimeSandboxId: "fs-prior", runtimeBackend: FREESTYLE_RUNTIME_BACKEND });
  });

  it("terminates the prior VM on its e2b_cloud backend (cross-backend safe)", () => {
    expect(
      decideSupersededRuntimeTerminate({
        priorRuntimeSandboxId: "e2b-prior",
        priorRuntimeBackend: E2B_CLOUD_RUNTIME_BACKEND,
        nextRuntimeSandboxId: "fs-next",
      }),
    ).toEqual({ runtimeSandboxId: "e2b-prior", runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND });
  });

  it("treats a null/empty legacy backend as e2b_cloud rather than skipping", () => {
    // A legacy row with no persisted backend parses to e2b_cloud; the prior VM is
    // still reclaimed, not orphaned.
    expect(
      decideSupersededRuntimeTerminate({
        priorRuntimeSandboxId: "e2b-prior",
        priorRuntimeBackend: null,
        nextRuntimeSandboxId: "e2b-next",
      }),
    ).toEqual({ runtimeSandboxId: "e2b-prior", runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND });
    expect(
      decideSupersededRuntimeTerminate({
        priorRuntimeSandboxId: "e2b-prior",
        priorRuntimeBackend: "",
        nextRuntimeSandboxId: "e2b-next",
      }),
    ).toEqual({ runtimeSandboxId: "e2b-prior", runtimeBackend: E2B_CLOUD_RUNTIME_BACKEND });
  });

  it("no-ops when the prior id equals the next id (resume re-attach of the same VM)", () => {
    expect(
      decideSupersededRuntimeTerminate({
        priorRuntimeSandboxId: "fs-1",
        priorRuntimeBackend: FREESTYLE_RUNTIME_BACKEND,
        nextRuntimeSandboxId: "fs-1",
      }),
    ).toBeNull();
  });

  it("no-ops when there is no prior id to overwrite (null / empty / non-string)", () => {
    expect(
      decideSupersededRuntimeTerminate({
        priorRuntimeSandboxId: null,
        priorRuntimeBackend: FREESTYLE_RUNTIME_BACKEND,
        nextRuntimeSandboxId: "fs-next",
      }),
    ).toBeNull();
    expect(
      decideSupersededRuntimeTerminate({
        priorRuntimeSandboxId: "",
        priorRuntimeBackend: FREESTYLE_RUNTIME_BACKEND,
        nextRuntimeSandboxId: "fs-next",
      }),
    ).toBeNull();
    expect(
      decideSupersededRuntimeTerminate({
        priorRuntimeSandboxId: undefined,
        priorRuntimeBackend: FREESTYLE_RUNTIME_BACKEND,
        nextRuntimeSandboxId: "fs-next",
      }),
    ).toBeNull();
  });

  it("no-ops when the prior backend is unparseable (never guess a provider to kill against)", () => {
    // Distinct prior id, but a corrupted/unknown backend — the caller logs and
    // skips instead of picking the wrong provider's terminate client.
    expect(
      decideSupersededRuntimeTerminate({
        priorRuntimeSandboxId: "prior-1",
        priorRuntimeBackend: "modal",
        nextRuntimeSandboxId: "next-1",
      }),
    ).toBeNull();
  });
});

describe("runtimeTerminateSource", () => {
  it("maps superseded_runtime to the spawn source bucket", () => {
    expect(runtimeTerminateSource("superseded_runtime")).toBe("spawn");
  });
});
