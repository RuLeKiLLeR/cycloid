/**
 * Route coverage test: ensures every fetch() call in the UI API client
 * has a matching route in the control-plane-worker.
 *
 * Both lists are auto-derived from source — no manual manifests to maintain.
 * If you add a new UI fetch() call, just add the matching worker route.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { controlPlaneRoutes } from "../../apps/control-plane-worker/src/routes/table";

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

function extractUiApiCalls(): { method: string; path: string; fnName: string }[] {
  const apiDir = resolve(__dirname, "../../apps/ui/src/api");
  const apiFiles = readdirSync(apiDir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => resolve(apiDir, file));

  const results: { method: string; path: string; fnName: string }[] = [];
  for (const apiPath of apiFiles) {
    const source = readFileSync(apiPath, "utf-8");
    const fnBlocks = source.split(/^export /m);

    for (const block of fnBlocks) {
      const fnMatch = block.match(/^(?:async )?function (\w+)/);
      const fnName = fnMatch?.[1] ?? "unknown";

      const fetchRegex =
        /(?:fetch|requestJson|requestVoid)\s*(?:<[^(]*>)?\(\s*(?:`([^`]+)`|"([^"]+)")\s*(?:,\s*\{[^}]*method:\s*"(\w+)")?/g;
      let match;
      while ((match = fetchRegex.exec(block)) !== null) {
        const rawPath = match[1] ?? match[2];
        const method = match[3] ?? "GET";
        const path = rawPath
          .replace(/\$\{[^}]+\}/g, ":param")
          .split("?")[0]
          .replace(/([^/]):param$/, "$1");
        results.push({ method, path, fnName });
      }
    }
  }

  return results;
}

function extractWorkerRoutes(): { method: string; pattern: RegExp }[] {
  return controlPlaneRoutes.map((route) => ({ method: route.method, pattern: route.pattern }));
}

function pathMatchesPattern(path: string, pattern: RegExp): boolean {
  const normalizedPath = path.replace(/:param/g, "test-id");
  const pathWithoutQuery = normalizedPath.split("?")[0];
  return pattern.test(pathWithoutQuery);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("route coverage", () => {
  const uiCalls = extractUiApiCalls();
  const workerRoutes = extractWorkerRoutes();

  it("extracts at least one UI endpoint", () => {
    expect(uiCalls.length).toBeGreaterThan(0);
  });

  it("extracts at least one worker route", () => {
    expect(workerRoutes.length).toBeGreaterThan(0);
  });

  // -- Coverage: every UI call must have a matching worker route --

  for (const call of uiCalls) {
    it(`${call.method} ${call.path} (${call.fnName}) has a matching worker route`, () => {
      const match = workerRoutes.some(
        (route) => route.method === call.method && pathMatchesPattern(call.path, route.pattern),
      );
      expect(match, `No worker route for ${call.method} ${call.path}`).toBe(true);
    });
  }
});
