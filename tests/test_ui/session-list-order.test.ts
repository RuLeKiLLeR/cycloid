import { describe, expect, it } from "vitest";

import type { SessionMetadata } from "../../apps/ui/src/types";
import { orderSessionsForSidebar } from "../../apps/ui/src/utils/session-list-order.js";
import { displayStatusFromPhase } from "../../shared/session/display-status";

function makeSession(overrides: Partial<SessionMetadata> & Pick<SessionMetadata, "sessionId">): SessionMetadata {
  const { sessionId, ...rest } = overrides;
  const phase = rest.phase ?? "idle";
  return {
    sessionId,
    phase,
    displayStatus: displayStatusFromPhase(phase),
    prUrl: null,
    createdAt: 1,
    model: null,
    title: sessionId,
    ...rest,
  };
}

describe("orderSessionsForSidebar", () => {
  it("renders visible children directly under their parent instead of flat recency order", () => {
    const sessions: SessionMetadata[] = [
      makeSession({
        sessionId: "child-1",
        title: "Guard receipt auto-match rollout",
        parentSessionId: "parent-1",
        spawnDepth: 1,
      }),
      makeSession({
        sessionId: "child-2",
        title: "Fix rollout audit gaps for receipt auto match",
        parentSessionId: "parent-1",
        spawnDepth: 1,
      }),
      makeSession({
        sessionId: "child-3",
        title: "Investigate meridian logistics receipt auto-match",
        parentSessionId: "parent-1",
        spawnDepth: 1,
      }),
      makeSession({
        sessionId: "parent-1",
        title: "Investigate receipt auto-matching bug",
        phase: "stopped",
      }),
    ];

    expect(orderSessionsForSidebar(sessions).map((session) => session.sessionId)).toEqual([
      "parent-1",
      "child-1",
      "child-2",
      "child-3",
    ]);
  });

  it("keeps children visible when the parent is filtered out of the current list", () => {
    const sessions: SessionMetadata[] = [
      makeSession({
        sessionId: "child-1",
        parentSessionId: "parent-1",
        spawnDepth: 1,
      }),
      makeSession({
        sessionId: "other-root",
      }),
    ];

    expect(orderSessionsForSidebar(sessions).map((session) => session.sessionId)).toEqual(["child-1", "other-root"]);
  });

  it("nests multiple visible generations in sibling order", () => {
    const sessions: SessionMetadata[] = [
      makeSession({
        sessionId: "grandchild-1",
        parentSessionId: "child-1",
        spawnDepth: 2,
      }),
      makeSession({
        sessionId: "child-1",
        parentSessionId: "parent-1",
        spawnDepth: 1,
      }),
      makeSession({
        sessionId: "child-2",
        parentSessionId: "parent-1",
        spawnDepth: 1,
      }),
      makeSession({
        sessionId: "parent-1",
      }),
    ];

    expect(orderSessionsForSidebar(sessions).map((session) => session.sessionId)).toEqual([
      "parent-1",
      "child-1",
      "grandchild-1",
      "child-2",
    ]);
  });

  it("anchors a parent-child group at the newest visible descendant position", () => {
    const sessions: SessionMetadata[] = [
      makeSession({
        sessionId: "child-1",
        parentSessionId: "parent-1",
        spawnDepth: 1,
      }),
      makeSession({
        sessionId: "other-root",
      }),
      makeSession({
        sessionId: "parent-1",
      }),
    ];

    expect(orderSessionsForSidebar(sessions).map((session) => session.sessionId)).toEqual([
      "parent-1",
      "child-1",
      "other-root",
    ]);
  });

  it("keeps self-referential sessions visible", () => {
    const sessions: SessionMetadata[] = [
      makeSession({
        sessionId: "self",
        parentSessionId: "self",
      }),
      makeSession({
        sessionId: "other-root",
      }),
    ];

    expect(orderSessionsForSidebar(sessions).map((session) => session.sessionId)).toEqual(["self", "other-root"]);
  });

  it("keeps mutually cyclic sessions visible without looping", () => {
    const sessions: SessionMetadata[] = [
      makeSession({
        sessionId: "child-1",
        parentSessionId: "child-2",
        spawnDepth: 1,
      }),
      makeSession({
        sessionId: "child-2",
        parentSessionId: "child-1",
        spawnDepth: 1,
      }),
      makeSession({
        sessionId: "other-root",
      }),
    ];

    expect(orderSessionsForSidebar(sessions).map((session) => session.sessionId)).toEqual([
      "child-1",
      "child-2",
      "other-root",
    ]);
  });
});
