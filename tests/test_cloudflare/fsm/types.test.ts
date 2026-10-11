// Const-completeness tests for the ARC-1330 lifecycle-FSM type contract (PR 4).
// Pure types: this suite pins the runtime const arrays that the rest of the FSM
// stack (notably the PR 19 dispatch table) relies on — exactly 17 states and
// exactly 40 events, with the verification-named (NOT qa-*) vocabulary, and
// EventMetadata one-variant-per-event. The static type-level assertions that
// prove the union ↔ array completeness live inside types.ts (src/ is the only
// typechecked surface); this file is the runtime mirror of those guarantees.
import { describe, expect, it } from "vitest";

import {
  EVENT_METADATA_TYPES,
  FSM_EVENT_TYPES,
  FSM_STATES,
} from "../../../apps/control-plane-worker/src/session/fsm/types";

const EXPECTED_STATES = [
  "CREATED",
  "PROVISIONING",
  "GENERATING",
  "AWAITING_INPUT",
  "FINALIZING",
  "PUBLISHING",
  "ANSWERED_NO_PR",
  "REVIEW",
  "VERIFYING",
  "MERGE_READY",
  "NEEDS_YOU",
  "FAILED",
  "STOPPED",
  "MERGED",
  "CLOSED",
  "SUPERSEDED",
  "ARCHIVED",
] as const;

const EXPECTED_EVENT_TYPES = [
  "sandbox.spawn_requested",
  "sandbox.ready",
  "sandbox.spawn_failed",
  "sandbox.death",
  "sandbox.liveness_expired",
  "prompt.enqueued",
  "prompt.awaiting_input",
  "prompt.terminal",
  "prompt.max_duration_exceeded",
  "postexec.done",
  "publish.pr_opened",
  "publish.no_changes",
  "publish.failed",
  "publish.superseded",
  "user.input",
  "user.stop",
  "user.retrigger",
  "session.archived",
  "ci.signal",
  "review.received",
  "review.item_ready",
  "epoch.committed",
  "epoch.replied",
  "epoch.declined",
  "epoch.blocked",
  "epoch.deferred",
  "epoch.settled",
  "caught_up",
  "verification.pass",
  "verification.app_breaks",
  "verification.skipped",
  "verification.stopped",
  "verification.failed",
  "verification.run_limit",
  "verification.requested",
  "head.changed",
  "head.noop_changed",
  "pr.merged",
  "pr.closed",
  "deadline_exceeded",
] as const;

describe("FSM_STATES", () => {
  it("has exactly 17 entries with no duplicates", () => {
    expect(FSM_STATES).toHaveLength(17);
    expect(new Set(FSM_STATES).size).toBe(17);
  });

  it("matches the expected state set exactly", () => {
    expect(new Set(FSM_STATES)).toEqual(new Set(EXPECTED_STATES));
  });

  it("includes the collapsed VERIFYING and REVIEW states", () => {
    expect(FSM_STATES).toContain("VERIFYING");
    expect(FSM_STATES).toContain("REVIEW");
  });

  it("does NOT carry the conceptual/pre-collapse state names", () => {
    expect(FSM_STATES).not.toContain("QA");
    expect(FSM_STATES).not.toContain("CI_REVIEW");
    expect(FSM_STATES).not.toContain("CODE_REVIEW");
  });
});

describe("FSM_EVENT_TYPES", () => {
  it("has exactly 40 entries with no duplicates", () => {
    expect(FSM_EVENT_TYPES).toHaveLength(40);
    expect(new Set(FSM_EVENT_TYPES).size).toBe(40);
  });

  it("equals the expected §5 event-name set (the PR 19 completeness check)", () => {
    expect(new Set(FSM_EVENT_TYPES)).toEqual(new Set(EXPECTED_EVENT_TYPES));
  });

  it("uses verification.* names, never qa.* names", () => {
    expect(FSM_EVENT_TYPES).toContain("verification.pass");
    for (const type of FSM_EVENT_TYPES) {
      expect(type.startsWith("qa.")).toBe(false);
    }
  });

  it("does NOT model qa.requested (verification.requested is the explicit request event)", () => {
    expect(FSM_EVENT_TYPES).not.toContain("qa.requested");
    expect(FSM_EVENT_TYPES).toContain("verification.requested");
  });
});

describe("EVENT_METADATA_TYPES", () => {
  it("has exactly 40 entries with no duplicates", () => {
    expect(EVENT_METADATA_TYPES).toHaveLength(40);
    expect(new Set(EVENT_METADATA_TYPES).size).toBe(40);
  });

  it("is the SAME set as FSM_EVENT_TYPES (one metadata variant per event)", () => {
    expect(new Set(EVENT_METADATA_TYPES)).toEqual(new Set(FSM_EVENT_TYPES));
  });

  it("does NOT carry a qa.requested metadata variant", () => {
    expect(EVENT_METADATA_TYPES).not.toContain("qa.requested");
  });
});
