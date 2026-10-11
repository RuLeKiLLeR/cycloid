import { describe, expect, it, vi } from "vitest";

import { createAuthenticatedBootstrapBarrier } from "../../apps/ui/src/authenticated-bootstrap-barrier";

describe("createAuthenticatedBootstrapBarrier", () => {
  it("clears only after routes and observability are all ready", () => {
    const onStable = vi.fn();
    const markReady = createAuthenticatedBootstrapBarrier(onStable);

    markReady("routes");
    markReady("sentry");
    expect(onStable).not.toHaveBeenCalled();

    markReady("datadog");
    expect(onStable).toHaveBeenCalledOnce();
  });

  it("ignores duplicate ready signals", () => {
    const onStable = vi.fn();
    const markReady = createAuthenticatedBootstrapBarrier(onStable);

    markReady("routes");
    markReady("routes");
    markReady("sentry");
    markReady("datadog");
    markReady("datadog");

    expect(onStable).toHaveBeenCalledOnce();
  });
});
