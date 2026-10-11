import type { AuthProbeResult } from "./api/auth-probe";

export type PublicAuthBootAction = "enable_sign_in" | "keep_checking" | "reload_app";

export function resolvePublicAuthBootAction(
  authResult: AuthProbeResult<void>,
  authenticatedReloadCount: number,
  maxAuthenticatedReloads: number,
): PublicAuthBootAction {
  if (authResult.status === "unauthenticated") return "enable_sign_in";
  if (authResult.status === "transient") return "keep_checking";
  return authenticatedReloadCount < maxAuthenticatedReloads ? "reload_app" : "keep_checking";
}
