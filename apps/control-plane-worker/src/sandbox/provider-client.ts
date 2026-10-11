import type {
  E2BClientConfig,
  E2BConnectedSandbox,
  E2BCreateSandboxRequest,
  E2BCreateSandboxResponse,
  E2BListedSandbox,
  E2BSandboxInfoResult,
  RunCommandRequest,
  RunCommandResult,
  SandboxTerminateReason,
  StartCommandRequest,
} from "./e2b-client";
import { E2BSandboxClient } from "./e2b-client";
import { type FreestyleClientConfig, FreestyleSandboxClient } from "./freestyle-client";
import {
  E2B_CLOUD_RUNTIME_BACKEND,
  FREESTYLE_RUNTIME_BACKEND,
  isValidRuntimeBackend,
  type RuntimeBackend,
} from "./runtime-backend";

// Provider-neutral aliases over the E2B-concrete types. They are structurally
// identical; the alias names are the surface a second provider targets.
// CreateSandboxResponse.runtimeProvider is `SandboxRuntimeProvider` (the E2B client
// returns "e2b", the Freestyle client returns "freestyle") — an honest, telemetry-only
// vendor tag; persistence derives `runtime_provider` from `runtime_backend` instead.
export type CreateSandboxRequest = E2BCreateSandboxRequest;
export type CreateSandboxResponse = E2BCreateSandboxResponse;
export type ListedSandbox = E2BListedSandbox;
export type ConnectedSandbox = E2BConnectedSandbox;
export type SandboxInfoResult = E2BSandboxInfoResult;

/**
 * The swappable runtime-client surface. Exactly the 9 public methods of
 * E2BSandboxClient. `E2BSandboxClient implements SandboxProviderClient` proves
 * coverage at compile time.
 */
export interface SandboxProviderClient {
  createSandbox(request: CreateSandboxRequest): Promise<CreateSandboxResponse>;
  listCycloidSandboxes(): Promise<ListedSandbox[]>;
  connectSandbox(runtimeSandboxId: string, timeoutMs: number): Promise<ConnectedSandbox>;
  refreshSandbox(
    runtimeSandboxId: string,
    durationMs: number,
  ): Promise<{ status: "refreshed"; refreshedUntil?: number | null }>;
  runCommand(request: RunCommandRequest): Promise<RunCommandResult>;
  startCommand(request: StartCommandRequest): Promise<{ pid: number; startedAt: number }>;
  pauseSandbox(runtimeSandboxId: string): Promise<{ status: "paused" }>;
  terminateSandbox(runtimeSandboxId: string, reason: SandboxTerminateReason): Promise<{ status: "killed" | "missing" }>;
  getSandboxInfo(runtimeSandboxId: string, options?: { requestTimeoutMs?: number }): Promise<SandboxInfoResult>;
}

// Union of the per-backend client configs. The factory dispatches on `backend`, so
// each arm narrows to its own config shape; callers pass the config matching the
// backend they request. The E2B arm is byte-identical in behavior to before.
export type SandboxProviderClientConfig = E2BClientConfig | FreestyleClientConfig;

/**
 * Construct the runtime client for a resolved backend. `e2b_cloud` constructs the
 * same E2BSandboxClient the call sites used to `new` inline; `freestyle` constructs a
 * FreestyleSandboxClient (dogfood-scoped). The config is the union
 * `SandboxProviderClientConfig`; each arm narrows to the shape for its backend.
 */
export function createSandboxProviderClient(
  backend: RuntimeBackend,
  config: SandboxProviderClientConfig,
): SandboxProviderClient {
  if (!isValidRuntimeBackend(backend)) {
    throw new Error(`Unknown runtime backend: ${String(backend)}`);
  }
  switch (backend) {
    case E2B_CLOUD_RUNTIME_BACKEND:
      return new E2BSandboxClient(config as E2BClientConfig);
    case FREESTYLE_RUNTIME_BACKEND:
      return new FreestyleSandboxClient(config as FreestyleClientConfig);
  }
}
