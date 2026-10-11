/**
 * The coding-agent runtime axis: which coding CLI/protocol drives the session.
 *
 * This is ORTHOGONAL to the E2B sandbox-provider axis (`SandboxRuntimeBackend` in
 * `shared/types/sandbox.ts` / `RuntimeBackend` in the control plane). A session has
 * both. Never reuse the `runtime_backend` / `RuntimeBackend` / `ARCANIST_RUNTIME_BACKEND`
 * identifiers for this axis — they mean the sandbox provider, not the coding CLI.
 *
 * Lives in `shared/` so both the control plane and the sandbox bridge import the same
 * source of truth (mirrors `shared/agent/constants.ts` and `shared/types/sandbox.ts`).
 */

// Type-only import: erased at runtime, so this does not create a runtime import cycle with
// `shared/constants/models.ts` (which imports the backend enum from this file).
import type { ModelProvider } from "../constants/models.js";

export type AgentRuntimeBackend = "codex" | "claude_code" | "opencode";

export const CODEX_AGENT_RUNTIME_BACKEND = "codex" as const satisfies AgentRuntimeBackend;
export const CLAUDE_CODE_AGENT_RUNTIME_BACKEND = "claude_code" as const satisfies AgentRuntimeBackend;
export const OPENCODE_AGENT_RUNTIME_BACKEND = "opencode" as const satisfies AgentRuntimeBackend;

export const AGENT_RUNTIME_BACKENDS: readonly AgentRuntimeBackend[] = [
  CODEX_AGENT_RUNTIME_BACKEND,
  CLAUDE_CODE_AGENT_RUNTIME_BACKEND,
  OPENCODE_AGENT_RUNTIME_BACKEND,
];

export const AGENT_RUNTIME_BACKEND_NAMES: Record<AgentRuntimeBackend, string> = {
  [CODEX_AGENT_RUNTIME_BACKEND]: "Codex",
  [CLAUDE_CODE_AGENT_RUNTIME_BACKEND]: "Claude Code",
  // "opencode" is intentionally lowercase to match the project's brand name.
  [OPENCODE_AGENT_RUNTIME_BACKEND]: "opencode",
};

export function isAgentRuntimeBackend(value: unknown): value is AgentRuntimeBackend {
  return (AGENT_RUNTIME_BACKENDS as readonly unknown[]).includes(value);
}

/**
 * The agent runtime backends the current E2B sandbox image build installs and advertises.
 * Source of truth for what a freshly built/registered base template supports: the image
 * installs the Codex CLI, the version-locked Claude bridge, and the opencode CLI/SDK, so it
 * advertises all three. A registered base template that does NOT list a backend here (e.g. a
 * legacy image built before opencode was added) makes that backend's spawn preflight fail closed.
 *
 * Listed explicitly (NOT aliased to `AGENT_RUNTIME_BACKENDS`) on purpose: adding a backend to the
 * type union must not silently advertise it from every image. A new backend only becomes advertised
 * once the image actually installs it and it is added here, keeping the fail-closed invariant intact.
 */
export const IMAGE_ADVERTISED_AGENT_RUNTIME_BACKENDS: readonly AgentRuntimeBackend[] = [
  CODEX_AGENT_RUNTIME_BACKEND,
  CLAUDE_CODE_AGENT_RUNTIME_BACKEND,
  OPENCODE_AGENT_RUNTIME_BACKEND,
];

/** Parse a persisted capabilities value (JSON array string) into known agent runtime backends. */
export function parseAgentRuntimeBackendCapabilities(value: unknown): AgentRuntimeBackend[] {
  if (value == null || value === "") return [];
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<AgentRuntimeBackend>();
  for (const entry of raw) {
    if (isAgentRuntimeBackend(entry)) seen.add(entry);
  }
  return AGENT_RUNTIME_BACKENDS.filter((backend) => seen.has(backend));
}

/**
 * Normalize a raw backend value (env var, request field, or persisted column) to a
 * known backend. Defaults to Codex when unset/empty; throws on an unknown non-empty
 * value so callers fail closed instead of silently coercing.
 */
export function resolveAgentRuntimeBackend(value: string | null | undefined): AgentRuntimeBackend {
  if (value === undefined || value === null || value === "") return CODEX_AGENT_RUNTIME_BACKEND;
  if (!isAgentRuntimeBackend(value)) {
    throw new Error(`Unknown agent runtime backend '${value}'`);
  }
  return value;
}

/**
 * Map an agent runtime backend to the model-inference provider that bills its sandbox usage.
 * Used to tag sandbox usage telemetry so spend can be filtered/grouped by provider (e.g. the
 * Baseten spend guardrail filters `provider:baseten`).
 *
 * Returns `null` for an unset or unrecognized backend so callers can decide whether to still
 * emit (with a null provider tag) rather than throw inside a fire-and-forget telemetry path.
 */
export function inferenceProviderForBackend(backend: AgentRuntimeBackend | null | undefined): ModelProvider | null {
  switch (backend) {
    case OPENCODE_AGENT_RUNTIME_BACKEND:
      return "baseten";
    case CODEX_AGENT_RUNTIME_BACKEND:
      return "openai";
    case CLAUDE_CODE_AGENT_RUNTIME_BACKEND:
      return "anthropic";
    default:
      return null;
  }
}
