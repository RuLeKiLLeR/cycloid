import { describe, expect, it } from "vitest";

import { AGENT_RUNTIME_BACKENDS } from "../../shared/agent/agent-runtime-backend.js";
import {
  type AgentRuntimeCapability,
  BACKEND_CAPABILITIES,
  type BackendCapabilities,
  backendSupports,
  BRIDGE_EVENT_CAPABILITY_BY_EVENT_TYPE,
  type CapabilitySupport,
} from "../../shared/agent/backend-capabilities.js";

const CAPABILITIES = [
  "cycloidMcpTools",
  "fileEditBashTools",
  "toolSafetyGates",
  "memoryRecallTelemetry",
  "multimodalInput",
  "followupContinuation",
  "crossSandboxResume",
  "verificationV2",
  "reviewLoop",
  "prodSelectability",
  "reasoningOutput",
  "tokenUsageEvents",
  "questionReplies",
  "variantReasoning",
  "patchEvents",
  "retryStatusEvents",
  "todoUpdateEvents",
  "planTurnReadOnly",
] satisfies Array<keyof BackendCapabilities>;

describe("backend capabilities", () => {
  it("declares every capability for every backend", () => {
    expect(Object.keys(BACKEND_CAPABILITIES).sort()).toEqual([...AGENT_RUNTIME_BACKENDS].sort());
    for (const backend of AGENT_RUNTIME_BACKENDS) {
      expect(Object.keys(BACKEND_CAPABILITIES[backend]).sort()).toEqual([...CAPABILITIES].sort());
    }
  });

  it("requires every unsupported capability to carry a rationale, and a gap ticket when status is gap", () => {
    for (const backend of AGENT_RUNTIME_BACKENDS) {
      for (const capability of CAPABILITIES) {
        const support: CapabilitySupport = BACKEND_CAPABILITIES[backend][capability] as CapabilitySupport;
        if (support.supported) continue;
        expect(support.status).toMatch(/^(partial|intentional|gap)$/);
        expect(support.rationale.trim().length).toBeGreaterThan(0);
        if (support.status === "gap") {
          expect(support.ticket?.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("returns the declared support value", () => {
    for (const backend of AGENT_RUNTIME_BACKENDS) {
      for (const capability of CAPABILITIES) {
        expect(backendSupports(backend, capability)).toBe(BACKEND_CAPABILITIES[backend][capability].supported);
      }
    }
  });

  it("maps asymmetric durable bridge event types to explicit backend capabilities", () => {
    const expected = {
      patch: "patchEvents",
      retry_status: "retryStatusEvents",
      todo_update: "todoUpdateEvents",
    } satisfies Record<string, AgentRuntimeCapability>;

    expect(BRIDGE_EVENT_CAPABILITY_BY_EVENT_TYPE).toEqual(expected);
  });
});
