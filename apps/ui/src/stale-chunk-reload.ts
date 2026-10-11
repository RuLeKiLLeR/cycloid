/**
 * After a deploy, Cloudflare Pages only serves assets from the latest deployment.
 * If a user has a stale tab open, dynamic imports (datadog, sentry, api.ts, etc.)
 * will try to fetch old hashed chunks that no longer exist and get 404s.
 *
 * This module detects those failures and forces a bounded page reload so the
 * browser picks up the new index.html and its updated asset references.
 */

const LEGACY_RELOAD_KEY = "stale-chunk-reload";
const RELOAD_TS_KEY = "stale-chunk-reload-ts";
const RELOAD_COUNT_KEY = "stale-chunk-reload-count";
const PENDING_RELOAD_TELEMETRY_KEY = "stale-chunk-reload-pending";
const MIN_INTERVAL_MS = 60_000;
const MAX_ATTEMPTS = 3;
const PRELOAD_RELOAD_DELAY_MS = 750;
const ASSET_URL_RE = /((?:https?:\/\/[^/\s"')]+)?\/assets\/[^\s"')]+?\.(?:js|css))(?:[?#][^\s"')]*)?/i;

export const STALE_CHUNK_UNRECOVERABLE_EVENT = "stale-chunk-unrecoverable";

type ReloadGuard = {
  last: number;
  count: number;
};

type ReloadTelemetry = {
  assetUrl: string | null;
  uaSummary: string;
  pageSinceMs: number;
  attempt: number;
  reloadAtMs: number;
};

let memLastMs = 0;
let memCount = 0;
let pendingPreloadReloadTimer: number | null = null;
let unrecoverableLatched = false;

/**
 * Returns true if a stale-chunk failure has already exhausted recovery this page.
 * Lets late-mounted listeners detect events that fired before the listener attached
 * (e.g. when reloadIfStaleImport runs before React mounts).
 */
export function hasStaleChunkUnrecoverableFired(): boolean {
  return unrecoverableLatched;
}

function getSessionStorage(): Storage | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

function parseStoredNumber(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readGuard(): ReloadGuard {
  const storage = getSessionStorage();
  if (!storage) return { last: memLastMs, count: memCount };

  try {
    return {
      last: parseStoredNumber(storage.getItem(RELOAD_TS_KEY), memLastMs),
      count: parseStoredNumber(storage.getItem(RELOAD_COUNT_KEY), memCount),
    };
  } catch {
    return { last: memLastMs, count: memCount };
  }
}

function writeGuard(last: number, count: number): boolean {
  memLastMs = last;
  memCount = count;

  const storage = getSessionStorage();
  if (!storage) return false;

  try {
    storage.setItem(RELOAD_TS_KEY, String(last));
    storage.setItem(RELOAD_COUNT_KEY, String(count));
    return true;
  } catch {
    // In-memory guard state above still bounds reloads for this page lifetime.
    return false;
  }
}

export function clearReloadGuard() {
  memLastMs = 0;
  memCount = 0;

  const storage = getSessionStorage();
  if (storage) {
    try {
      storage.removeItem(RELOAD_TS_KEY);
      storage.removeItem(RELOAD_COUNT_KEY);
    } catch {
      // Storage cleanup is best-effort.
    }
  }
}

function getErrorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    return typeof message === "string" ? message : "";
  }
  return "";
}

function extractAssetUrlFromMessage(message: string): string | null {
  const match = ASSET_URL_RE.exec(message);
  if (!match) return null;
  return sanitizeAssetUrl(match[1] ?? null);
}

function extractAssetUrlFromError(err: unknown): string | null {
  return extractAssetUrlFromMessage(getErrorMessage(err));
}

function sanitizeAssetUrl(assetUrl: string | null): string | null {
  if (!assetUrl) return null;

  try {
    const url = new URL(assetUrl, window.location.href);
    if (url.origin !== window.location.origin) return null;
    if (!url.pathname.startsWith("/assets/")) return null;
    if (!/\.(?:js|css)$/i.test(url.pathname)) return null;
    return url.pathname;
  } catch {
    return null;
  }
}

function getAssetUrl(target: EventTarget | null): string | null {
  if (!target || typeof target !== "object") return null;

  const node = target as { tagName?: string; href?: string; src?: string };
  const tagName = node.tagName?.toLowerCase();
  if (tagName === "link") return node.href ?? null;
  if (tagName === "script") return node.src ?? null;
  return null;
}

// Different browsers use different error messages for the same stale import:
//   Chrome/Firefox: "Failed to fetch dynamically imported module"
//   Firefox:        "error loading dynamically imported module"
//   Safari/WebKit:  "Importing a module script failed" (also all iOS browsers via WebKit)
// Safari's generic "Load failed" is deliberately NOT matched here: WebKit uses it
// for ALL network failures (including normal fetch() rejections), not just dynamic
// imports, so matching it turned any Safari/iOS API blip into a spurious full-page
// reload. Genuine stale chunks still recover via the resource-error and
// vite:preloadError listeners below, which key off the asset URL, not the message.
export function isDynamicImportError(err: unknown): boolean {
  const msg = getErrorMessage(err);
  return (
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("error loading dynamically imported module") ||
    msg.includes("Importing a module script failed") ||
    msg.includes("Unable to preload CSS for")
  );
}

function summarizeUa(ua: string): string {
  const patterns: Array<[RegExp, string]> = [
    [/Edg\/(\d+)/, "Edge"],
    [/OPR\/(\d+)/, "Opera"],
    [/Chrome\/(\d+)/, "Chromium"],
    [/Firefox\/(\d+)/, "Firefox"],
    [/Version\/(\d+).*Safari/, "WebKit"],
    [/AppleWebKit\/(\d+)/, "WebKit"],
  ];

  for (const [pattern, browser] of patterns) {
    const match = pattern.exec(ua);
    if (match?.[1]) return `${browser}/${match[1]}`;
  }
  return "unknown";
}

function recordReloadTelemetry(assetUrl: string | null, attempt: number) {
  const storage = getSessionStorage();
  if (!storage) return;

  try {
    const payload: ReloadTelemetry = {
      assetUrl: sanitizeAssetUrl(assetUrl),
      uaSummary: typeof navigator === "undefined" ? "unknown" : summarizeUa(navigator.userAgent),
      pageSinceMs: typeof performance === "undefined" ? 0 : Math.round(performance.now()),
      attempt,
      reloadAtMs: Date.now(),
    };
    storage.setItem(PENDING_RELOAD_TELEMETRY_KEY, JSON.stringify(payload));
  } catch {
    // Recovery must not depend on telemetry.
  }
}

function dispatchUnrecoverable() {
  unrecoverableLatched = true;
  window.dispatchEvent(new CustomEvent(STALE_CHUNK_UNRECOVERABLE_EVENT));
}

function reloadOnce(assetUrl?: string | null): boolean {
  const { last, count } = readGuard();
  const now = Date.now();

  if (count >= MAX_ATTEMPTS) {
    console.warn("[stale-chunk-reload] max attempts reached; surfacing manual recovery");
    dispatchUnrecoverable();
    return false;
  }

  if (now - last < MIN_INTERVAL_MS) {
    console.debug("[stale-chunk-reload] skipped: within cooldown window");
    return false;
  }

  const nextCount = count + 1;
  if (!writeGuard(now, nextCount)) {
    // Without persisted guard state, a page reload would reset the in-memory
    // counter and could loop indefinitely on the same stale asset.
    console.warn("[stale-chunk-reload] guard storage unavailable; surfacing manual recovery");
    dispatchUnrecoverable();
    return false;
  }

  recordReloadTelemetry(assetUrl ?? null, nextCount);
  window.location.reload();
  return true;
}

/**
 * Call from .catch() handlers on dynamic imports (e.g. sentry, datadog) so that
 * handled rejections still trigger a stale-chunk reload.
 */
export function reloadIfStaleImport(err: unknown) {
  if (!isDynamicImportError(err)) return false;
  reloadOnce(extractAssetUrlFromError(err));
  return true;
}

export function clearPendingPreloadReload() {
  if (pendingPreloadReloadTimer === null) return;
  window.clearTimeout(pendingPreloadReloadTimer);
  pendingPreloadReloadTimer = null;
}

function schedulePreloadReload(assetUrl: string | null) {
  clearPendingPreloadReload();
  pendingPreloadReloadTimer = window.setTimeout(() => {
    pendingPreloadReloadTimer = null;
    reloadOnce(assetUrl);
  }, PRELOAD_RELOAD_DELAY_MS);
}

function removeLegacyReloadKey() {
  const storage = getSessionStorage();
  if (!storage) return;

  try {
    storage.removeItem(LEGACY_RELOAD_KEY);
  } catch {
    // Best-effort cleanup only.
  }
}

export function flushPendingReloadTelemetry() {
  const storage = getSessionStorage();
  if (!storage) return;

  let raw: string | null = null;
  try {
    raw = storage.getItem(PENDING_RELOAD_TELEMETRY_KEY);
  } catch {
    return;
  }
  if (!raw) return;

  try {
    storage.removeItem(PENDING_RELOAD_TELEMETRY_KEY);
  } catch {
    // Continue; at worst a later page load may report this again.
  }

  let payload: Partial<ReloadTelemetry> = {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") payload = parsed as Partial<ReloadTelemetry>;
  } catch {
    return;
  }

  const assetUrl = typeof payload.assetUrl === "string" ? sanitizeAssetUrl(payload.assetUrl) : null;
  const attempt =
    typeof payload.attempt === "number" && Number.isFinite(payload.attempt) ? String(payload.attempt) : "unknown";
  const uaSummary = typeof payload.uaSummary === "string" ? payload.uaSummary : "unknown";

  import("./sentry")
    .then(({ captureUiError }) =>
      captureUiError(new Error("stale-chunk-reload"), {
        assetUrl: assetUrl ?? "unknown",
        attempt,
        uaSummary,
      }),
    )
    .catch(() => {
      // Recovery must not depend on telemetry.
    });
}

export function handleStaleChunks() {
  removeLegacyReloadKey();

  // Covers initial stylesheet/script 404s when index.html points at a stale hash.
  window.addEventListener(
    "error",
    (event) => {
      const assetUrl = sanitizeAssetUrl(getAssetUrl(event.target));
      if (assetUrl) reloadOnce(assetUrl);
    },
    true,
  );

  // Vite 6 dispatches a cancelable event and throws only when default is not
  // prevented. Let the import promise reject so lazyWithRetry can run, but keep
  // a delayed fallback for non-lazy import callers.
  window.addEventListener("vite:preloadError", (event) => {
    const preloadEvent = event as Event & { payload?: unknown };
    schedulePreloadReload(extractAssetUrlFromError(preloadEvent.payload));
  });

  // Catches dynamic import() failures not covered by Vite's preload helper.
  window.addEventListener("unhandledrejection", (event) => {
    if (isDynamicImportError(event.reason)) reloadOnce(extractAssetUrlFromError(event.reason));
  });
}
