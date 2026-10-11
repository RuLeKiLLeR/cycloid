import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const UI_SRC = join(__dirname, "../../apps/ui/src");
const UI_ROOT = join(__dirname, "../../apps/ui");

describe("UI public entry preload boundary", () => {
  it("keeps authenticated feature imports out of the public entry module", () => {
    const publicEntry = readFileSync(join(UI_SRC, "main.tsx"), "utf-8");
    const authenticatedEntry = readFileSync(join(UI_SRC, "authenticated-app.tsx"), "utf-8");

    expect(publicEntry).toContain('import("./authenticated-app")');
    expect(authenticatedEntry).toContain('import("./pages/HomePage")');
    expect(authenticatedEntry).toContain('import("./pages/SessionPage")');
    expect(authenticatedEntry).toContain('import("./pages/SettingsPage")');

    const forbiddenPublicMarkers = [
      "./pages/",
      "./components/settings/",
      "./components/Layout",
      "HomePage",
      "SessionPage",
      "SettingsPage",
      "EvalsPage",
      "BusinessIntegrationsSettings",
      "CliTokensSettings",
      "./App.css",
    ];

    for (const marker of forbiddenPublicMarkers) {
      expect(publicEntry, `public entry should not reference ${marker}`).not.toContain(marker);
    }
  });

  it("uses generic production chunk filenames for route-level bundles", () => {
    const viteConfig = readFileSync(join(UI_SRC, "../vite.config.ts"), "utf-8");

    expect(viteConfig).toContain('chunkFileNames: "assets/chunk-[hash].js"');
  });

  it("allows dev proxy targets to be overridden via env vars", () => {
    const viteConfig = readFileSync(join(UI_SRC, "../vite.config.ts"), "utf-8");

    expect(viteConfig).toContain("const apiTarget = process.env.VITE_API_URL || `http://localhost:${apiPort}`;");
    expect(viteConfig).toContain("const authTarget = process.env.VITE_AUTH_URL || apiTarget;");
    expect(viteConfig).toContain("target: apiTarget");
    expect(viteConfig).toContain("target: authTarget");
    expect(viteConfig).toContain("changeOrigin: true");
  });

  it("keeps the prerendered signed-out shell to the generic sign-in button", () => {
    const html = readFileSync(join(UI_ROOT, "index.html"), "utf-8");
    const body = html.slice(html.indexOf("<body>"));

    expect(body).toContain("Sign in");
    expect(body).toContain('href="/auth/github"');
    expect(body).not.toContain("GitHub");
    expect(body).not.toContain("Private workspace");
    expect(body).not.toContain("Sign in with an approved GitHub account");
    expect(body).not.toContain("coding-agent workspace");
    expect(body).not.toContain("<h1");
    expect(body).not.toContain("OAuth");
  });

  it("preloads the same primary authenticated font path that the build emits for CSS", () => {
    const html = readFileSync(join(UI_ROOT, "authenticated.html"), "utf-8");
    const viteConfig = readFileSync(join(UI_ROOT, "vite.config.ts"), "utf-8");

    // The source HTML contains the placeholder; the Vite plugin rewrites it
    // at build time to a real <link rel="preload"> with a deterministic href.
    expect(html).toContain("<!-- AUTHENTICATED_FONT_PRELOAD -->");
    expect(viteConfig).toContain('const authenticatedPrimaryFontFileName = "geist-latin-wght-normal.woff2";');
    expect(viteConfig).toContain('href="/assets/${authenticatedPrimaryFontFileName}"');
    expect(viteConfig).toContain("return `assets/${authenticatedPrimaryFontFileName}`;");
  });
});
