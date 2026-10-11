/**
 * Single source of truth for the runtime environment.
 *
 * The environment is sourced from one of three entry-point env vars depending on surface:
 * - `WORKER_ENV` (control-plane worker, set per deploy in wrangler.toml)
 * - `ARCANIST_RUNTIME_ENVIRONMENT` (in-sandbox mirror of the above)
 * - `VITE_SENTRY_ENV` / `VITE_DD_ENV` / `MODE` (build-time UI signal)
 *
 * Compare against and default to these members instead of bare string literals so the
 * checks are type-checked rather than stringly-typed.
 */
export const ENVIRONMENT = {
  Production: "production",
  Qa: "qa",
  Local: "local",
  Development: "development",
  Test: "test",
} as const;

export type Environment = (typeof ENVIRONMENT)[keyof typeof ENVIRONMENT];

const KNOWN_ENVIRONMENTS = new Set<string>(Object.values(ENVIRONMENT));

/** Type guard: true when `value` is a known environment. */
export function isEnvironment(value: string | undefined): value is Environment {
  return value !== undefined && KNOWN_ENVIRONMENTS.has(value);
}

/**
 * Normalize a raw env-var value to the enum. Unknown or unset values fall back to
 * `fallback`. Callers pass their surface's existing default (worker/bridge: Production,
 * UI: Development) so behavior stays identical to the pre-refactor string literals.
 */
export function normalizeEnvironment(raw: string | undefined, fallback: Environment): Environment {
  return isEnvironment(raw) ? raw : fallback;
}
