/** Datadog RUM configuration constants. */

export const DD_APP_ID = "f508c2d1-8c3b-44a1-bd0f-a19dac5da3b5";
export const DD_CLIENT_TOKEN = "pub600fbaa47cfc044bb30d379b8c58c248";
export const DD_DEFAULT_SITE = "us5.datadoghq.com";
export const DD_SERVICE_NAME = "cycloid-ui";
// RUM query retention must be enabled for the cycloid-prod app in Datadog
// before these events are useful in Explorer or the RUM API.
export const DD_SESSION_SAMPLE_RATE = 20;
// Keep session replay disabled: this stack measures performance waterfalls,
// not screen recordings.
export const DD_REPLAY_SAMPLE_RATE = 0;

/**
 * RUM custom action emitted once per boot after the auth probe resolves. The
 * `used` attribute reports whether the eagerly-prefetched authenticated bundle
 * was actually rendered (true) or wasted on a signed-out visitor (false). See
 * comment in apps/ui/src/main.tsx for the underlying tradeoff (ARC-1333).
 */
export const DD_ACTION_BOOT_AUTH_PREFETCH = "ui.boot.auth_prefetch";
