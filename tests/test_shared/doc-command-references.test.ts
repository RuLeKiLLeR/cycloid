import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");
const docRoots = ["docs", "CLAUDE.md", "AGENTS.md", "DESIGN.md"];
const historicalDocPrefixes = ["docs/superpowers/plans/"];
const customerRepoCommandAllowlist = new Set([
  "docs/customer-e2e-runtime.md::cycloid:auth",
  "docs/customer-e2e-runtime.md::db:reset",
  "docs/customer-e2e-runtime.md::db:seed:test",
  "docs/customer-e2e-runtime.md::test:e2e",
  "docs/onboarding-checklist.md::db:reset",
  "docs/onboarding-checklist.md::db:seed:test",
  "docs/onboarding-checklist.md::test:e2e",
  "docs/mia-cycloid-platform-onboarding.md::dev:cycloid",
  "docs/mia-cycloid-platform-onboarding.md::typecheck",
]);

function walkFiles(entry: string): string[] {
  const fullPath = resolve(repoRoot, entry);
  if (!existsSync(fullPath)) return [];
  const stat = readdirSync(dirnameOrSelf(fullPath), { withFileTypes: true }).find(
    (dirent) => join(dirnameOrSelf(entry), dirent.name) === entry,
  );
  if (!stat || stat.isFile()) return entry.endsWith(".md") ? [entry] : [];
  return readdirSync(fullPath, { withFileTypes: true }).flatMap((dirent) => {
    const child = join(entry, dirent.name);
    if (historicalDocPrefixes.some((prefix) => child.startsWith(prefix))) return [];
    return dirent.isDirectory() ? walkFiles(child) : child.endsWith(".md") ? [child] : [];
  });
}

function dirnameOrSelf(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === -1 ? "." : path.slice(0, lastSlash);
}

function packageScripts(): Set<string> {
  const packagePaths = [
    "package.json",
    ...readdirSync(resolve(repoRoot, "apps"), { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => `apps/${dirent.name}/package.json`)
      .filter((path) => existsSync(resolve(repoRoot, path))),
  ];
  return new Set(
    packagePaths.flatMap((path) =>
      Object.keys(JSON.parse(readFileSync(resolve(repoRoot, path), "utf8")).scripts ?? {}),
    ),
  );
}

describe("documentation npm script references", () => {
  it("references package scripts that exist in this repo unless explicitly marked as customer-repo examples", () => {
    const scripts = packageScripts();
    const failures: string[] = [];

    for (const doc of docRoots.flatMap(walkFiles).sort()) {
      const markdown = readFileSync(resolve(repoRoot, doc), "utf8");
      for (const match of markdown.matchAll(/\bnpm run (?:-[a-z]\s+)*([a-z0-9][a-z0-9:._-]*)/gi)) {
        const command = match[1];
        if (scripts.has(command)) continue;
        if (customerRepoCommandAllowlist.has(`${doc}::${command}`)) continue;
        failures.push(`${doc} references missing npm script ${command}`);
      }
    }

    expect(failures).toEqual([]);
  });
});
