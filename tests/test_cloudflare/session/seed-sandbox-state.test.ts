import { describe, expect, it } from "vitest";

import { FakeStorage, seedSandboxState } from "./helpers";

describe("seedSandboxState", () => {
  it("seeds and updates the DO-owned sandbox state row", () => {
    const storage = new FakeStorage();
    seedSandboxState(storage.sql as unknown as SqlStorage, "session-1", {
      status: "spawning",
      spawnRetryCount: 2,
      pendingPromptDispatch: 1,
    });
    seedSandboxState(storage.sql as unknown as SqlStorage, "session-1", { status: "running" });

    expect(
      storage.sql
        .exec(
          "SELECT status, spawn_retry_count, pending_prompt_dispatch FROM sandbox_state WHERE session_id = ?",
          "session-1",
        )
        .toArray(),
    ).toEqual([{ status: "running", spawn_retry_count: 0, pending_prompt_dispatch: 0 }]);
  });
});
