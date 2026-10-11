import { beforeAll, describe, expect, it } from "vitest";

import {
  E2B_RUNTIME_LIVE_LEASE_MS_DEFAULT,
  getE2BRuntimeLiveLeaseMs as getCleanupE2BRuntimeLiveLeaseMs,
} from "../../../apps/control-plane-worker/src/constants/e2b-cleanup.ts";
import type { Env } from "../../../apps/control-plane-worker/src/types";
import { mockCloudflareWorkers, mockSentryCloudflare } from "./helpers.ts";

mockCloudflareWorkers();
mockSentryCloudflare();

type WorkerModule = {
  assertValidE2BProviderRefreshConfig: (env: Env) => {
    intervalMs: number;
    ttlMs: number;
  };
  getE2BRuntimeLiveLeaseMs: (env: Env) => number;
};

describe("E2B runtime defaults", () => {
  let assertValidE2BProviderRefreshConfig: WorkerModule["assertValidE2BProviderRefreshConfig"];
  let getSessionE2BRuntimeLiveLeaseMs: WorkerModule["getE2BRuntimeLiveLeaseMs"];

  beforeAll(async () => {
    const mod = (await import("../../../apps/control-plane-worker/src/session/durable-object.ts")) as WorkerModule;
    assertValidE2BProviderRefreshConfig = mod.assertValidE2BProviderRefreshConfig;
    getSessionE2BRuntimeLiveLeaseMs = mod.getE2BRuntimeLiveLeaseMs;
  });

  it("keeps session and cleanup live-lease defaults in sync when the env var is absent", () => {
    expect(E2B_RUNTIME_LIVE_LEASE_MS_DEFAULT).toBe(900_000);
    expect(getSessionE2BRuntimeLiveLeaseMs({} as Env)).toBe(900_000);
    expect(getCleanupE2BRuntimeLiveLeaseMs({})).toBe(900_000);
  });

  it("accepts provider refresh defaults when refresh and TTL env vars are absent", () => {
    expect(assertValidE2BProviderRefreshConfig({} as Env)).toEqual({
      intervalMs: 1_800_000,
      ttlMs: 3_600_000,
    });
  });
});
