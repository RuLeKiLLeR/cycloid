import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  postCountMetricSeries: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/observability/pr-metrics", () => ({
  postCountMetricSeries: mocks.postCountMetricSeries,
}));

import { emitMentionBootstrapOutcomeMetric } from "../../apps/control-plane-worker/src/observability/mention-bootstrap-metrics";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("emitMentionBootstrapOutcomeMetric", () => {
  it.each(["created", "retry_permission_indeterminate"] as const)(
    "posts the mention-bootstrap count with bounded outcome tag %s",
    async (outcome) => {
      await emitMentionBootstrapOutcomeMetric({ DD_API_KEY: "key-123", WORKER_ENV: "production" }, outcome);

      expect(mocks.postCountMetricSeries).toHaveBeenCalledWith(
        "key-123",
        [
          {
            metric: "cycloid.mention_bootstrap",
            tags: expect.arrayContaining(["env:production", `outcome:${outcome}`]),
            value: 1,
          },
        ],
        "mention-bootstrap",
      );
    },
  );

  it("no-ops without a Datadog API key", async () => {
    await emitMentionBootstrapOutcomeMetric({ WORKER_ENV: "test" }, "created");

    expect(mocks.postCountMetricSeries).not.toHaveBeenCalled();
  });
});
