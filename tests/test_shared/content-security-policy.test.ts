import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy } from "../../shared/security/content-security-policy";

function directiveValue(policy: string, name: string): string {
  const directive = policy.split("; ").find((part) => part.startsWith(`${name} `));
  if (!directive) throw new Error(`Missing directive: ${name}`);
  return directive.slice(name.length + 1);
}

describe("buildContentSecurityPolicy", () => {
  it("enforces app CSP without script unsafe-inline", () => {
    const policy = buildContentSecurityPolicy();

    expect(directiveValue(policy, "default-src")).toBe("'self'");
    expect(directiveValue(policy, "script-src")).toBe("'self' https://challenges.cloudflare.com");
    expect(directiveValue(policy, "script-src")).not.toContain("'unsafe-inline'");
    expect(directiveValue(policy, "style-src")).toContain("'unsafe-inline'");
    expect(directiveValue(policy, "img-src")).toBe("'self' data: blob: https://avatars.githubusercontent.com");
    expect(directiveValue(policy, "object-src")).toBe("'none'");
    expect(directiveValue(policy, "frame-ancestors")).toBe("'none'");
    expect(directiveValue(policy, "frame-src")).toBe("https://challenges.cloudflare.com");
    expect(policy).toContain("upgrade-insecure-requests");
  });

  it("adds a script nonce when provided", () => {
    const policy = buildContentSecurityPolicy({ scriptNonce: "abc" });

    expect(directiveValue(policy, "script-src")).toBe("'self' https://challenges.cloudflare.com 'nonce-abc'");
    expect(directiveValue(policy, "script-src")).not.toContain("'strict-dynamic'");
  });

  it("allows Sentry, Datadog RUM, WebSocket, and OAuth form targets", () => {
    const policy = buildContentSecurityPolicy();

    const connectSrc = directiveValue(policy, "connect-src");
    expect(connectSrc).toContain("wss://app.trycycloid.com");
    expect(connectSrc).toContain("https://*.sentry.io");
    expect(connectSrc).toContain("https://browser-intake-us5-datadoghq.com");

    const formAction = directiveValue(policy, "form-action");
    expect(formAction).toContain("https://github.com");
    expect(formAction).toContain("https://linear.app");
    expect(formAction).toContain("https://slack.com");
  });

  it("adds local development connect targets only when requested", () => {
    expect(directiveValue(buildContentSecurityPolicy(), "connect-src")).not.toContain("localhost");

    const localPolicy = buildContentSecurityPolicy({ includeLocalDev: true });

    expect(directiveValue(localPolicy, "connect-src")).toContain("ws://localhost:*");
    expect(localPolicy).not.toContain("upgrade-insecure-requests");
  });
});
