import { describe, expect, it } from "vitest";

import { classifySpawnTimeoutPhase } from "../../apps/control-plane-worker/src/sandbox/classifySpawnTimeoutPhase";

describe("classifySpawnTimeoutPhase", () => {
  it("returns spawn_provider_error for any provider_error origin", () => {
    expect(classifySpawnTimeoutPhase({ origin: "provider_error", providerObjectId: null })).toBe(
      "spawn_provider_error",
    );
    expect(classifySpawnTimeoutPhase({ origin: "provider_error", providerObjectId: "sbx-1" })).toBe(
      "spawn_provider_error",
    );
  });

  it("returns spawn_deadline_no_object when deadline fires without a sandbox object id", () => {
    expect(classifySpawnTimeoutPhase({ origin: "deadline", providerObjectId: null })).toBe("spawn_deadline_no_object");
    expect(classifySpawnTimeoutPhase({ origin: "deadline", providerObjectId: undefined })).toBe(
      "spawn_deadline_no_object",
    );
  });

  it("returns spawn_deadline_no_bridge when provider returned an object id but bridge never connected", () => {
    expect(classifySpawnTimeoutPhase({ origin: "deadline", providerObjectId: "sbx-1" })).toBe(
      "spawn_deadline_no_bridge",
    );
  });
});
