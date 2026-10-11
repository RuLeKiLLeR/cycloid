import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ADMIN_TOKEN_ROUTE_ALLOWLIST,
  CI_AUTOMATION_TOKEN_ROUTE_ALLOWLIST,
} from "../../apps/control-plane-worker/src/constants/auth-tokens";
import { buildRouteMatchers, canAccessAllowlistedRoute } from "../../apps/control-plane-worker/src/router";
import type { Route } from "../../apps/control-plane-worker/src/routes/shared";
import { controlPlaneRoutes } from "../../apps/control-plane-worker/src/routes/table";

const ADMIN_TOKEN_ROUTE_MATCHERS = buildRouteMatchers(ADMIN_TOKEN_ROUTE_ALLOWLIST);
const CI_AUTOMATION_TOKEN_ROUTE_MATCHERS = buildRouteMatchers(CI_AUTOMATION_TOKEN_ROUTE_ALLOWLIST);
const ROUTES_DIR = resolve(__dirname, "../../apps/control-plane-worker/src/routes");
const PARAM_CAPTURE_PATTERN = /\(\?<[^>]+>\[\^\/\]\+\)/g;
const UNSUPPORTED_ROUTE_REGEX_PATTERN = /[()[\]{}+*?|^$]/;
const HARD_GATE_PATTERN =
  /if\s*\(\s*![^)]*\.canAccessAllSessions\s*\)\s*\{?\s*return\s+jsonErrorResponse\(\s*["']Forbidden["']\s*,\s*403\s*\)/g;

function samplePathForRoute(route: Route): string {
  const source = route.pattern.source;
  if (!source.startsWith("^\\/") || !source.endsWith("$")) {
    throw new Error(`Route pattern ${route.pattern} is not an anchored parsePattern() route regex`);
  }

  const body = source.slice(1, -1);
  const unsupportedRegexSyntax = body.replace(/\\\//g, "").replace(PARAM_CAPTURE_PATTERN, "");
  if (UNSUPPORTED_ROUTE_REGEX_PATTERN.test(unsupportedRegexSyntax)) {
    throw new Error(`Route pattern ${route.pattern} contains unsupported regex syntax for sample path generation`);
  }

  const samplePath = body.replace(/\\\//g, "/").replace(PARAM_CAPTURE_PATTERN, "test-id");

  expect(route.pattern.test(samplePath), `Generated sample path ${samplePath} must match ${route.pattern}`).toBe(true);
  return samplePath;
}

function lineNumberFor(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function describeMissingAdminTokenOnlyAnnotations(): string[] {
  const missing: string[] = [];
  const routeFiles = readdirSync(ROUTES_DIR)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => resolve(ROUTES_DIR, file));

  for (const filePath of routeFiles) {
    const source = readFileSync(filePath, "utf8");
    for (const match of source.matchAll(HARD_GATE_PATTERN)) {
      const matchIndex = match.index ?? 0;
      const routeStart = source.lastIndexOf("\n  {", matchIndex);
      const routeEnd = source.indexOf("\n  },", matchIndex);
      if (routeStart < 0 || routeEnd < 0) {
        missing.push(
          `${filePath}:${lineNumberFor(source, matchIndex)} hard-gate is not inside a standard route object`,
        );
        continue;
      }

      const routeBlock = source.slice(routeStart, routeEnd);
      if (/adminTokenOnly:\s*true\b/.test(routeBlock)) continue;

      const method = routeBlock.match(/method:\s*"([^"]+)"/)?.[1] ?? "UNKNOWN";
      const path = routeBlock.match(/parsePattern\("([^"]+)"\)/)?.[1] ?? "unknown path";
      missing.push(`${filePath}:${lineNumberFor(source, matchIndex)} ${method} ${path}`);
    }
  }

  return missing;
}

describe("admin-token route allowlist coverage", () => {
  it("allowlists every declarative admin-token-only route", () => {
    const adminTokenOnlyRoutes = controlPlaneRoutes.filter((route) => route.adminTokenOnly === true);

    expect(adminTokenOnlyRoutes.length).toBeGreaterThan(0);
    for (const route of adminTokenOnlyRoutes) {
      const samplePath = samplePathForRoute(route);

      expect(
        canAccessAllowlistedRoute(ADMIN_TOKEN_ROUTE_MATCHERS, route.method, samplePath),
        `${route.method} ${samplePath} is adminTokenOnly but missing from ADMIN_TOKEN_ROUTE_ALLOWLIST`,
      ).toBe(true);
    }
  });

  it("annotates every route source hard-gate on canAccessAllSessions", () => {
    expect(describeMissingAdminTokenOnlyAnnotations()).toEqual([]);
  });

  it("allows CI automation tokens to read and register sandbox base templates", () => {
    expect(
      canAccessAllowlistedRoute(CI_AUTOMATION_TOKEN_ROUTE_MATCHERS, "GET", "/api/admin/sandbox-base-templates/current"),
    ).toBe(true);
    expect(
      canAccessAllowlistedRoute(
        CI_AUTOMATION_TOKEN_ROUTE_MATCHERS,
        "POST",
        "/api/admin/sandbox-base-templates/register",
      ),
    ).toBe(true);
  });

  it("allows admin and CI automation tokens to run the row-7 repair route", () => {
    expect(canAccessAllowlistedRoute(ADMIN_TOKEN_ROUTE_MATCHERS, "POST", "/api/admin/fsm/row7-repair")).toBe(true);
    expect(canAccessAllowlistedRoute(CI_AUTOMATION_TOKEN_ROUTE_MATCHERS, "POST", "/api/admin/fsm/row7-repair")).toBe(
      true,
    );
  });

  it("allows admin and CI automation tokens to run the parity-check route", () => {
    expect(canAccessAllowlistedRoute(ADMIN_TOKEN_ROUTE_MATCHERS, "POST", "/api/admin/fsm/parity-check")).toBe(true);
    expect(canAccessAllowlistedRoute(CI_AUTOMATION_TOKEN_ROUTE_MATCHERS, "POST", "/api/admin/fsm/parity-check")).toBe(
      true,
    );
  });
});
