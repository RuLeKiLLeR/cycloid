import { createRoot } from "react-dom/client";

import { type AuthProbeResult, fetchIsAuthenticated } from "./api/auth-probe";
import { DD_ACTION_BOOT_AUTH_PREFETCH } from "./constants/datadog";
import { restoreDevAuthenticatedPath } from "./dev-authenticated-shell";
import {
  clearReloadGuard,
  flushPendingReloadTelemetry,
  handleStaleChunks,
  reloadIfStaleImport,
} from "./stale-chunk-reload";

type AuthenticatedAppResult = { module: typeof import("./authenticated-app") } | { error: unknown };

/**
 * Eager-prefetch tradeoff (ARC-1333, follow-up to #5580):
 *
 * We kick off the auth probe and the authenticated-app bundle import in
 * parallel below. This trades a small upfront cost for a meaningful win on
 * the common path.
 *
 * - Win: signed-in visitors (the dominant case) hit the app with the bundle
 *   already in flight, so first authenticated render is materially faster.
 * - Cost: signed-out first-time visitors download the authenticated-app
 *   bundle they never use. The module is discarded after the auth probe
 *   resolves "not authenticated".
 *
 * We accept the cost because signed-in is the dominant boot. We emit
 * `ui.boot.auth_prefetch` ({ used: boolean }) once per boot so we can watch
 * the used/total ratio in Datadog RUM. Revisit (gate the import behind the
 * auth probe, or split the authenticated bundle further) if either:
 *   - the signed-out share of boots rises materially, or
 *   - the authenticated-app initial chunk grows past a size threshold that
 *     makes the wasted bytes user-visible on slow networks.
 */
function reportAuthPrefetchOutcome(status: AuthProbeResult<void>["status"]) {
  // Lazy-load the datadog module so the bootstrap path stays light and so
  // tests that import main.tsx don't pull the RUM SDK transitively.
  //
  // We must call initDatadog() here, not just trackAction(). On signed-out
  // and probe-failure paths, authenticated-app.tsx never renders, so its
  // post-paint initDatadog() call never fires. Without initializing here,
  // the trackAction queues into pendingRumOperations and is never flushed —
  // the resulting RUM stream would only contain used:true events, biasing
  // the ratio to 100% and defeating the measurement. initDatadog() is
  // idempotent, so the authenticated path's post-paint call still works.
  import("./datadog")
    .then(({ initDatadog, trackAction }) => {
      trackAction(DD_ACTION_BOOT_AUTH_PREFETCH, { status, used: status === "authenticated" });
      return initDatadog();
    })
    .catch((error) => {
      console.error("[app] Failed to report auth prefetch outcome:", error);
    });
}

async function bootstrap() {
  if (import.meta.env.DEV) restoreDevAuthenticatedPath();
  handleStaleChunks();
  flushPendingReloadTelemetry();

  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Missing root element");

  const root = createRoot(rootElement);
  const path = window.location.pathname;
  if (path === "/pending" || path === "/denied") {
    clearReloadGuard();
    const { renderPendingApproval } = await import("./public-boot");
    renderPendingApproval(root, path === "/pending" ? "pending" : "denied");
    return;
  }

  // Kick off both auth probe and the authenticated bundle in parallel so the
  // bundle starts downloading before auth resolves. If auth resolves to
  // signed-out we discard the unused module; if it resolves authenticated we
  // already have the bundle ready to render.
  const authStatusPromise = fetchIsAuthenticated();
  const appPromise = import("./authenticated-app").then(
    (module): AuthenticatedAppResult => ({ module }),
    (error): AuthenticatedAppResult => ({ error }),
  );

  const authResult = await authStatusPromise;

  reportAuthPrefetchOutcome(authResult.status);

  if (authResult.status === "unauthenticated") {
    clearReloadGuard();
    const { renderPublicBoot } = await import("./public-boot");
    renderPublicBoot(root, "signed_out");
    return;
  }

  if (authResult.status === "transient") {
    const { renderPublicBoot } = await import("./public-boot");
    renderPublicBoot(root, "checking");
    return;
  }

  try {
    const appResult = await appPromise;
    if ("error" in appResult) throw appResult.error;
    appResult.module.renderAuthenticatedApp(root);
  } catch (err) {
    console.error("[app] Authenticated app load failed:", err);
    reloadIfStaleImport(err);
    const { renderPublicBoot } = await import("./public-boot");
    renderPublicBoot(root, "failed");
  }
}

bootstrap().catch((err) => {
  console.error("[app] Bootstrap failed:", err);
  globalThis.setTimeout(() => {
    throw err;
  }, 0);
});
