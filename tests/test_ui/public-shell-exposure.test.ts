import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");
const uiRoot = join(repoRoot, "apps/ui");
const manifestPath = ".vite/manifest.json";
const representativeTaxonomy = [
  "Sign in with GitHub",
  "OAuth",
  "GitHub",
  "coding-agent",
  "coding agent",
  "agent workspace",
  "Private workspace",
  "evals",
  "skills",
  "preview",
  "SessionPage",
  "SettingsPage",
  "EvalsPage",
  "CliTokens",
  "BusinessIntegrations",
  "PromptForm",
  "repos",
  "integrations",
  "Datadog",
  "Sentry",
  "bootstrap",
];

type ViteManifestEntry = {
  file?: string;
  name?: string;
  isDynamicEntry?: boolean;
  isEntry?: boolean;
  css?: string[];
  dynamicImports?: string[];
};

let outDir = "";

function walkFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walkFiles(path) : [path];
  });
}

function moduleScripts(html: string) {
  return Array.from(
    html.matchAll(/<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=["']([^"']+)["'])[^>]*>/g),
    (match) => match[1],
  );
}

function modulePreloads(html: string) {
  return Array.from(
    html.matchAll(/<link\b(?=[^>]*\brel=["']modulepreload["'])(?=[^>]*\bhref=["']([^"']+)["'])[^>]*>/g),
    (match) => match[1],
  );
}

function readManifest(): Record<string, ViteManifestEntry> {
  return JSON.parse(readFileSync(join(outDir, manifestPath), "utf8")) as Record<string, ViteManifestEntry>;
}

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), "cycloid-ui-public-"));
  execFileSync("npx", ["vite", "build", "--outDir", outDir, "--manifest", manifestPath], {
    cwd: uiRoot,
    env: process.env,
    stdio: "pipe",
  });
}, 60_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe("UI production build guards", () => {
  it("keeps built public artifacts free of authenticated taxonomy in entry assets", () => {
    const assetFiles = walkFiles(join(outDir, "assets")).map((file) => relative(outDir, file));
    for (const file of assetFiles) {
      expect(basename(file)).toMatch(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9]+)+$/);
    }

    const html = readFileSync(join(outDir, "index.html"), "utf8");
    const entryScripts = moduleScripts(html);
    expect(entryScripts.length).toBeGreaterThan(0);

    const publicEntryText = [
      html,
      ...entryScripts.map((script) => readFileSync(join(outDir, script.replace(/^\//, "")), "utf8")),
    ].join("\n");

    for (const term of representativeTaxonomy) {
      expect(publicEntryText).not.toContain(term);
    }
  });

  it("keeps the logged-out shell free of modulepreloads", () => {
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    expect(modulePreloads(html)).toEqual([]);
  });

  it("preloads the authenticated shell's actual entry asset instead of a data URL", () => {
    const html = readFileSync(join(outDir, "authenticated.html"), "utf8");
    const entryScripts = moduleScripts(html);
    const preloads = modulePreloads(html);
    const entryScript = entryScripts.at(-1);

    expect(entryScript, "authenticated.html should include a module entry script").toBeDefined();
    expect(preloads, "authenticated.html should include a modulepreload for its entry").toContain(entryScript);
    expect(preloads.some((href) => href.startsWith("data:application/octet-stream"))).toBe(false);
  });

  it("ships Tailwind CSS with the authenticated app bundle", () => {
    const manifest = readManifest();
    const authenticatedEntry = Object.values(manifest).find(
      (entry) => entry.name === "authenticated-app" && entry.isDynamicEntry === true,
    );

    expect(authenticatedEntry, "authenticated-app must remain a production dynamic entry").toBeDefined();
    const cssList = authenticatedEntry?.css?.filter((cssFile) => /^assets\/.+\.css$/.test(cssFile));
    if (!cssList?.length) {
      throw new Error("authenticated-app must declare its stylesheet in the built manifest");
    }
    const authenticatedCss = cssList.map((cssFile) => readFileSync(join(outDir, cssFile), "utf8")).join("\n");

    expect(authenticatedCss, "authenticated CSS should include App.css theme tokens").toContain("--color-surface-0");
    expect(authenticatedCss, "authenticated CSS should include generated Tailwind utilities").toContain(
      ".min-h-screen",
    );
    expect(authenticatedCss.length, "authenticated CSS should not be the tiny public shell stylesheet").toBeGreaterThan(
      20_000,
    );
  });
});
