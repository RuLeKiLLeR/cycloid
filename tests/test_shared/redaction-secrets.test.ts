import { describe, expect, it } from "vitest";

import { scanForSecrets } from "../../shared/redaction/secrets.js";

// scanForSecrets is the final gate before untrusted Slack content is persisted
// for company-memory ingestion (control-plane company-memory/service.ts). If it
// fails to flag a credential, the secret is stored in D1 and can later poison
// memory served to every member of that business. It had no dedicated tests, so
// a regression in any SECRET_RULES pattern would have shipped silently. These
// tests pin one positive per rule, the clean/already-redacted negatives, and the
// length boundaries that the patterns hinge on.

describe("scanForSecrets", () => {
  it.each([
    ["aws_access_key", "creds AKIAIOSFODNN7EXAMPLE in config"],
    ["cycloid_cli_token", `token arc_${"a".repeat(64)} end`],
    ["e2b_api_key", `token e2b_${"Ab9C".repeat(5)} end`],
    ["github_pat", `token ghp_${"a".repeat(36)} end`],
    ["github_pat_fine_grained", `token github_pat_${"a".repeat(22)}_${"b".repeat(59)} end`],
    ["slack_token", "xoxb-1234567890-abcdefghijklmnop"],
    ["stripe_live", `sk_live_${"A".repeat(24)}`],
    ["openai_key", `sk-${"a".repeat(32)}`],
    ["openai_key", `sk-proj-${"a_b-".repeat(8)}`],
    ["openai_key", `sk-svcacct-${"A1_b-".repeat(7)}`],
    ["anthropic_key", `sk-ant-${"a".repeat(32)}`],
    ["private_key_pem", "-----BEGIN RSA PRIVATE KEY-----\nMIIEvg...\n-----END RSA PRIVATE KEY-----"],
    ["jwt_like", "eyJhbGciOi.eyJzdWIiOi.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"],
  ])("quarantines a %s and reports it as the reason", (expectedReason, text) => {
    const result = scanForSecrets(text);
    expect(result.quarantined).toBe(true);
    expect(result.reason).toBe(expectedReason);
  });

  it("passes clean text through without quarantine", () => {
    expect(scanForSecrets("just normal log output, 12 files changed, all tests pass")).toEqual({ quarantined: false });
  });

  it("does not quarantine content that has already been redacted", () => {
    expect(scanForSecrets("API_KEY=[REDACTED] and token=[REDACTED]")).toEqual({ quarantined: false });
  });

  it("respects the minimum-length boundary of length-sensitive patterns", () => {
    // cycloid_cli_token requires exactly 64 lowercase hex chars after arc_.
    expect(scanForSecrets(`arc_${"a".repeat(63)}`).quarantined).toBe(false);
    expect(scanForSecrets(`arc_${"a".repeat(64)}`).quarantined).toBe(true);
    expect(scanForSecrets(`arc_${"A".repeat(64)}`).quarantined).toBe(false);
    expect(scanForSecrets("arc_test")).toEqual({ quarantined: false });

    // e2b_api_key requires an alphanumeric 16+ char body after e2b_.
    expect(scanForSecrets(`e2b_${"a".repeat(15)}`).quarantined).toBe(false);
    expect(scanForSecrets(`e2b_${"a".repeat(16)}`).quarantined).toBe(true);
    expect(scanForSecrets("e2b_runtime_backend")).toEqual({ quarantined: false });
    expect(scanForSecrets("e2b_orphan_owner_guard_skipped")).toEqual({ quarantined: false });

    // github_pat requires exactly 36 trailing chars: 35 must not match, 36 must.
    expect(scanForSecrets(`ghp_${"a".repeat(35)}`).quarantined).toBe(false);
    expect(scanForSecrets(`ghp_${"a".repeat(36)}`).quarantined).toBe(true);

    // fine-grained github_pat requires the 22 + "_" + 59 token body shape.
    expect(scanForSecrets(`github_pat_${"a".repeat(21)}_${"b".repeat(59)}`).quarantined).toBe(false);
    expect(scanForSecrets(`github_pat_${"a".repeat(22)}_${"b".repeat(58)}`).quarantined).toBe(false);
    expect(scanForSecrets(`github_pat_${"a".repeat(22)}_${"b".repeat(59)}`).quarantined).toBe(true);
    expect(scanForSecrets("github_pat_use_this_env_var")).toEqual({ quarantined: false });

    // openai_key requires 32+ chars after the optional modern prefix.
    expect(scanForSecrets(`sk-${"a".repeat(31)} `).quarantined).toBe(false);
    expect(scanForSecrets(`sk-${"a".repeat(32)}`).quarantined).toBe(true);
    expect(scanForSecrets(`sk-proj-${"a".repeat(31)} `).quarantined).toBe(false);
    expect(scanForSecrets(`sk-proj-${"a".repeat(32)}`).quarantined).toBe(true);
    expect(scanForSecrets(`sk-svcacct-${"a".repeat(31)} `).quarantined).toBe(false);
    expect(scanForSecrets(`sk-svcacct-${"a".repeat(32)}`).quarantined).toBe(true);

    expect(scanForSecrets("sk-learn-short-example")).toEqual({ quarantined: false });
    expect(scanForSecrets("sk-this-is-a-normal-kebab-case-label")).toEqual({ quarantined: false });

    // anthropic_key requires 32+ chars after sk-ant-: 31 must not match, 32 must.
    expect(scanForSecrets(`sk-ant-${"a".repeat(31)}`).quarantined).toBe(false);
    expect(scanForSecrets(`sk-ant-${"a".repeat(32)}`)).toEqual({ quarantined: true, reason: "anthropic_key" });
  });

  it("returns the first matching rule when several secrets are present", () => {
    // aws_access_key precedes github_pat in the rule order, so it wins.
    const result = scanForSecrets(`AKIAIOSFODNN7EXAMPLE and ghp_${"a".repeat(36)}`);
    expect(result).toEqual({ quarantined: true, reason: "aws_access_key" });
  });
});
