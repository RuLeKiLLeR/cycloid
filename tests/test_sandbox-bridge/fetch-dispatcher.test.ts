import { describe, expect, it, vi } from "vitest";

vi.mock("undici", () => {
  const setGlobalDispatcher = vi.fn();
  class Agent {
    constructor(public readonly opts: { headersTimeout?: number; bodyTimeout?: number }) {}
  }
  return { Agent, setGlobalDispatcher };
});

const { configureFetchDispatcher } = await import("../../apps/sandbox-bridge/src/services/fetch-dispatcher.ts");
const undici = await import("undici");

describe("configureFetchDispatcher", () => {
  it("registers a global dispatcher with aggressive headers timeout and generous body timeout", () => {
    const config = configureFetchDispatcher();

    expect(config.headersTimeoutMs).toBe(30_000);
    expect(config.bodyTimeoutMs).toBe(600_000);

    const setSpy = vi.mocked(undici.setGlobalDispatcher);
    expect(setSpy).toHaveBeenCalledTimes(1);

    const dispatcher = setSpy.mock.calls[0]![0] as unknown as {
      opts: { headersTimeout?: number; bodyTimeout?: number };
    };
    expect(dispatcher.opts.headersTimeout).toBe(30_000);
    expect(dispatcher.opts.bodyTimeout).toBe(600_000);
  });
});
