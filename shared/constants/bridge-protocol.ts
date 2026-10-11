// Bridge <-> session Durable Object wire protocol version.
//
// Bump this integer when a change breaks compatibility for command/event
// shapes in shared/types/sandbox.ts or the sandbox_session frame.
export const BRIDGE_PROTOCOL_VERSION = 2;

/** First bridge version that understands the distinct code-review agent role. */
export const REVIEW_AGENT_ROLE_BRIDGE_PROTOCOL_VERSION = 2;

export const BRIDGE_PROTOCOL_VERSION_HEADER = "x-bridge-protocol-version";

// Cloudflare Worker version ids are opaque provider values. Keep them bounded
// before they enter logs or metric facets; compare them only for equality.
export const WORKER_VERSION_ID_MAX_LENGTH = 128;
const WORKER_VERSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function normalizeWorkerVersionId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > WORKER_VERSION_ID_MAX_LENGTH) return null;
  return WORKER_VERSION_ID_PATTERN.test(value) ? value : null;
}

export function isWorkerVersionHandoff(input: {
  currentVersionId: string | null;
  persistedVersionId: string | null;
  currentRuntimeSandboxId: string | null;
  persistedRuntimeSandboxId: string | null;
  currentConnectionGeneration: number;
  persistedConnectionGeneration: number;
}): boolean {
  return (
    input.currentVersionId !== null &&
    input.persistedVersionId !== null &&
    input.currentRuntimeSandboxId !== null &&
    input.currentRuntimeSandboxId === input.persistedRuntimeSandboxId &&
    input.currentConnectionGeneration > input.persistedConnectionGeneration &&
    input.currentVersionId !== input.persistedVersionId
  );
}
