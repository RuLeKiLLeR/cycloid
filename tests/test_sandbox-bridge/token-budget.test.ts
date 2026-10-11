import { describe, expect, it } from "vitest";

import { TokenBudgetTracker } from "../../apps/sandbox-bridge/src/utils/token-budget.js";
import { OpenAIModel } from "../../shared/constants/models.js";

describe("TokenBudgetTracker", () => {
  it("tracks parent-session usage and warnings", () => {
    const tracker = new TokenBudgetTracker();

    const update = tracker.recordMessageUpdate(
      {
        id: "msg-1",
        role: "assistant",
        sessionID: "parent",
        modelID: OpenAIModel.GPT54Mini,
        tokens: {
          input: 850_000,
          output: 120,
          cache: { read: 10_000, write: 5_000 },
        },
      },
      {
        parentSessionId: "parent",
        contextFillWarningEmitted: false,
      },
    );

    expect(update).toBeTruthy();
    expect(update?.kind).toBe("parent");
    if (!update || update.kind !== "parent") {
      throw new Error("expected parent token update");
    }

    expect(update.currentModel).toBe(OpenAIModel.GPT54Mini);
    expect(update.contextUsed).toBe(855_000);
    expect(update.emitContextFillWarning).toBe(true);
    expect(update.usageEvent.contextWindow).toBe(400_000);
    expect(update.usageEvent.instructionFilesEst).toBe(0);
    expect(update.usageEvent.peakContextTokens).toBe(855_000);
    expect(update.usageEvent.inputTokens).toBe(840_000);
    expect(update.usageEvent.outputTokens).toBe(120);
    expect(update.usageEvent.cacheReadTokens).toBe(10_000);
    expect(update.usageEvent.cacheWriteTokens).toBe(5_000);
  });

  it("reprices GPT-5.4 usage when the prompt crosses the long-context threshold", () => {
    const tracker = new TokenBudgetTracker();

    const update = tracker.recordMessageUpdate(
      {
        id: "msg-1",
        role: "assistant",
        sessionID: "parent",
        modelID: OpenAIModel.GPT54,
        tokens: {
          input: 280_000,
          output: 10_000,
          cache: { read: 20_000, write: 0 },
        },
      },
      {
        parentSessionId: "parent",
        contextFillWarningEmitted: false,
      },
    );

    expect(update).toBeTruthy();
    expect(update?.kind).toBe("parent");
    if (!update || update.kind !== "parent") {
      throw new Error("expected parent token update");
    }

    expect(update.contextUsed).toBe(280_000);
    expect(update.usageEvent.inputTokens).toBe(260_000);
    expect(update.usageEvent.totalCostUsd).toBeCloseTo(1.3 + 0.225 + 0.01, 4);
  });
});
