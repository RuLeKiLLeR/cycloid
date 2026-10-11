import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const CONTROL_PLANE_SRC = join(process.cwd(), "apps/control-plane-worker/src");
const DIRECT_FETCH_ALLOWED_FILES = new Set([
  "observability/events-exporter.ts",
  "observability/exporter.ts",
  "observability/phase-metrics.ts",
  "observability/pr-metrics.ts",
  "observability/wrappers.ts",
  "slack/notify.ts",
]);

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return listTypeScriptFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return files.flat();
}

function hasDirectFetchCall(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return false;
  const codeOnly = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
  if (codeOnly.includes("async fetch(")) return false;
  return /(?<![\w.])fetch\s*\(/.test(codeOnly);
}

describe("control-plane outbound fetch tracing", () => {
  it("ignores fetch-like text in comments", () => {
    expect(hasDirectFetchCall("const done = true; // old: fetch(url)")).toBe(false);
    expect(hasDirectFetchCall("/* fetch(url) */")).toBe(false);
  });

  it("keeps production outbound fetches on tracedFetch or explicit injected fetchImpl", async () => {
    const files = await listTypeScriptFiles(CONTROL_PLANE_SRC);
    const violations: string[] = [];

    for (const file of files) {
      const rel = relative(CONTROL_PLANE_SRC, file).replaceAll("\\", "/");
      if (DIRECT_FETCH_ALLOWED_FILES.has(rel)) continue;

      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, index) => {
        if (hasDirectFetchCall(line)) {
          violations.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
