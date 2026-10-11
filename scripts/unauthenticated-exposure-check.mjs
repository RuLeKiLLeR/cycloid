#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_DIST = "dist/ui";
const DEFAULT_SOURCE_ROOT = "apps/ui/src";
const TEXT_ASSET_EXTENSIONS = new Set([".html", ".js", ".css", ".json", ".txt", ".map"]);
const SENSITIVE_ASSET_STRINGS = [
  "INTERNAL_GITHUB_USER_IDS",
  "git-workflow-hack",
  "password-recovery",
  "sanitize-git-repo",
];
const SENSITIVE_ASSET_PATTERNS = [
  { label: "OpenAI API key prefix sk-", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { label: "Slack token prefix xox", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { label: "GitHub token prefix ghp_", pattern: /\bghp_[A-Za-z0-9_]{20,}\b/g },
  { label: "GitHub fine-grained token prefix github_pat_", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { label: "AWS access key prefix AKIA", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "Stripe webhook secret prefix whsec_", pattern: /\bwhsec_[A-Za-z0-9]{20,}\b/g },
];
const ALLOWED_VITE_ENV_KEYS = new Set([
  "VITE_DD_ENV",
  "VITE_DD_RUM_APP_ID",
  "VITE_DD_RUM_CLIENT_TOKEN",
  "VITE_DD_SITE",
  "VITE_SENTRY_DSN",
  "VITE_SENTRY_ENABLE_LOCAL",
  "VITE_SENTRY_ENV",
  "VITE_SENTRY_RELEASE",
]);
const AUTHENTICATED_ROUTE_CHECKS = [
  { method: "GET", path: "/auth/me" },
  { method: "GET", path: "/api/bootstrap" },
  { method: "GET", path: "/api/sessions" },
  { method: "GET", path: "/api/models" },
  { method: "GET", path: "/api/repos" },
  { method: "GET", path: "/api/cli-tokens" },
];
const RANDOM_SESSION_ID = "00000000-0000-4000-8000-000000000537";
const RANDOM_ARTIFACT_ID = "00000000-0000-4000-8000-000000000538";
const PUBLIC_BRIDGE_ROUTE_CHECKS = [
  { method: "GET", path: `/api/sessions/${RANDOM_SESSION_ID}/clone-token`, allowedStatuses: [401, 403, 404] },
  { method: "POST", path: `/api/sessions/${RANDOM_SESSION_ID}/artifacts`, body: "", allowedStatuses: [401, 403, 404] },
  {
    method: "GET",
    path: `/api/sessions/${RANDOM_SESSION_ID}/artifacts/${RANDOM_ARTIFACT_ID}/artifact.txt`,
    allowedStatuses: [404],
  },
];
const REQUIRED_SECURITY_HEADERS = [
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
];

function parseBooleanEnv(name) {
  const value = process.env[name];
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseArgs(argv) {
  const options = {
    dist: process.env.UNAUTH_EXPOSURE_DIST || DEFAULT_DIST,
    sourceRoot: process.env.UNAUTH_EXPOSURE_SOURCE_ROOT || DEFAULT_SOURCE_ROOT,
    baseUrl: process.env.UNAUTH_EXPOSURE_BASE_URL || null,
    strictAssets: parseBooleanEnv("UNAUTH_EXPOSURE_STRICT_ASSETS"),
    strictApiMetadata: parseBooleanEnv("UNAUTH_EXPOSURE_STRICT_API_METADATA"),
    strictMetadataRoutes: parseBooleanEnv("UNAUTH_EXPOSURE_STRICT_METADATA_ROUTES"),
    requireCsp: parseBooleanEnv("UNAUTH_EXPOSURE_REQUIRE_CSP"),
    skipRootHeaders: parseBooleanEnv("UNAUTH_EXPOSURE_SKIP_ROOT_HEADERS"),
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dist") {
      options.dist = requireValue(argv, ++index, arg);
    } else if (arg.startsWith("--dist=")) {
      options.dist = arg.slice("--dist=".length);
    } else if (arg === "--source-root") {
      options.sourceRoot = requireValue(argv, ++index, arg);
    } else if (arg.startsWith("--source-root=")) {
      options.sourceRoot = arg.slice("--source-root=".length);
    } else if (arg === "--base-url") {
      options.baseUrl = requireValue(argv, ++index, arg);
    } else if (arg.startsWith("--base-url=")) {
      options.baseUrl = arg.slice("--base-url=".length);
    } else if (arg === "--strict-assets") {
      options.strictAssets = true;
    } else if (arg === "--strict-api-metadata") {
      options.strictApiMetadata = true;
    } else if (arg === "--strict-metadata-routes") {
      options.strictMetadataRoutes = true;
    } else if (arg === "--require-csp") {
      options.requireCsp = true;
    } else if (arg === "--skip-root-headers") {
      options.skipRootHeaders = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function usage() {
  return `Usage: node scripts/unauthenticated-exposure-check.mjs [options]

Options:
  --dist <path>                 Built UI directory to inspect. Defaults to dist/ui.
  --source-root <path>          UI source root to inspect for public VITE_* usage. Defaults to apps/ui/src.
  --base-url <url>              Optional local preview, staging, or production URL for HTTP checks.
  --strict-assets               Fail on public source map references, representative sensitive strings, token prefixes, and unknown VITE_* source keys.
  --strict-api-metadata         Fail when /api/version exposes commit/environment metadata.
  --strict-metadata-routes      Fail when /.well-known/security.txt or /robots.txt returns SPA HTML.
  --require-csp                 Require content-security-policy on /.
  --skip-root-headers           Skip / security header checks for Vite-only local dev.

Environment aliases:
  UNAUTH_EXPOSURE_DIST
  UNAUTH_EXPOSURE_SOURCE_ROOT
  UNAUTH_EXPOSURE_BASE_URL
  UNAUTH_EXPOSURE_STRICT_ASSETS=1
  UNAUTH_EXPOSURE_STRICT_API_METADATA=1
  UNAUTH_EXPOSURE_STRICT_METADATA_ROUTES=1
  UNAUTH_EXPOSURE_REQUIRE_CSP=1
  UNAUTH_EXPOSURE_SKIP_ROOT_HEADERS=1`;
}

function normalizeBaseUrl(rawUrl) {
  if (!rawUrl) return null;
  const url = new URL(rawUrl);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function makeUrl(baseUrl, routePath) {
  const url = new URL(baseUrl);
  const [pathname, search = ""] = routePath.split("?");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${pathname}`;
  url.search = search ? `?${search}` : "";
  return url;
}

async function collectFiles(root) {
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`Built UI directory does not exist: ${root}`);
  }

  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  await walk(root);
  return files;
}

async function collectExistingFiles(root) {
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) return [];
  return collectFiles(root);
}

function relativeTo(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function extractAssetPaths(indexHtml) {
  return [...indexHtml.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((value) => value.startsWith("/assets/"));
}

function hasSourceMapComment(content) {
  return /(?:\/\/|\/\*)[#@]\s*sourceMappingURL=/.test(content);
}

async function runStaticChecks(options) {
  const failures = [];
  const notes = [];
  const dist = path.resolve(options.dist);
  const files = await collectFiles(dist);
  const indexHtmlPath = path.join(dist, "index.html");
  const indexHtml = await readFile(indexHtmlPath, "utf8").catch(() => null);
  if (indexHtml === null) {
    failures.push(`Missing built entrypoint: ${relativeTo(process.cwd(), indexHtmlPath)}`);
    return { failures, notes, assetPaths: [] };
  }

  const modulePreloads = [...indexHtml.matchAll(/<link[^>]+rel=["']modulepreload["'][^>]*>/gi)].map(
    (match) => match[0],
  );
  if (modulePreloads.length > 0 && options.strictAssets) {
    failures.push(`Logged-out index.html includes modulepreload references: ${modulePreloads.join(" ")}`);
  } else if (modulePreloads.length > 0) {
    notes.push(
      `Found ${modulePreloads.length} modulepreload reference(s); rerun with --strict-assets when auditing public chunk exposure.`,
    );
  }

  const mapFiles = files.filter((file) => file.endsWith(".map"));
  if (mapFiles.length > 0) {
    notes.push(
      `Found ${mapFiles.length} local source map file(s); deploy uploads them to Sentry and strips them before publishing Pages.`,
    );
  }

  const textAssetFiles = files.filter(
    (file) => !file.endsWith(".map") && TEXT_ASSET_EXTENSIONS.has(path.extname(file)),
  );
  for (const file of textAssetFiles) {
    const rel = relativeTo(dist, file);
    const content = await readFile(file, "utf8");
    if (hasSourceMapComment(content)) {
      failures.push(`${rel} contains a sourceMappingURL reference`);
    }
    if (options.strictAssets) {
      for (const needle of SENSITIVE_ASSET_STRINGS) {
        if (content.includes(needle)) {
          failures.push(`${rel} contains sensitive public asset string: ${needle}`);
        }
      }
      for (const { label, pattern } of SENSITIVE_ASSET_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(content)) {
          failures.push(`${rel} contains sensitive public asset pattern: ${label}`);
        }
      }
    }
  }

  if (options.strictAssets) {
    const sourceRoot = path.resolve(options.sourceRoot);
    const sourceFiles = (await collectExistingFiles(sourceRoot)).filter((file) =>
      [".ts", ".tsx", ".js", ".jsx"].includes(path.extname(file)),
    );
    for (const file of sourceFiles) {
      const rel = relativeTo(process.cwd(), file);
      const content = await readFile(file, "utf8");
      const viteKeys = new Set([...content.matchAll(/\bVITE_[A-Z0-9_]+\b/g)].map((match) => match[0]));
      for (const key of viteKeys) {
        if (!ALLOWED_VITE_ENV_KEYS.has(key)) {
          failures.push(`${rel} references unallowlisted public VITE env key: ${key}`);
        }
      }
    }
  }

  return { failures, notes, assetPaths: extractAssetPaths(indexHtml) };
}

async function fetchText(url, init) {
  const response = await fetch(url, {
    redirect: "manual",
    ...init,
    headers: {
      accept: "*/*",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text().catch(() => "");
  return { response, text };
}

function responseExcerpt(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

async function expectStatus(baseUrl, check, allowedStatuses, failures) {
  const url = makeUrl(baseUrl, check.path);
  const { response, text } = await fetchText(url, {
    method: check.method,
    body: check.body,
  });
  if (!allowedStatuses.includes(response.status)) {
    failures.push(
      `${check.method} ${check.path} returned ${response.status}; expected ${allowedStatuses.join("/")} body="${responseExcerpt(text)}"`,
    );
  }
  return { response, text };
}

async function runHttpChecks(options, assetPaths) {
  const failures = [];
  const notes = [];
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  if (!baseUrl) {
    notes.push("Skipped HTTP checks because --base-url was not provided.");
    return { failures, notes };
  }

  for (const check of AUTHENTICATED_ROUTE_CHECKS) {
    await expectStatus(baseUrl, check, [401, 404], failures);
  }

  for (const check of PUBLIC_BRIDGE_ROUTE_CHECKS) {
    await expectStatus(baseUrl, check, check.allowedStatuses, failures);
  }

  if (options.skipRootHeaders) {
    notes.push("Skipped GET / security header assertions.");
  } else {
    const root = await expectStatus(baseUrl, { method: "GET", path: "/" }, [200], failures);
    for (const headerName of REQUIRED_SECURITY_HEADERS) {
      if (!root.response.headers.get(headerName)) {
        failures.push(`GET / is missing required security header: ${headerName}`);
      }
    }
    if (options.requireCsp && !root.response.headers.get("content-security-policy")) {
      failures.push("GET / is missing required security header: content-security-policy");
    } else if (!root.response.headers.get("content-security-policy")) {
      notes.push("GET / has no content-security-policy; rerun with --require-csp after CSP hardening lands.");
    }
  }

  const version = await expectStatus(baseUrl, { method: "GET", path: "/api/version" }, [200], failures);
  if (options.strictApiMetadata) {
    let payload = null;
    try {
      payload = JSON.parse(version.text);
    } catch {
      failures.push(`GET /api/version returned non-JSON body="${responseExcerpt(version.text)}"`);
    }
    if (payload && ("commit" in payload || "environment" in payload)) {
      failures.push("GET /api/version exposes commit or environment metadata");
    }
  } else {
    notes.push(
      "Skipped strict /api/version metadata assertion; rerun with --strict-api-metadata after metadata hardening lands.",
    );
  }

  if (options.strictMetadataRoutes) {
    for (const pathName of ["/.well-known/security.txt", "/robots.txt"]) {
      const result = await fetchText(makeUrl(baseUrl, pathName), { method: "GET" });
      const contentType = result.response.headers.get("content-type") ?? "";
      if (
        result.response.status === 200 &&
        contentType.includes("text/html") &&
        result.text.includes('<div id="root"')
      ) {
        failures.push(`GET ${pathName} returned the SPA shell`);
      }
    }
  } else {
    notes.push(
      "Skipped strict metadata route fallback assertions; rerun with --strict-metadata-routes after metadata route hardening lands.",
    );
  }

  if (options.strictAssets) {
    const jsAssets = assetPaths.filter((assetPath) => assetPath.endsWith(".js"));
    for (const assetPath of jsAssets) {
      await expectStatus(baseUrl, { method: "GET", path: `${assetPath}.map` }, [403, 404], failures);
    }
  }

  return { failures, notes };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const staticResult = await runStaticChecks(options);
  const httpResult = await runHttpChecks(options, staticResult.assetPaths);
  const failures = [...staticResult.failures, ...httpResult.failures];
  const notes = [...staticResult.notes, ...httpResult.notes];

  for (const note of notes) {
    console.log(`[unauth-exposure] note: ${note}`);
  }

  if (failures.length > 0) {
    console.error("[unauth-exposure] failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("[unauth-exposure] passed");
}

main().catch((error) => {
  console.error(`[unauth-exposure] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
