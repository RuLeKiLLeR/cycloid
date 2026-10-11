import { describe, expect, it } from "vitest";

import {
  extractPathSignals,
  extractPlainPrNumbers,
  extractStructuredReferenceSignals,
  GENERIC_REPO_MEMORY_SYMBOL_TERMS,
  GITHUB_PULL_REQUEST_URL_RE,
  isPullRequestReferencedForRepo,
  normalizeSignalTerms,
  pathSpecificityScore,
} from "../../shared/memory/retrieval-signals";

describe("retrieval signal path specificity", () => {
  it("extracts GitHub and plain PR number references", () => {
    expect(
      extractStructuredReferenceSignals(
        "Verify PR #4533 and https://github.com/trycycloid/cycloid/pull/4890 before merge.",
      ).prNumbers,
    ).toEqual([4890, 4533]);
  });

  it("dedupes signal terms after compound term expansion", () => {
    expect(normalizeSignalTerms("start-bridge start bridge")).toEqual(["start-bridge", "start", "bridge"]);
  });

  it("does not extract generic prose fragments as file paths", () => {
    expect(extractPathSignals("Locate relevant code/tests.")).toEqual([]);
    expect(extractPathSignals("Locate the failing/needed behavior.")).toEqual([]);
    expect(extractPathSignals("Check apps/control-plane-worker/src/session/prompt-queue.ts.")).toEqual([
      "apps/control-plane-worker/src/session/prompt-queue.ts",
    ]);
  });

  it("scores exact files above broad directories", () => {
    const exact = pathSpecificityScore(
      ["apps/control-plane-worker/src/session/prompt-queue.ts"],
      ["apps/control-plane-worker/src/session/prompt-queue.ts"],
    );
    const broad = pathSpecificityScore(
      ["apps/control-plane-worker/src"],
      ["apps/control-plane-worker/src/session/prompt-queue.ts"],
    );

    expect(exact.matches[0]).toMatchObject({ kind: "exact_file" });
    expect(broad.matches[0]).toMatchObject({ kind: "file_under_directory" });
    expect(exact.score).toBeGreaterThan(broad.score);
  });

  it("keeps glob prefix evidence weaker than exact file evidence", () => {
    const glob = pathSpecificityScore(
      ["apps/control-plane-worker/src/session/**"],
      ["apps/control-plane-worker/src/session/prompt-queue.ts"],
    );
    const exact = pathSpecificityScore(
      ["apps/control-plane-worker/src/session/prompt-queue.ts"],
      ["apps/control-plane-worker/src/session/prompt-queue.ts"],
    );

    expect(glob.matches[0]).toMatchObject({ kind: "glob_prefix" });
    expect(glob.score).toBeGreaterThan(0);
    expect(glob.score).toBeLessThan(exact.score);
  });

  it("does not match unrelated same-package paths", () => {
    expect(pathSpecificityScore(["wrangler.toml"], ["apps/control-plane-worker/src/session/prompt-queue.ts"])).toEqual({
      score: 0,
      matches: [],
    });
  });

  it("exposes shared PR helpers for reuse across recall paths", () => {
    expect(extractPlainPrNumbers("Land PR #123 and pull request 456 today.")).toEqual([123, 456]);
    const match = "https://github.com/trycycloid/cycloid/pull/789".match(GITHUB_PULL_REQUEST_URL_RE);
    expect(match?.slice(1, 4)).toEqual(["trycycloid", "cycloid", "789"]);
    expect([...GENERIC_REPO_MEMORY_SYMBOL_TERMS].sort()).toEqual(["js", "jsx", "sh", "ts", "tsx"]);
  });

  it("prefers explicit repository URLs over ambiguous plain PR numbers", () => {
    const intent =
      "Investigate https://github.com/other-org/other-repo/pull/123 and compare it with PR #123 in this repo.";
    expect(isPullRequestReferencedForRepo(intent, 123, "trycycloid", "cycloid")).toBe(false);
    expect(
      isPullRequestReferencedForRepo(
        "Investigate https://github.com/trycycloid/cycloid/pull/123 and compare it with PR #123.",
        123,
        "trycycloid",
        "cycloid",
      ),
    ).toBe(true);
    expect(isPullRequestReferencedForRepo("Investigate PR #123.", 123, "trycycloid", "cycloid")).toBe(true);
    expect(isPullRequestReferencedForRepo("Investigate https://github.com/any/repo/pull/123.", 123, null, null)).toBe(
      false,
    );
    expect(
      isPullRequestReferencedForRepo(
        "Investigate https://github.com/other/repo/pull/123 and then PR #456.",
        456,
        "trycycloid",
        "cycloid",
      ),
    ).toBe(true);
  });
});
