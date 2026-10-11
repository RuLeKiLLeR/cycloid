// Sentence-case display labels for raw repo-context enums (Context page).
// Unknown values fall back to the raw string at the call site so a new server
// state is never hidden, only unpolished.

import type { RepoContextMcpServer } from "../api/repo-context";

/** MCP server validation states (`RepoContextMcpServer["validationStatus"]`). */
export const MCP_VALIDATION_STATUS_LABELS: Record<RepoContextMcpServer["validationStatus"], string> = {
  valid: "Valid",
  untested: "Untested",
  validating: "Validating",
  invalid: "Invalid",
};

/** Sandbox layer source states (`SandboxLayerSourceStatus` on the control plane). */
export const LAYER_SOURCE_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  blocked: "Blocked",
};

/**
 * UI-owned copy for the Context page's runtime-resolved buckets. The server
 * notes on the repo-context payload describe storage internals ("not persisted
 * in D1", column names); the page renders these plain-language equivalents
 * instead.
 */
export const CONTEXT_RUNTIME_COPY = {
  instructionsTitle: "Read from your repo at session start",
  instructionsDescription:
    "Cycloid reads AGENTS.md, CLAUDE.md, and other instruction files fresh from your repository when a session starts. Cycloid doesn't store them, so there is nothing to list here.",
  skillsTitle: "Read from your repo at session start",
  skillsDescription:
    "Cycloid reads skills (SKILL.md files) fresh from your repository when a session starts. Cycloid doesn't store them, so there is nothing to list here.",
  setupDescription:
    "The sandbox environment assigned to this repository. Detailed setup and build commands run inside the sandbox and aren't listed here.",
} as const;
