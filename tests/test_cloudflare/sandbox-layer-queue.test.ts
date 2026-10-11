import { describe, expect, it } from "vitest";

import { queueHandlerFor } from "../../apps/control-plane-worker/src/queue-dispatch";
import type { SandboxLayerBuildQueueMessage } from "../../apps/control-plane-worker/src/types";

describe("sandbox layer queue dispatch", () => {
  it("routes production and QA sandbox layer build queues", () => {
    expect(queueHandlerFor("cycloid-sandbox-layer-builds")).toEqual(expect.any(Function));
    expect(queueHandlerFor("cycloid-sandbox-layer-builds-qa")).toEqual(expect.any(Function));
  });

  it("uses explicit reasoned wake-up messages", () => {
    const message = {
      buildId: "build-1",
      reason: "poll",
      attempt: 2,
    } satisfies SandboxLayerBuildQueueMessage;

    expect(message).toEqual({ buildId: "build-1", reason: "poll", attempt: 2 });
  });
});
