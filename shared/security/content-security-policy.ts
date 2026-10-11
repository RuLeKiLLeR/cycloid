const BASE_CONNECT_SRC = [
  "'self'",
  "https://app.trycycloid.com",
  "wss://app.trycycloid.com",
  "https://sentry.io",
  "https://*.sentry.io",
  "https://browser-intake-datadoghq.com",
  "https://browser-intake-us3-datadoghq.com",
  "https://browser-intake-us5-datadoghq.com",
  "https://browser-intake-datadoghq.eu",
  "https://browser-intake-ap1-datadoghq.com",
  "https://browser-intake-ap2-datadoghq.com",
  "https://browser-intake-ddog-gov.com",
  "https://pci.browser-intake-datadoghq.com",
] as const;

const LOCAL_CONNECT_SRC = ["http://localhost:*", "ws://localhost:*", "http://127.0.0.1:*", "ws://127.0.0.1:*"] as const;

const IMG_SRC = ["'self'", "data:", "blob:", "https://avatars.githubusercontent.com"] as const;

const FORM_ACTION_SRC = ["'self'", "https://github.com", "https://linear.app", "https://slack.com"] as const;

const TURNSTILE_SRC = "https://challenges.cloudflare.com";

export interface ContentSecurityPolicyOptions {
  includeLocalDev?: boolean;
  // Caller must validate this before passing it; this builder only interpolates
  // values from trusted chokepoints such as applyStandardHeaders.
  scriptNonce?: string;
}

export function buildContentSecurityPolicy(options: ContentSecurityPolicyOptions = {}): string {
  const connectSrc = options.includeLocalDev ? [...BASE_CONNECT_SRC, ...LOCAL_CONNECT_SRC] : [...BASE_CONNECT_SRC];
  const scriptSrc = ["'self'", TURNSTILE_SRC];
  if (options.scriptNonce) scriptSrc.push(`'nonce-${options.scriptNonce}'`);

  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    `frame-src ${TURNSTILE_SRC}`,
    `script-src ${scriptSrc.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${IMG_SRC.join(" ")}`,
    "font-src 'self'",
    "media-src 'self'",
    "worker-src 'self' blob:",
    `connect-src ${connectSrc.join(" ")}`,
    `form-action ${FORM_ACTION_SRC.join(" ")}`,
  ];

  if (!options.includeLocalDev) {
    directives.push("upgrade-insecure-requests");
  }

  return directives.join("; ");
}
