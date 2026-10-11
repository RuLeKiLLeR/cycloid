import { describe, expect, it, vi } from "vitest";

describe("sandbox layer provider import boundary", () => {
  it("imports the build service without loading the E2B SDK", async () => {
    vi.resetModules();
    const e2bLoadAttempted = vi.fn();
    vi.doMock("e2b", () => {
      e2bLoadAttempted();
      throw new Error("e2b must not load while importing sandbox layer services");
    });

    await expect(
      import("../../apps/control-plane-worker/src/sandbox/layer-provider-build-service"),
    ).resolves.toBeTruthy();
    expect(e2bLoadAttempted).not.toHaveBeenCalled();

    vi.doUnmock("e2b");
  });
});
