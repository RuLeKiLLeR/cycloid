import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const distRoot = resolve(process.argv[2] ?? "dist/ui");
const publicHtmlPath = join(distRoot, "index.html");
const authenticatedHtmlPath = join(distRoot, "authenticated.html");

const representativeAuthenticatedMarkers = [
  "sessions/:id",
  "settings/general",
  "cli-tokens",
  "business-integrations",
  "SessionPage",
  "SettingsPage",
  "EvalsPage",
  "GeneralSettings",
  "IntegrationsSettings",
  "CliTokensSettings",
  "BusinessIntegrationsSettings",
  "PromptForm",
  "SessionList",
  "fetchSessions",
  "fetchBootstrap",
  "/api/sessions",
  "/api/bootstrap",
];
const publicShellForbiddenMetadata = [
  "Sign in with GitHub",
  "OAuth",
  "GitHub",
  "coding-agent",
  "coding agent",
  "agent workspace",
  "Private workspace",
];

function fail(message) {
  throw new Error(`[ui-public-artifact] ${message}`);
}

function readRequiredFile(filePath) {
  if (!existsSync(filePath)) fail(`Missing required artifact ${relative(distRoot, filePath)}`);
  return readFileSync(filePath, "utf8");
}

function assetPathFromRef(ref) {
  if (!ref.startsWith("/assets/")) return null;
  return join(distRoot, ref.slice(1));
}

function collectHtmlAssetRefs(html) {
  const refs = new Set();
  for (const match of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
    const assetPath = assetPathFromRef(match[1]);
    if (assetPath) refs.add(assetPath);
  }
  return refs;
}

function collectImportedJsAssets(filePath, seen = new Set()) {
  if (seen.has(filePath)) return seen;
  if (!existsSync(filePath)) fail(`Referenced asset does not exist: ${relative(distRoot, filePath)}`);

  seen.add(filePath);
  if (!filePath.endsWith(".js")) return seen;

  const source = readFileSync(filePath, "utf8");
  const importPatterns = [
    /\bimport\s*\(\s*["'](\.\/[^"']+\.js)["']\s*\)/g,
    /\bimport\s*(?:(?:[^"'()]*)from\s*)?["'](\.\/[^"']+\.js)["']/g,
    /\bexport\s*[^"']*?from\s*["'](\.\/[^"']+\.js)["']/g,
  ];

  for (const pattern of importPatterns) {
    for (const match of source.matchAll(pattern)) {
      collectImportedJsAssets(join(dirname(filePath), match[1]), seen);
    }
  }

  return seen;
}

function collectArtifactGraph(htmlPath) {
  const html = readRequiredFile(htmlPath);
  const assets = collectHtmlAssetRefs(html);
  for (const asset of [...assets]) {
    collectImportedJsAssets(asset, assets);
  }
  return { html, assets };
}

function isModulepreloadPolyfill(asset) {
  if (!asset.endsWith(".js")) return false;
  if (relative(distRoot, asset).startsWith("assets/modulepreload-polyfill-")) return true;

  const source = readFileSync(asset, "utf8");
  return (
    source.includes('rel="modulepreload"') &&
    source.includes("document.createElement") &&
    source.includes("MutationObserver")
  );
}

const publicGraph = collectArtifactGraph(publicHtmlPath);
const authenticatedGraph = collectArtifactGraph(authenticatedHtmlPath);

if (!publicGraph.html.includes("public-shell")) {
  fail("Public HTML does not contain the login shell");
}

if (authenticatedGraph.html.includes("public-shell")) {
  fail("Authenticated HTML contains the public login shell");
}

const sharedPublicAuthenticatedJs = [...publicGraph.assets].filter(
  (asset) => asset.endsWith(".js") && authenticatedGraph.assets.has(asset) && !isModulepreloadPolyfill(asset),
);

if (sharedPublicAuthenticatedJs.length > 0) {
  fail(
    "Public and authenticated artifacts share JS chunks:\n" +
      sharedPublicAuthenticatedJs.map((asset) => `  - ${relative(distRoot, asset)}`).join("\n"),
  );
}

const publicFiles = [publicHtmlPath, ...publicGraph.assets];
for (const filePath of publicFiles) {
  const source = readFileSync(filePath, "utf8");
  for (const marker of representativeAuthenticatedMarkers) {
    if (source.includes(marker)) {
      fail(`Public artifact contains authenticated marker "${marker}" in ${relative(distRoot, filePath)}`);
    }
  }

  for (const marker of publicShellForbiddenMetadata) {
    if (source.includes(marker)) {
      fail(`Public artifact contains logged-out metadata "${marker}" in ${relative(distRoot, filePath)}`);
    }
  }
}

const publicJsBytes = [...publicGraph.assets]
  .filter((asset) => asset.endsWith(".js"))
  .reduce((total, asset) => total + statSync(asset).size, 0);

if (publicJsBytes > 20_000) {
  fail(`Public JS footprint is ${publicJsBytes} bytes, expected <= 20000 bytes`);
}

console.log("[ui-public-artifact] public files:");
for (const filePath of publicFiles) {
  console.log(`  - ${relative(distRoot, filePath)}`);
}
console.log(`[ui-public-artifact] public JS footprint: ${publicJsBytes} bytes`);
