import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCAN_ROOTS = ["apps/control-plane-worker/src", "apps/sandbox-bridge/src", "shared", "infra", "docs"];
const EXTENSIONS = new Set([".md", ".mjs", ".js", ".ts", ".tsx", ".tf", ".yml", ".yaml"]);

const FORBIDDEN = [
  ["cycloid-", "verification:v1"].join(""),
  ["verify", "=true"].join(""),
  ["verification", ".run.completed"].join(""),
  ["verification", ".schedule.failed"].join(""),
  ["verification", "_liveness"].join(""),
  ["verification", "_teardown"].join(""),
];

function extension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot);
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === "migrations" || entry === "node_modules" || entry === ".wrangler") continue;
      yield* walk(path);
      continue;
    }
    if (stat.isFile() && EXTENSIONS.has(extension(path))) {
      yield path;
    }
  }
}

describe("QA Tester legacy cleanup guard", () => {
  it("keeps removed public aliases, old markers, and legacy telemetry out of active files", () => {
    const hits: string[] = [];

    for (const root of SCAN_ROOTS) {
      const absRoot = join(ROOT, root);
      if (!existsSync(absRoot)) continue;
      for (const file of walk(absRoot)) {
        const content = readFileSync(file, "utf8");
        for (const forbidden of FORBIDDEN) {
          if (content.includes(forbidden)) {
            hits.push(`${relative(ROOT, file)} contains ${forbidden}`);
          }
        }
      }
    }

    expect(hits).toEqual([]);
  });
});
