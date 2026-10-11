import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// prettier-ignore
// @ts-expect-error plain .mjs module without type declarations
import { BASELINE_PATH, checkRatchet, formatTable, loadBaseline, METRICS, runAudit, writeBaseline } from "../../scripts/frontend-audit/audit.mjs";

const SCRIPT_PATH = join(__dirname, "../../scripts/frontend-audit/audit.mjs");

// The committed ceiling lives in scripts/frontend-audit/baseline.json (single
// source of truth for the script and this test). It is a one-directional ratchet:
// counts may fall freely, but a rise above a recorded ceiling -- or a drift in the
// metric set -- fails the build. Lower it intentionally with `--write-baseline`
// and record the before/after in the PR body.
const BASELINE: Record<string, number> = loadBaseline();

describe("frontend audit", () => {
  it("stays at or below the committed baseline (one-directional ratchet)", () => {
    expect(checkRatchet(runAudit())).toEqual([]);
  });

  it("covers every baseline metric (no metric added or dropped without updating the baseline)", () => {
    const ids = METRICS.map((m: { id: string }) => m.id).sort();
    expect(ids).toEqual(Object.keys(BASELINE).sort());
  });

  it("emits machine-readable JSON via --json that matches the in-process audit", () => {
    const output = execFileSync("node", [SCRIPT_PATH, "--json"], { encoding: "utf8" });
    expect(JSON.parse(output)).toEqual(runAudit());
  });

  it("prints a human-readable table by default", () => {
    const output = execFileSync("node", [SCRIPT_PATH], { encoding: "utf8" });
    expect(output).toContain("Frontend audit baseline");
    expect(output).toMatch(new RegExp(`raw <button>\\s+${runAudit().raw_button}`));
  });

  it("--check exits 0 and reports no regressions on a clean tree (real CLI path)", () => {
    const output = execFileSync("node", [SCRIPT_PATH, "--check"], { encoding: "utf8" });
    expect(output).toContain("no regressions");
  });

  describe("ratchet", () => {
    it("passes when counts are below the baseline", () => {
      const below = Object.fromEntries(Object.entries(BASELINE).map(([k, v]) => [k, Math.max(0, v - 1)]));
      expect(checkRatchet(below, BASELINE)).toEqual([]);
    });

    it("fails and names the offending metric when a count rises above the baseline", () => {
      const above = { ...BASELINE, raw_button: BASELINE.raw_button + 1 };
      const regressions = checkRatchet(above, BASELINE);
      expect(regressions).toHaveLength(1);
      expect(regressions[0].metric).toBe("raw_button");
      expect(regressions[0].actual).toBe(BASELINE.raw_button + 1);
      expect(regressions[0].baseline).toBe(BASELINE.raw_button);
    });

    it("flags metric-set drift (an added or removed metric)", () => {
      const drifted = { ...BASELINE, brand_new_metric: 0 };
      const regressions = checkRatchet(drifted, BASELINE);
      expect(regressions.some((r: { metric: string }) => r.metric === "__metric_set__")).toBe(true);
    });
  });

  let tempDir: string | undefined;
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("fails closed when a metric root is missing instead of scanning to zero", () => {
    // An empty tree has no apps/ui/src etc. With the ratchet's `<=`, an all-zero
    // broken scan would pass silently; runAudit must throw instead.
    tempDir = mkdtempSync(join(tmpdir(), "fe-audit-empty-"));
    expect(() => runAudit(tempDir)).toThrow(/metric root not found/);
  });

  it("fails closed when a metric root exists but is not a directory", () => {
    tempDir = mkdtempSync(join(tmpdir(), "fe-audit-notdir-"));
    const fakeRoot = join(tempDir, "apps/ui/src");
    mkdirSync(dirname(fakeRoot), { recursive: true });
    writeFileSync(fakeRoot, "not a directory");
    expect(() => runAudit(tempDir)).toThrow(/not a directory/);
  });

  it("--write-baseline rewrites the baseline file with current counts", () => {
    tempDir = mkdtempSync(join(tmpdir(), "fe-audit-baseline-"));
    const target = join(tempDir, "baseline.json");
    const counts = { raw_button: 7, raw_input: 3 };
    writeBaseline(counts, target);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(counts);
    expect(readFileSync(target, "utf8").endsWith("\n")).toBe(true);
  });

  it("keeps the committed baseline file and the metric set in sync", () => {
    const committed = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    const ids = METRICS.map((m: { id: string }) => m.id).sort();
    expect(Object.keys(committed).sort()).toEqual(ids);
  });

  it("counts global matches across a synthetic tree", () => {
    tempDir = mkdtempSync(join(tmpdir(), "fe-audit-"));
    const file = join(tempDir, "apps/ui/src/components/Demo.tsx");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "<button>a</button><button>b</button>\n<input value={x} />\n");
    const counts = runAudit(tempDir, { requireRoots: false });
    expect(counts.raw_button).toBe(2);
    expect(counts.raw_input).toBe(1);
    expect(counts.raw_select).toBe(0);
  });

  it("excludes the requestJson helper declaration from the unvalidated count", () => {
    tempDir = mkdtempSync(join(tmpdir(), "fe-audit-"));
    const file = join(tempDir, "apps/ui/src/api/client.ts");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "export async function requestJson<T>(u) {}\nawait requestJson<{ x: 1 }>(u);\n");
    expect(runAudit(tempDir, { requireRoots: false }).requestJson_unvalidated).toBe(1);
  });

  it("formats a table containing every metric label", () => {
    const table = formatTable(runAudit());
    for (const metric of METRICS as Array<{ label: string }>) {
      expect(table).toContain(metric.label);
    }
  });
});
