import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

// Standing frontend-architecture audit (Phase 0 of the frontend remediation plan).
// Emits counts that later phases drive toward zero. The script's output is canonical;
// the plan's scorecard is updated to match it, not the other way around.

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, "../..");

const UI_SRC = "apps/ui/src";

// Each metric scans `roots` for files matching `extensions`, skips any path containing
// a substring in `excludePathParts`, and counts global regex matches across file contents.
// Near-zero ban-new metrics (raw WebSocket, fetch outside api/, request.json() casts) were
// promoted to point-of-change ESLint rules in eslint.config.js; they are no longer counted.
export const METRICS = [
  {
    id: "raw_button",
    label: "raw <button>",
    roots: [UI_SRC],
    extensions: [".tsx"],
    regex: /<button\b/g,
  },
  {
    id: "raw_input",
    label: "raw <input>",
    roots: [UI_SRC],
    extensions: [".tsx"],
    regex: /<input\b/g,
  },
  {
    id: "raw_select",
    label: "raw <select>",
    roots: [UI_SRC],
    extensions: [".tsx"],
    regex: /<select\b/g,
  },
  {
    id: "raw_textarea",
    label: "raw <textarea>",
    roots: [UI_SRC],
    extensions: [".tsx"],
    regex: /<textarea\b/g,
  },
  {
    id: "bracket_magic_numbers",
    label: "bracket magic-numbers ([12px] etc.)",
    roots: [UI_SRC],
    extensions: [".tsx", ".css"],
    regex: /\[-?\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|fr|ms|s)\]/g,
  },
  {
    id: "requestJson_inline_literal",
    label: "inline-literal requestJson<{...}> sites",
    roots: [UI_SRC],
    extensions: [".ts", ".tsx"],
    regex: /requestJson<\s*\{/g,
  },
  {
    // Exit-criterion metric for PR 1.1: every requestJson call is "unvalidated" until it
    // passes a zod schema. The endgame is this count reaching zero.
    id: "requestJson_unvalidated",
    label: "unvalidated requestJson sites (PR 1.1 -> 0)",
    roots: [UI_SRC],
    extensions: [".ts", ".tsx"],
    // Match invocations only, not the `function requestJson<T>` declaration in client.ts,
    // so the count can actually reach zero once every call site passes a schema.
    regex: /(?<!function )requestJson[<(]/g,
  },
];

function walkFiles(absRoot, extensions, onFile) {
  let entries;
  try {
    entries = readdirSync(absRoot, { withFileTypes: true });
  } catch (err) {
    // A genuinely-absent root is tolerated so synthetic trees can scan a partial
    // set of roots (and so `requireRoots: false` callers do not throw). Any other
    // error (permissions, I/O) is unexpected and must fail closed rather than
    // silently undercount. Existence of the real roots is enforced separately by
    // assertRootsExist().
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const abs = join(absRoot, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walkFiles(abs, extensions, onFile);
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      onFile(abs);
    }
  }
}

function countMetric(metric, repoRoot) {
  let count = 0;
  for (const root of metric.roots) {
    const absRoot = join(repoRoot, root);
    walkFiles(absRoot, metric.extensions, (abs) => {
      const relPath = relative(repoRoot, abs).split("\\").join("/");
      if (metric.excludePathParts?.some((part) => relPath.includes(part))) return;
      // Read errors on a committed file we just walked into are unexpected; let
      // them throw so a broken scan fails closed instead of undercounting.
      const source = readFileSync(abs, "utf8");
      const matches = source.match(new RegExp(metric.regex.source, metric.regex.flags));
      if (matches) count += matches.length;
    });
  }
  return count;
}

// Every metric root must exist for the count to be trustworthy. A missing root
// (broken checkout, moved directory) would otherwise scan to zero and silently
// pass the `<=` ratchet. Fail closed instead.
function assertRootsExist(repoRoot, metrics) {
  const roots = [...new Set(metrics.flatMap((m) => m.roots))];
  for (const root of roots) {
    const absRoot = join(repoRoot, root);
    let stat;
    try {
      stat = statSync(absRoot);
    } catch (err) {
      // Only a genuinely-absent root is "not found". Re-throw anything else
      // (EACCES, I/O) with its real error so the diagnostic is accurate instead
      // of misreporting a permission problem as a missing directory.
      if (err && err.code === "ENOENT") {
        throw new Error(`frontend-audit: metric root not found: ${root} (resolved ${absRoot})`);
      }
      throw err;
    }
    if (!stat.isDirectory()) {
      throw new Error(`frontend-audit: metric root is not a directory: ${root} (resolved ${absRoot})`);
    }
  }
}

// Returns a stable, ordered { id: count } map so a snapshot test surfaces drift as
// a diff. `requireRoots` defaults to true so the real audit and the baseline test
// fail closed on a missing root; synthetic counting tests pass false to scan a
// partial tree.
export function runAudit(repoRoot = REPO_ROOT, { requireRoots = true } = {}) {
  if (requireRoots) assertRootsExist(repoRoot, METRICS);
  const counts = {};
  for (const metric of METRICS) {
    counts[metric.id] = countMetric(metric, repoRoot);
  }
  return counts;
}

export const BASELINE_PATH = join(SCRIPT_DIR, "baseline.json");

// The committed ceiling each migration metric ratchets down from. Single source
// of truth shared by the script (`--write-baseline`, ratchet check) and the test.
export function loadBaseline(path = BASELINE_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeBaseline(counts, path = BASELINE_PATH) {
  writeFileSync(path, `${JSON.stringify(counts, null, 2)}\n`);
}

// One-directional ratchet: counts may fall freely (improvements never break the
// build), but any rise above the recorded ceiling -- or any drift in the metric
// set itself -- is a regression. Returns an array of regression descriptors
// (empty when clean) so callers can name the offending metric.
export function checkRatchet(counts, baseline = loadBaseline()) {
  const regressions = [];
  const countKeys = Object.keys(counts).sort();
  const baselineKeys = Object.keys(baseline).sort();
  if (countKeys.join(",") !== baselineKeys.join(",")) {
    regressions.push({
      metric: "__metric_set__",
      message: `metric set drift: audit=[${countKeys.join(", ")}] baseline=[${baselineKeys.join(", ")}]`,
    });
  }
  for (const key of countKeys) {
    if (key in baseline && counts[key] > baseline[key]) {
      regressions.push({
        metric: key,
        actual: counts[key],
        baseline: baseline[key],
        message: `${key} rose to ${counts[key]} (ceiling ${baseline[key]}); add the wrapper/primitive or run --write-baseline with before/after in the PR body`,
      });
    }
  }
  return regressions;
}

export function formatTable(counts) {
  const labelWidth = Math.max(...METRICS.map((m) => m.label.length));
  const lines = [
    "Frontend audit baseline",
    "=".repeat(labelWidth + 8),
    ...METRICS.map((m) => `${m.label.padEnd(labelWidth)}  ${String(counts[m.id]).padStart(5)}`),
  ];
  return lines.join("\n");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const counts = runAudit();
  if (process.argv.includes("--write-baseline")) {
    // Intentional, reviewed baseline edit. Record before/after in the PR body.
    writeBaseline(counts);
    process.stdout.write(`Wrote baseline to ${relative(REPO_ROOT, BASELINE_PATH)}\n`);
  } else if (process.argv.includes("--check")) {
    // Ratchet check for CLI/CI use; the vitest suite enforces the same thing.
    const regressions = checkRatchet(counts);
    if (regressions.length > 0) {
      for (const r of regressions) process.stderr.write(`REGRESSION: ${r.message}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write("Frontend audit: no regressions above baseline.\n");
    }
  } else if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(counts, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatTable(counts)}\n`);
  }
}
