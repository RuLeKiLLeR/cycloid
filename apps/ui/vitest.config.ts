import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    setupFiles: ["../../tests/setup/vitest-network-guard.ts"],
    exclude: ["**/node_modules/**", "**/.claude/worktrees/**", "**/.codex/worktrees/**", "**/.worktrees/**"],
  },
});
