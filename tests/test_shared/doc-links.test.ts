import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");
const liveDocRoots = ["docs", "CLAUDE.md", "AGENTS.md", "DESIGN.md"];
const historicalDocPrefixes = ["docs/superpowers/plans/"];

function walkMarkdownFiles(entry: string): string[] {
  const fullPath = resolve(repoRoot, entry);
  if (!existsSync(fullPath)) return [];
  const stat = statSync(fullPath);
  if (stat.isFile()) return extname(fullPath) === ".md" ? [entry] : [];

  return readdirSync(fullPath)
    .flatMap((child) => walkMarkdownFiles(join(entry, child)))
    .filter((file) => !historicalDocPrefixes.some((prefix) => file.startsWith(prefix)));
}

function markdownLinkTargets(markdown: string): string[] {
  return Array.from(markdown.matchAll(/(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g), (match) => match[1])
    .map((target) => target.replace(/^<|>$/g, ""))
    .filter((target) => {
      if (!target) return false;
      if (target.startsWith("#")) return true;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
      return target.includes(".md");
    });
}

function githubSlug(rawHeading: string): string {
  return rawHeading
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/<[^>]+>/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .toLowerCase()
    .replace(/&[a-z0-9#]+;/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .trim()
    .replace(/^-+|-+$/g, "");
}

function anchorsFor(filePath: string): Set<string> {
  const markdown = readFileSync(filePath, "utf8");
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of markdown.split("\n")) {
    if (!/^#{1,6}\s+\S/.test(line)) continue;
    const base = githubSlug(line);
    if (!base) continue;
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

describe("documentation markdown links", () => {
  it("points relative markdown links at existing files and anchors", () => {
    const failures: string[] = [];
    const docs = liveDocRoots.flatMap(walkMarkdownFiles).sort();

    for (const doc of docs) {
      const docPath = resolve(repoRoot, doc);
      const markdown = readFileSync(docPath, "utf8");
      for (const target of markdownLinkTargets(markdown)) {
        const [rawPath, rawAnchor] = target.split("#");
        const targetPath = rawPath ? resolve(dirname(docPath), decodeURIComponent(rawPath)) : docPath;
        if (!existsSync(targetPath)) {
          failures.push(`${doc} links missing file ${target}`);
          continue;
        }
        if (rawAnchor) {
          const anchor = decodeURIComponent(rawAnchor).toLowerCase();
          if (!anchorsFor(targetPath).has(anchor)) {
            failures.push(`${doc} links missing anchor ${target}`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
