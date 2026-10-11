import { describe, expect, it } from "vitest";

import { redact } from "../../shared/observability/redact.js";

// ARC-1136: the generic URL-credential pattern stops at "/" in the password, so a
// connection string for a non-DB scheme with a literal "/" in the password (e.g.
// amqp/ftp) leaked unredacted. A scheme-scoped rule covers those without
// over-redacting benign URLs that merely contain a later "@".
describe("redact: non-DB URL credentials with '/' in the password (ARC-1136)", () => {
  it("redacts amqp credentials whose password contains '/'", () => {
    const out = redact("Connection failed: amqp://admin:Aa1/bC2d@host:5672/vhost");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("Aa1/bC2d");
    expect(out).not.toContain("admin:");
  });

  it("redacts ftp/sftp/amqps credentials whose password contains '/'", () => {
    expect(redact("ftp://u:pa/ss@h/x")).toContain("[REDACTED]");
    expect(redact("sftp://u:pa/ss@h/x")).toContain("[REDACTED]");
    expect(redact("amqps://u:pa/ss@h/vhost")).toContain("[REDACTED]");
  });

  // Over-redaction guard: broadening the generic class would wrongly redact these.
  it("leaves credential-free URLs with a port and a later '@' untouched", () => {
    const url = "https://api.example.com:8080/v1/users?cc=x@y.com&ok=1";
    expect(redact(url)).toBe(url);
  });

  // The scheme-scoped rule must not mistake `host:port/path?x@y` for `user:pass@`.
  it("leaves credential-free amqp/ftp URLs with a port and '@'-in-query untouched", () => {
    for (const url of ["amqp://host:5672/vhost?cc=x@y.com", "ftp://example.com:2121/path?email=a@b.com"]) {
      expect(redact(url)).toBe(url);
    }
  });

  it("leaves a plain credential-free URL untouched", () => {
    const url = "https://host/a/b/c";
    expect(redact(url)).toBe(url);
  });

  it("leaves a credential-free amqp URL untouched", () => {
    const url = "amqp://host:5672/vhost";
    expect(redact(url)).toBe(url);
  });
});
