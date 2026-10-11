import { describe, expect, it, vi } from "vitest";

import {
  FAILING_CHECK_RUN_CONCLUSIONS,
  failingCheckFingerprint,
  failingCheckRunWorklistItems,
  failingCheckRunWorklistItemsWithLogEvidence,
  hasPendingCheckRuns,
  isFailingCheckRun,
} from "../../apps/control-plane-worker/src/github/pr";

const run = (
  o: Partial<{
    id: number;
    name: string;
    status: string;
    conclusion: string;
    detailsUrl: string;
    outputTitle: string | null;
    outputSummary: string | null;
    outputText: string | null;
  }>,
) => ({
  id: o.id ?? 1,
  name: o.name ?? "ci",
  status: o.status ?? "completed",
  conclusion: o.conclusion ?? "success",
  appSlug: null,
  appName: null,
  detailsUrl: o.detailsUrl ?? null,
  outputTitle: o.outputTitle ?? null,
  outputSummary: o.outputSummary ?? null,
  outputText: o.outputText ?? null,
});

describe("failing CI check helpers", () => {
  it("treats failure/timed_out/action_required/startup_failure as failing, but NOT cancelled (FIX 10)", () => {
    // startup_failure is a real failure → triggers a CI fix. cancelled is usually intentional and
    // not actionable → excluded. Single source of truth reconciled with getCheckRunsStatus.
    expect([...FAILING_CHECK_RUN_CONCLUSIONS].sort()).toEqual([
      "action_required",
      "failure",
      "startup_failure",
      "timed_out",
    ]);
    expect(FAILING_CHECK_RUN_CONCLUSIONS.has("cancelled")).toBe(false);
  });

  it("builds worklist items only for completed failing runs", () => {
    const items = failingCheckRunWorklistItems([
      run({ id: 1, name: "unit", conclusion: "failure", detailsUrl: "https://ci/1" }),
      run({ id: 2, name: "lint", conclusion: "success" }),
      run({ id: 3, name: "migrate", conclusion: "timed_out", detailsUrl: "https://ci/3" }),
      run({ id: 4, name: "flaky", status: "in_progress", conclusion: "" }),
      run({ id: 5, name: "boot", conclusion: "startup_failure", detailsUrl: "https://ci/5" }),
      run({ id: 6, name: "skipped-job", conclusion: "cancelled" }),
    ]);
    // startup_failure (5) included; cancelled (6) excluded.
    expect(items.map((i) => i.sourceId)).toEqual(["check-run-failure:1", "check-run-failure:3", "check-run-failure:5"]);
    expect(items[0].body).toContain("unit");
    expect(items[0].body).toContain("failure");
    expect(items[0].sourceUrl).toBe("https://ci/1");
    expect(items[0].authorType).toBe("ci");
  });

  it("embeds check-run output as a bounded untrusted evidence block", () => {
    const items = failingCheckRunWorklistItems([
      run({
        id: 1,
        name: "unit",
        conclusion: "failure",
        outputTitle: "2 tests failed",
        outputSummary: "FAIL src/foo.test.ts > returns the parsed value\nAssertionError: expected 1 to be 2",
      }),
    ]);
    expect(items[0].body).toContain('Failing CI check "unit"');
    expect(items[0].body).toContain("untrusted CI-reported evidence");
    expect(items[0].body).toContain("2 tests failed");
    expect(items[0].body).toContain("AssertionError: expected 1 to be 2");
  });

  it("omits the evidence block when the check run carries no output", () => {
    const items = failingCheckRunWorklistItems([run({ id: 1, name: "unit", conclusion: "failure" })]);
    expect(items[0].body).toBe(
      'Failing CI check "unit" (conclusion: failure). Investigate and fix so the check passes.',
    );
    expect(items[0].body).not.toContain("untrusted");
  });

  it("redacts secrets and truncates oversized check-run output", () => {
    const items = failingCheckRunWorklistItems([
      run({
        id: 1,
        name: "deploy",
        conclusion: "failure",
        outputTitle: "Deploy failed before publishing",
        outputText: `${"x".repeat(10_000)}\nauth failed for token ghp_abcdefghijklmnop1234567890`,
      }),
    ]);
    expect(items[0].body).toContain("Deploy failed before publishing");
    expect(items[0].body).not.toContain("ghp_abcdefghijklmnop1234567890");
    expect(items[0].body).toContain("... [truncated]");
    // Headline + capped evidence, never the full 10k payload.
    expect(items[0].body.length).toBeLessThan(3500);
  });

  it("inlines a redacted tail from a GitHub Actions job log when check output is empty", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(`${"early log\n".repeat(1000)}\nFAILED assertion\nsecret=ghp_abcdefghijklmnop1234567890`, {
        status: 200,
      }),
    );

    const items = await failingCheckRunWorklistItemsWithLogEvidence(
      [
        run({
          id: 12,
          name: "unit",
          conclusion: "failure",
          detailsUrl: "https://github.com/acme/repo/actions/runs/99/job/12345",
        }),
      ].map((item) => ({ ...item, appSlug: "github-actions" })),
      { token: "token-1", repoOwner: "acme", repoName: "repo", fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/repo/actions/jobs/12345/logs",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token-1" }) }),
    );
    expect(items[0].body).toContain("GitHub Actions failed-job log tail");
    expect(items[0].body).toContain("FAILED assertion");
    expect(items[0].body).toContain("[REDACTED]");
    expect(items[0].body).not.toContain("ghp_abcdefghijklmnop1234567890");
    expect(items[0].body).toContain("... [truncated]");
  });

  it("does not fetch logs for non-Actions checks or GitHub-shaped URLs from another repo", async () => {
    const fetchImpl = vi.fn();

    const items = await failingCheckRunWorklistItemsWithLogEvidence(
      [
        run({ id: 12, name: "unit", conclusion: "failure", detailsUrl: "https://github.com/acme/repo/actions/runs/1" }),
        { ...run({ id: 13, name: "lint", conclusion: "failure" }), appSlug: "circleci" },
        {
          ...run({
            id: 14,
            name: "test",
            conclusion: "failure",
            detailsUrl: "https://github.com/other/repo/actions/runs/99/job/12345",
          }),
          appSlug: "github-actions",
        },
      ],
      { token: "token-1", repoOwner: "acme", repoName: "repo", fetchImpl },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(items.map((item) => item.body)).toEqual([
      'Failing CI check "unit" (conclusion: failure). Investigate and fix so the check passes.',
      'Failing CI check "lint" (conclusion: failure). Investigate and fix so the check passes.',
      'Failing CI check "test" (conclusion: failure). Investigate and fix so the check passes.',
    ]);
  });

  it("fails open when the Actions log fetch is unavailable and keeps the tail when oversized", async () => {
    const unavailableFetch = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));
    const unavailable = await failingCheckRunWorklistItemsWithLogEvidence(
      [
        {
          ...run({
            id: 12,
            name: "unit",
            conclusion: "failure",
            detailsUrl: "https://github.com/acme/repo/actions/runs/99/job/12345",
          }),
          appSlug: "github-actions",
        },
      ],
      { token: "token-1", repoOwner: "acme", repoName: "repo", fetchImpl: unavailableFetch },
    );
    expect(unavailable[0].body).not.toContain("GitHub Actions failed-job log tail");

    const oversizedFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(`${"early log\n".repeat(40_000)}\nFINAL FAILURE: expected true to be false`, { status: 200 }),
      );
    const oversized = await failingCheckRunWorklistItemsWithLogEvidence(
      [
        {
          ...run({
            id: 13,
            name: "lint",
            conclusion: "failure",
            detailsUrl: "https://github.com/acme/repo/actions/runs/99/job/12346",
          }),
          appSlug: "github-actions",
        },
      ],
      { token: "token-1", repoOwner: "acme", repoName: "repo", fetchImpl: oversizedFetch },
    );
    expect(oversized[0].body).toContain("GitHub Actions failed-job log tail");
    expect(oversized[0].body).toContain("FINAL FAILURE: expected true to be false");
    expect(oversized[0].body).toContain("... [truncated]");
  });

  it("bounds GitHub Actions log fetches per worklist build", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response("FAILED assertion", { status: 200 }));
    const runs = [1, 2, 3, 4, 5].map((id) => ({
      ...run({
        id,
        name: `matrix-${id}`,
        conclusion: "failure",
        detailsUrl: `https://github.com/acme/repo/actions/runs/99/job/${12_000 + id}`,
      }),
      appSlug: "github-actions",
    }));

    const items = await failingCheckRunWorklistItemsWithLogEvidence(runs, {
      token: "token-1",
      repoOwner: "acme",
      repoName: "repo",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(items.slice(0, 3).every((item) => item.body.includes("GitHub Actions failed-job log tail"))).toBe(true);
    expect(items.slice(3).every((item) => !item.body.includes("GitHub Actions failed-job log tail"))).toBe(true);
  });

  it("detects pending check runs", () => {
    expect(hasPendingCheckRuns([run({ status: "in_progress", conclusion: "" })])).toBe(true);
    expect(hasPendingCheckRuns([run({ status: "queued", conclusion: "" })])).toBe(true);
    expect(hasPendingCheckRuns([run({ status: "completed", conclusion: "failure" })])).toBe(false);
  });
});

describe("failingCheckFingerprint", () => {
  it("is stable across reruns: same names, different ids → same fingerprint", () => {
    const first = failingCheckFingerprint([
      run({ id: 1, name: "unit", conclusion: "failure" }),
      run({ id: 2, name: "lint", conclusion: "failure" }),
    ]);
    // Reruns reuse the same check NAMES but mint new check-run IDs.
    const rerun = failingCheckFingerprint([
      run({ id: 99, name: "unit", conclusion: "failure" }),
      run({ id: 100, name: "lint", conclusion: "failure" }),
    ]);
    expect(rerun).toBe(first);
  });

  it("is order-independent and de-duplicates by name", () => {
    const a = failingCheckFingerprint([
      run({ id: 1, name: "lint", conclusion: "failure" }),
      run({ id: 2, name: "unit", conclusion: "failure" }),
      run({ id: 3, name: "unit", conclusion: "failure" }),
    ]);
    const b = failingCheckFingerprint([
      run({ id: 4, name: "unit", conclusion: "failure" }),
      run({ id: 5, name: "lint", conclusion: "failure" }),
    ]);
    expect(a).toBe(b);
  });

  it("changes when the failing-check name set changes", () => {
    const before = failingCheckFingerprint([run({ id: 1, name: "unit", conclusion: "failure" })]);
    const after = failingCheckFingerprint([
      run({ id: 1, name: "unit", conclusion: "failure" }),
      run({ id: 2, name: "typecheck", conclusion: "failure" }),
    ]);
    expect(after).not.toBe(before);
  });

  it("only considers completed failing runs (ignores passing/pending)", () => {
    const onlyFailing = failingCheckFingerprint([run({ id: 1, name: "unit", conclusion: "failure" })]);
    const withNoise = failingCheckFingerprint([
      run({ id: 1, name: "unit", conclusion: "failure" }),
      run({ id: 2, name: "lint", conclusion: "success" }),
      run({ id: 3, name: "flaky", status: "in_progress", conclusion: "" }),
      run({ id: 4, name: "cancelled-job", conclusion: "cancelled" }),
    ]);
    expect(withNoise).toBe(onlyFailing);
  });

  it("returns a stable empty-set fingerprint when nothing is failing", () => {
    expect(failingCheckFingerprint([])).toBe(failingCheckFingerprint([run({ id: 1, conclusion: "success" })]));
  });

  it("FIX 10: drops empty/whitespace-less empty names so they do not collide with the empty set", () => {
    const withEmptyName = failingCheckFingerprint([
      run({ id: 1, name: "", conclusion: "failure" }),
      run({ id: 2, name: "unit", conclusion: "failure" }),
    ]);
    const onlyUnit = failingCheckFingerprint([run({ id: 3, name: "unit", conclusion: "failure" })]);
    // The "" name is dropped, so the failing set is just {unit}.
    expect(withEmptyName).toBe(onlyUnit);
    // A single failing check with no name must not look like "nothing failing".
    expect(failingCheckFingerprint([run({ id: 4, name: "", conclusion: "failure" })])).toBe(
      failingCheckFingerprint([]),
    );
  });

  it("FIX 10: a newline-containing name cannot collide with two separate names", () => {
    const oneNewlineName = failingCheckFingerprint([run({ id: 1, name: "a\nb", conclusion: "failure" })]);
    const twoNames = failingCheckFingerprint([
      run({ id: 2, name: "a", conclusion: "failure" }),
      run({ id: 3, name: "b", conclusion: "failure" }),
    ]);
    expect(oneNewlineName).not.toBe(twoNames);
  });
});

describe("isFailingCheckRun (FIX 11 shared predicate)", () => {
  it("is true only for completed runs with a failing conclusion", () => {
    expect(isFailingCheckRun(run({ status: "completed", conclusion: "failure" }))).toBe(true);
    expect(isFailingCheckRun(run({ status: "completed", conclusion: "startup_failure" }))).toBe(true);
    expect(isFailingCheckRun(run({ status: "completed", conclusion: "success" }))).toBe(false);
    expect(isFailingCheckRun(run({ status: "completed", conclusion: "cancelled" }))).toBe(false);
    expect(isFailingCheckRun(run({ status: "in_progress", conclusion: "" }))).toBe(false);
  });
});
