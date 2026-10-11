import { describe, expect, it } from "vitest";

import { displayStatusFromPhase, displayStatusFromSession } from "../../shared/session/display-status";

describe("displayStatusFromPhase", () => {
  it("collapses phase values into the sidebar pill domain", () => {
    expect(displayStatusFromPhase("running")).toBe("working");
    expect(displayStatusFromPhase("finalizing")).toBe("working");
    expect(displayStatusFromPhase("waiting_for_input")).toBe("waiting_for_input");
    expect(displayStatusFromPhase("completed")).toBe("completed");
    expect(displayStatusFromPhase("review_listening")).toBe("completed");
    expect(displayStatusFromPhase("blocked")).toBe("failed");
    expect(displayStatusFromPhase("failed")).toBe("failed");
    expect(displayStatusFromPhase("stopped")).toBe("stopped");
    expect(displayStatusFromPhase("superseded")).toBe("stopped");
    expect(displayStatusFromPhase("idle")).toBe("stopped");
    expect(displayStatusFromPhase("archived")).toBe("archived");
    expect(displayStatusFromPhase("not-a-phase")).toBe("stopped");
  });
});

describe("displayStatusFromSession", () => {
  it("uses lifecycle stage without overriding terminal phase truth", () => {
    expect(displayStatusFromSession({ phase: "completed", uiLifecycleStage: "verifying" })).toBe("working");
    expect(displayStatusFromSession({ phase: "completed", uiLifecycleStage: "merge_ready" })).toBe("completed");
    expect(displayStatusFromSession({ phase: "failed", uiLifecycleStage: "verifying" })).toBe("failed");
    expect(displayStatusFromSession({ phase: "archived", uiLifecycleStage: "verifying" })).toBe("archived");
  });

  it("keeps both finalizing steps active", () => {
    expect(displayStatusFromSession({ phase: "finalizing", finalizingStep: "post_execution" })).toBe("working");
    expect(displayStatusFromSession({ phase: "finalizing", finalizingStep: "publishing" })).toBe("working");
  });
});
