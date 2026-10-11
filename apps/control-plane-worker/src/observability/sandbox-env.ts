import { buildTracingReadiness, observabilityReadinessFromTracing } from "../../../../shared/observability/trace.js";
import type { ObservabilityReadiness } from "../../../../shared/types/sandbox.js";
import type { Env } from "../types";

const BRAINTRUST_PROJECT = "cycloid";

// Platform telemetry secrets (DD_API_KEY, DD_SITE, BRAINTRUST_API_KEY,
// SENTRY_DSN) and the Braintrust API/APP/ORG config are no longer injected into
// the sandbox env. The sandbox ships telemetry through the control-plane
// telemetry broker, which injects the platform secret server-side. Only the
// non-secret Braintrust project name remains.
type SandboxObservabilityEnv = {
  BRAINTRUST_PROJECT: string;
};

export function resolveSandboxObservabilityEnv(_env: Env): SandboxObservabilityEnv {
  return {
    BRAINTRUST_PROJECT,
  };
}

export function buildSandboxObservabilityReadiness(env: Env): ObservabilityReadiness {
  // DD logs flow via the control-plane telemetry broker, so readiness gates on
  // the WORKER-held DD_API_KEY (the broker no-ops without it — e.g. local dev),
  // not on a sandbox-side key, which is no longer injected.
  return observabilityReadinessFromTracing(buildTracingReadiness({ ddApiKey: Boolean(env.DD_API_KEY) }));
}
