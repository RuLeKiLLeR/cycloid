import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const apiPort = process.env.VITE_API_PORT || "3000";
const uiPort = process.env.VITE_UI_PORT || "5173";
const apiTarget = process.env.VITE_API_URL || `http://localhost:${apiPort}`;
const authTarget = process.env.VITE_AUTH_URL || apiTarget;
const resolveEntry = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const isNodeModule = (id: string, pkg: string) => id.includes(`/node_modules/${pkg}/`);
const authenticatedFontPreloadPlaceholder = "<!-- AUTHENTICATED_FONT_PRELOAD -->";
const authenticatedPrimaryFontFileName = "geist-latin-wght-normal.woff2";

function entryModulePreloadPlugin(): Plugin {
  return {
    name: "entry-modulepreload",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (ctx.filename.endsWith("/index.html")) {
          return html.replace(
            /<link\b(?=[^>]*\brel=["']modulepreload["'])(?=[^>]*\bhref=["'][^"']+["'])[^>]*>\s*/g,
            "",
          );
        }

        const moduleScripts = Array.from(
          html.matchAll(/<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=["']([^"']+)["'])[^>]*>/g),
          (match) => match[1],
        );
        const entryScript = moduleScripts.at(-1);
        if (!entryScript) {
          throw new Error("Unable to resolve built HTML entry script for modulepreload rewrite");
        }

        return html.replace(/<link\b(?=[^>]*\brel=["']modulepreload["'])(?=[^>]*\bhref=["'][^"']+["'])[^>]*>/, (tag) =>
          tag.replace(/href=["'][^"']+["']/, `href="${entryScript}"`),
        );
      },
    },
  };
}

function authenticatedFontPreloadPlugin(): Plugin {
  return {
    name: "authenticated-font-preload",
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        if (!ctx.filename.endsWith("/authenticated.html")) return html;

        return html.replace(
          authenticatedFontPreloadPlaceholder,
          `<link rel="preload" as="font" type="font/woff2" crossorigin href="/assets/${authenticatedPrimaryFontFileName}" />`,
        );
      },
    },
    // Fail the build if the preload href points at an asset Rollup never
    // emitted. Without this, a future @fontsource-variable/geist version
    // that renames the WOFF2 would silently 404 in production.
    generateBundle(_options, bundle) {
      const expectedKey = `assets/${authenticatedPrimaryFontFileName}`;
      if (!Object.prototype.hasOwnProperty.call(bundle, expectedKey)) {
        const emittedFonts = Object.keys(bundle).filter((key) => key.endsWith(".woff2"));
        throw new Error(
          `[authenticated-font-preload] Expected emitted asset "${expectedKey}" not found in bundle. ` +
            `The preload href in authenticated.html will 404. ` +
            `Emitted .woff2 assets: ${emittedFonts.length ? emittedFonts.join(", ") : "(none)"}. ` +
            `Update authenticatedPrimaryFontFileName / assetFileNames in vite.config.ts to match.`,
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [authenticatedFontPreloadPlugin(), react(), tailwindcss(), entryModulePreloadPlugin()],
  build: {
    outDir: "../../dist/ui",
    emptyOutDir: true,
    sourcemap: "hidden",
    rollupOptions: {
      input: {
        public: resolveEntry("./index.html"),
        authenticated: resolveEntry("./authenticated.html"),
      },
      output: {
        entryFileNames: "assets/[hash].js",
        chunkFileNames: "assets/chunk-[hash].js",
        assetFileNames(assetInfo) {
          const names = Array.isArray(assetInfo.names)
            ? assetInfo.names
            : typeof assetInfo.name === "string"
              ? [assetInfo.name]
              : [];
          if (names.includes(authenticatedPrimaryFontFileName)) {
            return `assets/${authenticatedPrimaryFontFileName}`;
          }
          return "assets/[hash][extname]";
        },
        manualChunks(id) {
          if (!id.includes("/node_modules/")) return undefined;

          if (["react", "react-dom", "react-router"].some((pkg) => isNodeModule(id, pkg))) {
            return "react-vendor";
          }

          if (["@datadog/browser-rum", "@datadog/browser-rum-react"].some((pkg) => isNodeModule(id, pkg))) {
            return "datadog";
          }

          if (["@sentry/react", "@sentry/browser"].some((pkg) => isNodeModule(id, pkg))) {
            return "sentry";
          }

          if (
            ["react-markdown", "remark-gfm"].some((pkg) => isNodeModule(id, pkg)) ||
            /\/node_modules\/rehype-[^/]+\//.test(id)
          ) {
            return "markdown";
          }

          if (isNodeModule(id, "react-diff-viewer-continued")) {
            return "diff";
          }

          return undefined;
        },
      },
    },
  },
  server: {
    port: parseInt(uiPort, 10),
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        ws: true,
      },
      "^/auth(/|$)": {
        target: authTarget,
        changeOrigin: true,
      },
    },
  },
});
