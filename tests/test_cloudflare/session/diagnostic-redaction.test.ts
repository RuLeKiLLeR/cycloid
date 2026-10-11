/**
 * ARC-1136: bridge-startup diagnostic redaction must also catch non-DB URL
 * credentials whose password contains a literal "/" (e.g. amqp/ftp), without
 * over-redacting benign URLs that merely contain a later "@".
 */
import { beforeAll, describe, expect, it } from "vitest";

import { mockCloudflareWorkers, mockSentryCloudflare } from "./helpers.ts";

mockCloudflareWorkers();
mockSentryCloudflare();

type WorkerModule = {
  truncateDiagnosticText: (value: string | null | undefined) => string;
};

describe("truncateDiagnosticText: non-DB URL credentials with '/' in password (ARC-1136)", () => {
  let truncateDiagnosticText: WorkerModule["truncateDiagnosticText"];

  beforeAll(async () => {
    const mod = (await import("../../../apps/control-plane-worker/src/session/durable-object.ts")) as WorkerModule;
    truncateDiagnosticText = mod.truncateDiagnosticText;
  });

  it("redacts amqp credentials whose password contains '/'", () => {
    const out = truncateDiagnosticText("Connection failed: amqp://admin:Aa1/bC2d@host:5672/vhost");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("Aa1/bC2d");
    expect(out).not.toContain("admin:");
  });

  it("redacts ftp/sftp/amqps credentials whose password contains '/'", () => {
    expect(truncateDiagnosticText("ftp://u:pa/ss@h/x")).toBe("[REDACTED]");
    expect(truncateDiagnosticText("sftp://u:pa/ss@h/x")).toBe("[REDACTED]");
    expect(truncateDiagnosticText("amqps://u:pa/ss@h/vhost")).toBe("[REDACTED]");
  });

  it("uses the shared redactor-only token forms", () => {
    const out = truncateDiagnosticText(
      [
        "whsec_1234567890abcdef1234",
        "lin_api_abcdefghijklmnopqrstuvwxyz",
        "sk-svcacct-abcdefghijklmnopqrstuvwxyz123456",
        "token: abcdefghijklmnopqrstuvwxyz123456",
        "api_key=abcdefghijklmnop123456",
      ].join("\n"),
    );

    expect(out.match(/\[REDACTED\]/g)).toHaveLength(5);
    expect(out).not.toContain("whsec_");
    expect(out).not.toContain("lin_api_");
    expect(out).not.toContain("sk-svcacct-");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(out).not.toContain("abcdefghijklmnop123456");
  });

  it("redacts bare Basic/Token auth values the shared redactor skips", () => {
    const out = truncateDiagnosticText(
      ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "auth with Token abc123def456ghi"].join("\n"),
    );
    expect(out).not.toContain("dXNlcjpwYXNzd29yZA==");
    expect(out).not.toContain("abc123def456ghi");
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("redacts password-ish URL query params the shared redactor skips", () => {
    const out = truncateDiagnosticText("https://h/x?password=hunter2&pwd=short&auth=opaque-value&keep=1");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("short");
    expect(out).not.toContain("opaque-value");
    expect(out).toContain("password=[REDACTED]");
    expect(out).toContain("pwd=[REDACTED]");
    expect(out).toContain("auth=[REDACTED]");
    expect(out).toContain("keep=1");
  });

  it("leaves credential-free URLs with a port and a later '@' untouched", () => {
    const url = "https://api.example.com:8080/v1/users?cc=x@y.com&ok=1";
    expect(truncateDiagnosticText(url)).toBe(url);
  });

  // The scheme-scoped rule must not mistake `host:port/path?x@y` for `user:pass@`.
  it("leaves credential-free amqp URLs with a port and '@'-in-query untouched", () => {
    const url = "amqp://host:5672/vhost?cc=x@y.com";
    expect(truncateDiagnosticText(url)).toBe(url);
  });
});
