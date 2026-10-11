import { describe, expect, it } from "vitest";

import type { SessionMetadata } from "../../apps/ui/src/types";
import {
  familyHasWorking,
  familyNeedsInput,
  segmentSidebarFamilies,
  subagentRollup,
} from "../../apps/ui/src/utils/subagent-family.js";
import { displayStatusFromPhase } from "../../shared/session/display-status";

function makeSession(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  const phase = overrides.phase ?? "completed";
  return {
    sessionId: "s",
    phase,
    displayStatus: displayStatusFromPhase(phase),
    prUrl: null,
    createdAt: 0,
    model: null,
    title: "Session",
    ...overrides,
  };
}

const kinds = (items: ReturnType<typeof segmentSidebarFamilies>) =>
  items.map((item) => (item.kind === "family" ? `family:${item.head.sessionId}` : `row:${item.session.sessionId}`));

describe("segmentSidebarFamilies", () => {
  it("keeps a session with no children as a standalone row", () => {
    const items = segmentSidebarFamilies([makeSession({ sessionId: "solo" })]);
    expect(kinds(items)).toEqual(["row:solo"]);
  });

  it("groups a parent with its direct children into one family", () => {
    const items = segmentSidebarFamilies([
      makeSession({ sessionId: "parent" }),
      makeSession({ sessionId: "child-1", parentSessionId: "parent" }),
      makeSession({ sessionId: "child-2", parentSessionId: "parent" }),
    ]);
    expect(kinds(items)).toEqual(["family:parent"]);
    const family = items[0];
    expect(family.kind === "family" && family.descendants.map((d) => d.sessionId)).toEqual(["child-1", "child-2"]);
  });

  it("pulls grandchildren nested under a present child into the same family", () => {
    const items = segmentSidebarFamilies([
      makeSession({ sessionId: "parent" }),
      makeSession({ sessionId: "child", parentSessionId: "parent", spawnDepth: 1 }),
      makeSession({ sessionId: "grandchild", parentSessionId: "child", spawnDepth: 2 }),
    ]);
    expect(kinds(items)).toEqual(["family:parent"]);
    const family = items[0];
    expect(family.kind === "family" && family.descendants.map((d) => d.sessionId)).toEqual(["child", "grandchild"]);
  });

  it("separates two adjacent families", () => {
    const items = segmentSidebarFamilies([
      makeSession({ sessionId: "p1" }),
      makeSession({ sessionId: "c1", parentSessionId: "p1" }),
      makeSession({ sessionId: "p2" }),
      makeSession({ sessionId: "c2", parentSessionId: "p2" }),
    ]);
    expect(kinds(items)).toEqual(["family:p1", "family:p2"]);
  });

  it("renders a child whose parent is in another bucket as a standalone row", () => {
    // Parent bucketed into a different recency group is simply absent here.
    const items = segmentSidebarFamilies([makeSession({ sessionId: "orphan", parentSessionId: "absent-parent" })]);
    expect(kinds(items)).toEqual(["row:orphan"]);
  });

  it("treats a self-parented session as its own head, not a descendant", () => {
    const items = segmentSidebarFamilies([
      makeSession({ sessionId: "self", parentSessionId: "self" }),
      makeSession({ sessionId: "next" }),
    ]);
    expect(kinds(items)).toEqual(["row:self", "row:next"]);
  });
});

describe("subagentRollup", () => {
  it("names the working count when any child is working", () => {
    expect(
      subagentRollup([
        makeSession({ phase: "running" }),
        makeSession({ phase: "running" }),
        makeSession({ phase: "completed" }),
      ]),
    ).toBe("2 working");
  });

  it("reads 'all done' when every child is completed", () => {
    expect(subagentRollup([makeSession({ phase: "completed" }), makeSession({ phase: "review_listening" })])).toBe(
      "all done",
    );
  });

  it("falls back to dots only (empty string) for a mixed terminal family", () => {
    expect(subagentRollup([makeSession({ phase: "completed" }), makeSession({ phase: "stopped" })])).toBe("");
  });
});

describe("family status predicates", () => {
  it("flags a family that needs input", () => {
    expect(familyNeedsInput([makeSession({ phase: "completed" }), makeSession({ phase: "waiting_for_input" })])).toBe(
      true,
    );
    expect(familyNeedsInput([makeSession({ phase: "running" })])).toBe(false);
  });

  it("flags a family with active work", () => {
    expect(familyHasWorking([makeSession({ phase: "running" })])).toBe(true);
    expect(familyHasWorking([makeSession({ phase: "completed" }), makeSession({ phase: "stopped" })])).toBe(false);
  });
});
