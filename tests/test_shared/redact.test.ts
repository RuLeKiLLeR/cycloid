import { describe, expect, it } from "vitest";

import { redact, redactObject, redactSecretsInValue } from "../../shared/observability/redact.js";

describe("bridge redaction utilities", () => {
  it("redacts hyphenated secret key names", () => {
    const redacted = redactObject({
      "api-key": "sk-sentinel-secret-value-1234567890",
      nested: {
        "auth-token": "sentinel-token-value-1234567890",
      },
    });

    expect(redacted).toEqual({
      "api-key": "[REDACTED]",
      nested: {
        "auth-token": "[REDACTED]",
      },
    });
  });

  it("preserves sanitized Error cause and custom properties", () => {
    const cause = new Error("database failed: postgres://user:sentinel-pass@db.example/app");
    (cause as Error & { code?: string }).code = "ECONNREFUSED";

    const error = new Error("outer failure: https://user:sentinel-pass@example.com/repo.git", { cause });
    (error as Error & { statusCode?: number; password?: string }).statusCode = 503;
    (error as Error & { statusCode?: number; password?: string }).password = "sentinel-pass";

    const redacted = redactObject({ error }).error as Error & {
      cause?: Error & { code?: string };
      statusCode?: number;
      password?: string;
    };

    expect(redacted).toBeInstanceOf(Error);
    expect(redacted.message).toBe("outer failure: [REDACTED]");
    expect(redacted.stack).not.toContain("sentinel-pass");
    expect(redacted.statusCode).toBe(503);
    expect(redacted.password).toBe("[REDACTED]");
    expect(redacted.cause).toBeInstanceOf(Error);
    expect(redacted.cause?.message).toBe("database failed: [REDACTED]");
    expect(redacted.cause?.code).toBe("ECONNREFUSED");
  });

  it("redacts bare provider token values in telemetry text", () => {
    const secrets = [
      `arc_${"a".repeat(64)}`,
      `e2b_${"Ab9C".repeat(5)}`,
      "github_pat_1234567890abcdef_1234567890abcdef",
      "ghp_1234567890abcdef",
      "gho_1234567890abcdef",
      "ghr_1234567890abcdef",
      "ghs_1234567890abcdef",
      "ghu_1234567890abcdef",
      "AKIAIOSFODNN7EXAMPLE",
      "ASIAIOSFODNN7EXAMPLE",
      "sk-proj-1234567890abcdef1234567890abcdef",
      "sk-svcacct-1234567890abcdef1234567890abcdef",
      "sk-ant-1234567890abcdef1234567890abcdef",
      "sk_live_1234567890abcdef",
      "sk_test_1234567890abcdef",
      "whsec_1234567890abcdef",
      "xoxp-1234567890",
      "AIza1234567890abcdef1234567890abcdef",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789--",
    ];

    const redacted = redact(`stdout:\n${secrets.join("\n")}`);

    for (const secret of secrets) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(secrets.length);
  });

  it("redacts provider tokens glued to adjacent text", () => {
    const redacted = redact(
      [
        `prefixarc_${"a".repeat(64)}suffix`,
        `prefixe2b_${"Ab9C".repeat(5)}suffix`,
        "prefixAKIAIOSFODNN7EXAMPLEsuffix",
        "prefixgithub_pat_1234567890abcdef_1234567890abcdefsuffix",
        "prefixxoxp-1234567890suffix",
        "prefixeyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789--suffix",
      ].join("\n"),
    );

    expect(redacted).not.toContain(`arc_${"a".repeat(64)}`);
    expect(redacted).not.toContain(`e2b_${"Ab9C".repeat(5)}`);
    expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redacted).not.toContain("github_pat_1234567890abcdef_1234567890abcdef");
    expect(redacted).not.toContain("xoxp-1234567890");
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789--");
    expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(6);
  });

  it("does not redact ordinary arc_ or e2b_ identifiers that do not match secret shapes", () => {
    const value =
      "runtime=e2b_cloud token_prefix=arc_beef version=arc_1.2.3 key=e2b_runtime_backend event=e2b_orphan_owner_guard_skipped retry=e2b_idle_pause_resume_after_race";

    expect(redact(value)).toBe(value);
  });

  it("redacts opaque Authorization token headers without reintroducing prose false positives", () => {
    const value = "curl -H 'Authorization: token abcdefghijklmnopqrstuvwxyz123456' https://api.github.com";

    expect(redact(value)).toBe("curl -H '[REDACTED]' https://api.github.com");
  });

  it("redacts provider tokens embedded in Error messages", () => {
    const error = new Error("AWS auth failed for AKIAIOSFODNN7EXAMPLE");

    const redacted = redactObject({ error }).error as Error;

    expect(redacted).toBeInstanceOf(Error);
    expect(redacted.message).toBe("AWS auth failed for [REDACTED]");
    expect(redacted.stack).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts structured access key fields", () => {
    const redacted = redactObject({
      aws_access_key_id: "AKIAIOSFODNN7EXAMPLE",
      nested: {
        private_key: "-----BEGIN PRIVATE KEY-----",
      },
    });

    expect(redacted).toEqual({
      aws_access_key_id: "[REDACTED]",
      nested: {
        private_key: "[REDACTED]",
      },
    });
  });

  it("preserves observability span snapshots under a spans object", () => {
    const redacted = redactObject({
      event: "prompt.dispatch_subspans_completed",
      spans: {
        backend_first_token: { offset_ms: 4800, signal: "session.status" },
        prompt_sent_to_backend: { offset_ms: 40, duration_ms: 35 },
      },
    });

    expect(redacted).toEqual({
      event: "prompt.dispatch_subspans_completed",
      spans: {
        backend_first_token: { offset_ms: 4800, signal: "session.status" },
        prompt_sent_to_backend: { offset_ms: 40, duration_ms: 35 },
      },
    });
  });

  it("keeps redacting secret-looking keys in non-dispatch spans payloads", () => {
    const redacted = redactObject({
      event: "other.event",
      spans: {
        api_token: { offset_ms: 1, signal: "short-secret" },
      },
    });

    expect(redacted).toEqual({
      event: "other.event",
      spans: {
        api_token: "[REDACTED]",
      },
    });
  });

  it("keeps redacting unknown secret-looking span names in dispatch summaries", () => {
    const redacted = redactObject({
      event: "prompt.dispatch_subspans_completed",
      spans: {
        api_token: { offset_ms: 1, signal: "short-secret" },
      },
    });

    expect(redacted).toEqual({
      event: "prompt.dispatch_subspans_completed",
      spans: {
        api_token: "[REDACTED]",
      },
    });
  });
});

describe("redactSecretsInValue (field-precise)", () => {
  it("scrubs secret substrings inside string leaves while preserving surrounding text", () => {
    const result = redactSecretsInValue({
      command: "curl -H 'Authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA' https://api",
      filePath: "/src/index.ts",
    });
    expect(result).toEqual({
      command: "curl -H 'Authorization: [REDACTED]' https://api",
      filePath: "/src/index.ts",
    });
  });

  it("redacts secrets nested in arrays and deep objects", () => {
    const result = redactSecretsInValue({
      env: ["PATH=/usr/bin", "GITHUB_TOKEN=ghs_abcdefghijklmnopqrstuvwxyz0123456789"],
      meta: { auth: { header: "token ghp_abcdefghijklmnopqrstuvwxyz0123" } },
    });
    expect(result).toEqual({
      env: ["PATH=/usr/bin", "[REDACTED]"],
      meta: { auth: { header: "token [REDACTED]" } },
    });
  });

  it("redacts secrets in deeply nested string leaves", () => {
    let value: unknown = "Authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";
    for (let index = 0; index < 12; index++) {
      value = { child: value };
    }

    const result = redactSecretsInValue(value);

    expect(JSON.stringify(result)).not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("does NOT blunt-redact whole values by key name (unlike redactObject)", () => {
    // A field literally named "token" whose value is a harmless, non-secret string
    // must survive intact -- field-precision is the whole point.
    const result = redactSecretsInValue({ token: "abc", apiKey: "short" });
    expect(result).toEqual({ token: "abc", apiKey: "short" });
  });

  it("returns the original reference when nothing is secret", () => {
    const clean = { id: "part-1", text: "hello world", n: 3, ok: true };
    expect(redactSecretsInValue(clean)).toBe(clean);
  });

  it("leaves non-string scalars untouched", () => {
    expect(redactSecretsInValue(42)).toBe(42);
    expect(redactSecretsInValue(null)).toBeNull();
    expect(redactSecretsInValue(true)).toBe(true);
  });
});
