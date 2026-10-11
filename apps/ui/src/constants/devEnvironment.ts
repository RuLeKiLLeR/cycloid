// Product-language presentation for the per-repo dev environment surface
// (RepositorySandboxSettings). Maps internal sandbox-layer identifiers from the
// control plane onto human-readable labels. Raw keys come from
// apps/control-plane-worker/src/sandbox/layer-db.ts (build statuses),
// layer-source-service.ts (failure phases), and layer-resource-profile.ts
// (resource profile keys).

import type { BadgeTone } from "../components/ui";

/** How many builds the environment history list requests. */
export const SANDBOX_BUILD_HISTORY_LIMIT = 20;

/** How many log chunks the failure diagnostics view requests per build. */
export const SANDBOX_BUILD_LOG_CHUNK_LIMIT = 20;

/** How long the "Copied" confirmation stays on the copy button. */
export const TEMPLATE_ID_COPY_RESET_MS = 1600;

/** Where a repo's custom environment definition came from. */
export const SANDBOX_TIER_LABELS: Record<"repo_local" | "repo_assignment" | "business_default", string> = {
  repo_local: "configured in this repo",
  repo_assignment: "assigned to this repo",
  business_default: "the workspace default",
};

export type SandboxBuildStatusMeta = {
  label: string;
  tone: BadgeTone;
  /** True while the control plane is still working on the build. */
  inProgress: boolean;
};

// Mirrors SandboxLayerBuildStatus in the control plane. In-progress states use
// the live (accent) tone: a running build is genuine liveness per DESIGN.md.
const SANDBOX_BUILD_STATUS_META: Record<string, SandboxBuildStatusMeta> = {
  validated: { label: "Queued", tone: "accent", inProgress: true },
  queued: { label: "Queued", tone: "accent", inProgress: true },
  validating: { label: "Validating", tone: "accent", inProgress: true },
  building_provider: { label: "Building", tone: "accent", inProgress: true },
  polling_provider: { label: "Building", tone: "accent", inProgress: true },
  smoke_testing: { label: "Verifying", tone: "accent", inProgress: true },
  completed: { label: "Succeeded", tone: "success", inProgress: false },
  failed: { label: "Failed", tone: "error", inProgress: false },
  canceled: { label: "Canceled", tone: "default", inProgress: false },
};

const UNKNOWN_BUILD_STATUS_META: SandboxBuildStatusMeta = { label: "Unknown", tone: "default", inProgress: false };

/** Presentation for a raw build status; unknown statuses render as a neutral "Unknown". */
export function sandboxBuildStatusMeta(status: string): SandboxBuildStatusMeta {
  return SANDBOX_BUILD_STATUS_META[status] ?? UNKNOWN_BUILD_STATUS_META;
}

/** Which step of the environment build failed, in product language. */
export const SANDBOX_FAILURE_PHASE_LABELS: Record<string, string> = {
  validation: "Config validation",
  provider_build: "Image build",
  smoke: "Setup check",
  runtime: "Runtime",
  unknown: "Unknown step",
};

export function sandboxFailurePhaseLabel(phase: string): string {
  return SANDBOX_FAILURE_PHASE_LABELS[phase] ?? SANDBOX_FAILURE_PHASE_LABELS.unknown!;
}

/**
 * Resource profiles are fixed server-side (a per-repo allowlist in
 * apps/control-plane-worker/src/sandbox/repo-sandbox-specs.ts); the platform
 * does not accept a user-selected tier, and the API exposes only the profile
 * key, not CPU/memory numbers. Present the fixed profile readably: the
 * "default" key is the standard machine, any other key is a larger machine
 * Cycloid configured for that specific repo.
 */
export const DEFAULT_RESOURCE_PROFILE_KEY = "default";

export function resourceProfileDescription(resourceProfileKey: string | null): string {
  return !resourceProfileKey || resourceProfileKey === DEFAULT_RESOURCE_PROFILE_KEY
    ? "Standard machine — Cycloid's default sandbox size."
    : "Expanded machine — a larger sandbox Cycloid configured for this repository.";
}
