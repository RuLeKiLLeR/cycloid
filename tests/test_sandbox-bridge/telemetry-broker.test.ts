// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { describe, expect, it } from "vitest";

import {
  isDdLogsBrokerReady,
  resolveTelemetryBrokerEndpoint,
} from "../../apps/sandbox-bridge/src/services/telemetry-broker.js";

describe("resolveTelemetryBrokerEndpoint", () => {
  const full = {
    CONTROL_PLANE_URL: "https://cp.test.trycycloid.com",
    SESSION_ID: "sess-abc",
    SANDBOX_AUTH_TOKEN: "sbx-token-1",
  };

  it("returns null when CONTROL_PLANE_URL is missing", () => {
    const { CONTROL_PLANE_URL, ...env } = full;
    expect(resolveTelemetryBrokerEndpoint(env)).toBeNull();
  });

  it("returns null when SESSION_ID is missing", () => {
    const { SESSION_ID, ...env } = full;
    expect(resolveTelemetryBrokerEndpoint(env)).toBeNull();
  });

  it("returns null when SANDBOX_AUTH_TOKEN is missing", () => {
    const { SANDBOX_AUTH_TOKEN, ...env } = full;
    expect(resolveTelemetryBrokerEndpoint(env)).toBeNull();
  });

  it("returns base and sandboxAuthToken when all present", () => {
    const result = resolveTelemetryBrokerEndpoint(full);
    expect(result).toEqual({
      base: "https://cp.test.trycycloid.com/api/sessions/sess-abc/sandbox/telemetry",
      sandboxAuthToken: "sbx-token-1",
    });
  });

  it("trims trailing slashes from CONTROL_PLANE_URL and url-encodes SESSION_ID", () => {
    const result = resolveTelemetryBrokerEndpoint({
      ...full,
      CONTROL_PLANE_URL: "https://cp.test.trycycloid.com///",
      SESSION_ID: "sess/with space",
    });
    expect(result?.base).toBe("https://cp.test.trycycloid.com/api/sessions/sess%2Fwith%20space/sandbox/telemetry");
  });
});

describe("isDdLogsBrokerReady", () => {
  const brokerEnv = {
    CONTROL_PLANE_URL: "https://api.example.com",
    SESSION_ID: "session-1",
    SANDBOX_AUTH_TOKEN: "token-1",
  };

  it("requires both the worker capability bit and a reachable session broker", () => {
    expect(isDdLogsBrokerReady({ ...brokerEnv, ARCANIST_DD_LOGS_BROKER_READY: "1" })).toBe(true);
    expect(isDdLogsBrokerReady({ ...brokerEnv, ARCANIST_DD_LOGS_BROKER_READY: "0" })).toBe(false);
    expect(isDdLogsBrokerReady({ ARCANIST_DD_LOGS_BROKER_READY: "1" })).toBe(false);
  });
});
