import { ENVIRONMENT, normalizeEnvironment } from "../../../../shared/constants/environment.js";
import { CONTROL_PLANE_SERVICE_NAME } from "../constants/observability";
import type { Env } from "../types";

// The low-cardinality base tag trio every control-plane Datadog COUNT series
// shares: service, worker, and the normalized environment. A FUNCTION (not a
// const) because `env:` derives from `env.WORKER_ENV` at call time. Callers
// append their own site-specific dimension tags after the trio. Datadog treats
// a series' tags as an unordered set, so the trio's position within the array
// does not affect which time series a point lands on.
export function baseControlPlaneMetricTags(env: Pick<Env, "WORKER_ENV">): string[] {
  return [
    `service:${CONTROL_PLANE_SERVICE_NAME}`,
    "worker:control-plane",
    `env:${normalizeEnvironment(env.WORKER_ENV, ENVIRONMENT.Production)}`,
  ];
}
