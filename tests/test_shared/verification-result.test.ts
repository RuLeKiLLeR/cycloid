import { describe, expect, it } from "vitest";

import { parseVerifierTerminalResult } from "../../shared/agent/verification-result.js";

describe("parseVerifierTerminalResult", () => {
  it("parses compact fenced JSON output", () => {
    const parsed = parseVerifierTerminalResult(
      `\`\`\`cycloid-verification-result\n{"verdict":"CONCLUSIVE","verifiedHeadSha":"abc123","summary":"looks good","evidence":["focused proof"],"blockers":[]}\n\`\`\``,
    );

    expect(parsed.malformed).toBe(false);
    expect(parsed.result).toMatchObject({
      verdict: "CONCLUSIVE",
      verifiedHeadSha: "abc123",
      summary: "looks good",
      evidence: ["focused proof"],
      blockers: [],
    });
  });

  it("parses an optional needsWorkLabel", () => {
    const parsed = parseVerifierTerminalResult(`\`\`\`cycloid-verification-result
{"verdict":"INCONCLUSIVE","verifiedHeadSha":"abc123","needsWorkLabel":"verification-gap","summary":"missing proof","evidence":[],"blockers":["add runtime proof"]}
\`\`\``);

    expect(parsed.malformed).toBe(false);
    expect(parsed.result.needsWorkLabel).toBe("verification-gap");
  });

  it("drops an unknown needsWorkLabel instead of failing the whole parse", () => {
    const parsed = parseVerifierTerminalResult(`\`\`\`cycloid-verification-result
{"verdict":"INCONCLUSIVE","verifiedHeadSha":"abc123","needsWorkLabel":"unknown-label","summary":"missing proof","evidence":[],"blockers":["add runtime proof"]}
\`\`\``);

    expect(parsed.malformed).toBe(false);
    expect(parsed.result).not.toHaveProperty("needsWorkLabel");
  });

  it("parses well-formed checks rows", () => {
    const parsed = parseVerifierTerminalResult(`\`\`\`cycloid-verification-result
{"verdict":"CONCLUSIVE","verifiedHeadSha":"abc123","summary":"looks good","evidence":[],"checks":[{"name":"ci","status":"passed","detail":"all jobs green"},{"name":"runtime","status":"skipped"}],"blockers":[]}
\`\`\``);

    expect(parsed.malformed).toBe(false);
    expect(parsed.result.checks).toEqual([
      { name: "ci", status: "passed", detail: "all jobs green" },
      { name: "runtime", status: "skipped" },
    ]);
  });

  it("parses human-readable evidence citations", () => {
    const parsed = parseVerifierTerminalResult(`\`\`\`cycloid-verification-result
{"verdict":"CONCLUSIVE","verifiedHeadSha":"abc123","summary":"looks good","evidence":["focused proof passed"],"blockers":[]}
\`\`\``);

    expect(parsed.malformed).toBe(false);
    expect(parsed.result.evidence).toEqual(["focused proof passed"]);
  });

  it("parses publishable evidence as machine-readable artifact refs", () => {
    const parsed = parseVerifierTerminalResult(`\`\`\`cycloid-verification-result
{"verdict":"CONCLUSIVE","verifiedHeadSha":"abc123","summary":"looks good","evidence":["focused proof passed"],"publishableEvidence":[{"path":"/tmp/phase-evidence/operator/focused-proof.log","label":"focused-proof.log","reason":"Focused passing proof output"},{"path":"","label":"bad","reason":"bad"}],"blockers":[]}
\`\`\``);

    expect(parsed.malformed).toBe(false);
    expect(parsed.result.publishableEvidence).toEqual([
      {
        path: "/tmp/phase-evidence/operator/focused-proof.log",
        label: "focused-proof.log",
        reason: "Focused passing proof output",
      },
    ]);
  });

  it("drops malformed check rows individually without failing the parse", () => {
    const parsed = parseVerifierTerminalResult(`\`\`\`cycloid-verification-result
{"verdict":"CONCLUSIVE","verifiedHeadSha":"abc123","summary":"ok","evidence":[],"checks":[{"name":"ci","status":"passed"},{"name":"","status":"passed"},{"name":"tests","status":"bogus"},{"status":"passed"},"nope"],"blockers":[]}
\`\`\``);

    expect(parsed.malformed).toBe(false);
    expect(parsed.result.checks).toEqual([{ name: "ci", status: "passed" }]);
  });

  it("caps checks at the list limit", () => {
    const rows = Array.from({ length: 25 }, (_, i) => `{"name":"c${i}","status":"passed"}`).join(",");
    const parsed = parseVerifierTerminalResult(`\`\`\`cycloid-verification-result
{"verdict":"CONCLUSIVE","verifiedHeadSha":"abc123","summary":"ok","evidence":[],"checks":[${rows}],"blockers":[]}
\`\`\``);

    expect(parsed.malformed).toBe(false);
    expect(parsed.result.checks).toHaveLength(20);
  });

  it("omits checks entirely when absent or all rows are invalid", () => {
    const absent = parseVerifierTerminalResult(`\`\`\`cycloid-verification-result
{"verdict":"CONCLUSIVE","verifiedHeadSha":"abc123","summary":"ok","evidence":[],"blockers":[]}
\`\`\``);
    const allInvalid = parseVerifierTerminalResult(`\`\`\`cycloid-verification-result
{"verdict":"CONCLUSIVE","verifiedHeadSha":"abc123","summary":"ok","evidence":[],"checks":[{"status":"passed"}],"blockers":[]}
\`\`\``);

    expect(absent.result).not.toHaveProperty("checks");
    expect(allInvalid.result).not.toHaveProperty("checks");
  });

  it("tolerates legacy verifierCommits input without preserving it", () => {
    const parsed = parseVerifierTerminalResult(`\`\`\`cycloid-verification-result
{"verdict":"CONCLUSIVE","verifiedHeadSha":"abc123","summary":"ok","evidence":[],"blockers":[],"verifierCommits":[{"sha":"fix123","message":"legacy"}]}
\`\`\``);

    expect(parsed.malformed).toBe(false);
    expect(parsed.result).not.toHaveProperty("verifierCommits");
  });
});
