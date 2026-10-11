import { afterEach, describe, expect, it, vi } from "vitest";

import { createTimeoutAwareSignal } from "../../apps/sandbox-bridge/src/utils/abort-signal.js";

describe("createTimeoutAwareSignal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a timeout signal when there is no caller signal", () => {
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
    const anySpy = vi.spyOn(AbortSignal, "any");

    expect(createTimeoutAwareSignal(undefined, 1234)).toBe(timeoutSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(1234);
    expect(anySpy).not.toHaveBeenCalled();
  });

  it("combines the caller signal with a timeout signal", () => {
    const callerSignal = new AbortController().signal;
    const timeoutSignal = new AbortController().signal;
    const combinedSignal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
    const anySpy = vi.spyOn(AbortSignal, "any").mockReturnValue(combinedSignal);

    expect(createTimeoutAwareSignal(callerSignal, 5678)).toBe(combinedSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(5678);
    expect(anySpy).toHaveBeenCalledWith([callerSignal, timeoutSignal]);
  });
});
