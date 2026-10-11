import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "disposable/memory-review-bot/memory-review-bot-cohorts.test.ts",
      "disposable/memory-review-bot/memory-review-bot-evals.test.ts",
    ],
    setupFiles: ["./tests/setup/vitest-network-guard.ts"],
  },
});
