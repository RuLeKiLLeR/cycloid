import { describe, expect, it } from "vitest";

import {
  DEFAULT_RESOURCE_PROFILE_KEY,
  resourceProfileDescription,
  SANDBOX_FAILURE_PHASE_LABELS,
  SANDBOX_TIER_LABELS,
  sandboxBuildStatusMeta,
  sandboxFailurePhaseLabel,
} from "./devEnvironment";

describe("sandboxBuildStatusMeta", () => {
  it("maps every control-plane build status to a human label", () => {
    // Mirrors SandboxLayerBuildStatus in apps/control-plane-worker/src/sandbox/layer-db.ts.
    const statuses = [
      "validated",
      "queued",
      "validating",
      "building_provider",
      "polling_provider",
      "smoke_testing",
      "completed",
      "failed",
      "canceled",
    ];
    for (const status of statuses) {
      const meta = sandboxBuildStatusMeta(status);
      expect(meta.label, status).not.toBe("Unknown");
      // Labels are product language, never raw snake_case keys.
      expect(meta.label).not.toContain("_");
    }
  });

  it("marks pre-terminal statuses as in progress with the live tone", () => {
    for (const status of ["queued", "validating", "building_provider", "polling_provider", "smoke_testing"]) {
      const meta = sandboxBuildStatusMeta(status);
      expect(meta.inProgress, status).toBe(true);
      expect(meta.tone, status).toBe("accent");
    }
  });

  it("marks terminal statuses as settled with the right tone", () => {
    expect(sandboxBuildStatusMeta("completed")).toMatchObject({ inProgress: false, tone: "success" });
    expect(sandboxBuildStatusMeta("failed")).toMatchObject({ inProgress: false, tone: "error" });
    expect(sandboxBuildStatusMeta("canceled")).toMatchObject({ inProgress: false, tone: "default" });
  });

  it("falls back to a neutral Unknown for unrecognized statuses", () => {
    expect(sandboxBuildStatusMeta("some_future_status")).toEqual({
      label: "Unknown",
      tone: "default",
      inProgress: false,
    });
  });
});

describe("sandboxFailurePhaseLabel", () => {
  it("maps every failure phase to product language", () => {
    for (const phase of ["validation", "provider_build", "smoke", "runtime", "unknown"]) {
      expect(SANDBOX_FAILURE_PHASE_LABELS[phase], phase).toBeTruthy();
      expect(sandboxFailurePhaseLabel(phase)).not.toContain("_");
    }
  });

  it("falls back to the unknown label for unrecognized phases", () => {
    expect(sandboxFailurePhaseLabel("something_else")).toBe(SANDBOX_FAILURE_PHASE_LABELS.unknown);
  });
});

describe("resourceProfileDescription", () => {
  it("describes the default profile as the standard machine", () => {
    expect(resourceProfileDescription(DEFAULT_RESOURCE_PROFILE_KEY)).toContain("Standard machine");
    expect(resourceProfileDescription(null)).toContain("Standard machine");
  });

  it("describes repo-specific profiles as an expanded machine without leaking the key", () => {
    const description = resourceProfileDescription("openevidence/xyla");
    expect(description).toContain("Expanded machine");
    expect(description).not.toContain("openevidence/xyla");
  });
});

describe("SANDBOX_TIER_LABELS", () => {
  it("covers all three resolution tiers", () => {
    expect(Object.keys(SANDBOX_TIER_LABELS).sort()).toEqual(["business_default", "repo_assignment", "repo_local"]);
  });
});
