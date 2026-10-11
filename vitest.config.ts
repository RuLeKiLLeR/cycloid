import os from "os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    // Cap workers at half the CPU count to prevent dynamic-import timeouts
    // caused by resource contention when all cores fork simultaneously.
    maxWorkers: Math.max(Math.floor(os.cpus().length / 2), 1),
    // Several suites import the full control-plane-worker module in beforeAll
    // (a heavy dynamic import). Under CI core contention this exceeds vitest's
    // default 10s hookTimeout and fails the run as a flake. Raise the hook
    // ceiling so a slow-but-successful import does not fail an otherwise green run.
    hookTimeout: 30_000,
    // Worker code under test emits async structured logs that can still be in-flight
    // when a vitest worker tears down; the pending onUserConsoleLog RPC then fails the
    // run (EnvironmentTeardownError) even with all tests green. Skip interception so
    // console output goes straight to stdout with no worker->main RPC to race.
    disableConsoleIntercept: true,
    setupFiles: ["./tests/setup/vitest-network-guard.ts"],
    // Worktree excludes are root-anchored (no leading **/) so they only drop
    // worktrees nested under the current checkout; a leading **/ would also
    // match the checkout's own absolute path when running inside a worktree
    // and exclude every test.
    exclude: [
      "**/node_modules/**",
      ".claude/worktrees/**",
      ".codex/worktrees/**",
      ".worktrees/**",
      "tests/test_ui/browser/**",
      "tests/test_workerd/**",
    ],
  },
});
