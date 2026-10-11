#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE_REQUIRED_SECRETS = [
  "E2B_API_KEY",
  "SANDBOX_CALLBACK_SECRET",
  "SANDBOX_RUNTIME_CLEANUP_SECRET",
  "TURNSTILE_SECRET_KEY",
];

const BASE_REQUIRED_CONFIG = [
  // Public Turnstile site key rendered into the browser challenge page.
  "TURNSTILE_SITE_KEY",
];

const OAUTH_REQUIRED_SECRETS = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "JIRA_OAUTH_CLIENT_ID",
  "JIRA_OAUTH_CLIENT_SECRET",
  "LINEAR_OAUTH_CLIENT_ID",
  "LINEAR_OAUTH_CLIENT_SECRET",
  "NOTION_OAUTH_CLIENT_ID",
  "NOTION_OAUTH_CLIENT_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
];

const OAUTH_REQUIRED_SECRETS_BY_PROVIDER = {
  github: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
  jira: ["JIRA_OAUTH_CLIENT_ID", "JIRA_OAUTH_CLIENT_SECRET"],
  linear: ["LINEAR_OAUTH_CLIENT_ID", "LINEAR_OAUTH_CLIENT_SECRET"],
  notion: ["NOTION_OAUTH_CLIENT_ID", "NOTION_OAUTH_CLIENT_SECRET"],
  slack: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"],
};

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isMissing(value) {
  const cleaned = clean(value);
  return cleaned.length === 0 || cleaned === "CHANGE_ME";
}

function requiredOauthSecretsFor(options = {}) {
  const providers = options.oauthProviders;
  if (!providers) return OAUTH_REQUIRED_SECRETS;

  return providers.flatMap((provider) => {
    const required = OAUTH_REQUIRED_SECRETS_BY_PROVIDER[provider];
    if (!required) {
      throw new Error(
        `Unknown OAuth provider '${provider}'. Expected one of: ${Object.keys(OAUTH_REQUIRED_SECRETS_BY_PROVIDER).join(", ")}`,
      );
    }
    return required;
  });
}

export function validateControlPlaneSecrets(secrets, options = {}) {
  const errors = [];
  // `freestyleOnly` runs just the Freestyle guarantees, skipping the base/config/
  // oauth checks, so a caller can assert them without the whole SSM bundle in hand.
  // scripts/assert-freestyle-key.mjs uses it on EVERY prod deploy (ARC-1492): it feeds
  // just { FREESTYLE_API_KEY } read via the permitted SSM path-read, so app/workflow-
  // only deploys that skip secret sync still can't ship routing on with a bad key. The
  // sync_secrets steps run this validator in full-bundle mode (--env=...).
  if (!options.freestyleOnly) {
    const missingBase = BASE_REQUIRED_SECRETS.filter((key) => isMissing(secrets[key]));
    if (missingBase.length > 0) {
      errors.push(`Missing required SSM-backed Worker secrets: ${missingBase.join(", ")}`);
    }
    const missingConfig = BASE_REQUIRED_CONFIG.filter((key) => isMissing(secrets[key]));
    if (missingConfig.length > 0) {
      errors.push(`Missing required SSM-backed Worker config values: ${missingConfig.join(", ")}`);
    }
    const missingOauth = requiredOauthSecretsFor(options).filter((key) => isMissing(secrets[key]));
    if (missingOauth.length > 0) {
      errors.push(`Missing required SSM-backed OAuth config: ${missingOauth.join(", ")}`);
    }
  }
  // Fail closed when Freestyle routing is enabled without a real key: an override
  // shipped with a missing/CHANGE_ME FREESTYLE_API_KEY deploys green, then every
  // routed session fails at spawn. Conditional (not in BASE_REQUIRED_SECRETS) so
  // envs with the override unset — e.g. QA — do not hard-fail on a placeholder key.
  if (options.requireFreestyleKey) {
    if (isMissing(secrets.FREESTYLE_API_KEY)) {
      errors.push(
        "FREESTYLE_API_KEY is missing or a placeholder, but FREESTYLE_SANDBOX_BACKEND_OVERRIDE is set for this environment (Freestyle routing enabled)",
      );
    }
    // ARC-1480: same conditional for the snapshot id (a wrangler var, threaded in via
    // options.freestyleSnapshotId). Without it every routed session cold-boots a bare
    // Debian VM with no bridge bundle and dies at the 90s watchdog; the runtime now
    // also fails closed (buildRuntimeClientConfig), this check moves the signal to
    // deploy time.
    if (isMissing(options.freestyleSnapshotId)) {
      errors.push(
        "FREESTYLE_DEFAULT_SNAPSHOT_ID is missing or a placeholder, but FREESTYLE_SANDBOX_BACKEND_OVERRIDE is set for this environment (Freestyle routing enabled)",
      );
    }
  }
  return errors;
}

const WRANGLER_TOML = "apps/control-plane-worker/wrangler.toml";

// Parse the right-hand side of a wrangler `[vars]` assignment into its string value.
// Handles the two single-line scalar-string forms wrangler config uses: TOML basic
// (double-quoted, JSON escapes) and literal (single-quoted, verbatim), each with an
// optional trailing inline comment. Returns { value } on success.
//
// A present-but-unrecognized value (bare token, array, multiline, differently quoted)
// is NOT silently dropped: it returns { unparseable: true } so the reader can FAIL
// LOUD. Treating an unknown format as "absent" is exactly the silent-disarm this guard
// exists to prevent — it would flip requireFreestyleKey to false and let a routing-on,
// keyless deploy pass CI, then fail every routed session at spawn.
function parseWranglerScalarValue(rhs) {
  const trimmed = rhs.trim();
  const double = trimmed.match(/^"((?:\\.|[^"])*)"\s*(?:#.*)?$/);
  if (double) return { value: JSON.parse(`"${double[1]}"`) };
  const single = trimmed.match(/^'([^']*)'\s*(?:#.*)?$/);
  if (single) return { value: single[1] };
  return { unparseable: true };
}

// Read a public [vars] value for the given env straight from wrangler.toml so the
// validator sees the same override the worker will deploy with (no value threading
// through the workflow). production => [vars]; qa => [env.qa.vars].
//
// Returns null ONLY when the key is genuinely absent (its table is missing, or no
// matching assignment line exists in it) — a legitimate "routing off" state. When the
// key line IS present but its value is in a format this reader does not understand, it
// THROWS rather than returning null: a parse miss on a present key must fail closed at
// the deploy gate, never masquerade as "unset". Tolerant of leading indentation and
// both quote styles so a benign reformat of wrangler.toml does not disarm the guard.
export function readWranglerVar(env, key, tomlPath = WRANGLER_TOML) {
  const section = env === "qa" ? "env.qa.vars" : "vars";
  let text;
  try {
    text = readFileSync(tomlPath, "utf8");
  } catch {
    return null;
  }
  const start = text.indexOf(`[${section}]`);
  if (start < 0) return null;
  const keyLine = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`);
  for (const rawLine of text.slice(start).split("\n").slice(1)) {
    const line = rawLine.replace(/\r$/, "");
    if (/^\s*\[[^\]]+\]/.test(line)) break;
    const match = line.match(keyLine);
    if (!match) continue;
    const parsed = parseWranglerScalarValue(match[1]);
    if (parsed.unparseable) {
      throw new Error(
        `Cannot parse wrangler var ${key} in [${section}]: unsupported value format. ` +
          `Only single-line double- or single-quoted strings are supported — fix ${tomlPath} ` +
          `or extend readWranglerVar. Refusing to treat a present key as unset (fail closed).`,
      );
    }
    return parsed.value;
  }
  return null;
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error(
      "Usage: node scripts/validate-control-plane-secrets.mjs <secrets-json-path> [--env=production|qa] [--oauth=github,jira,linear,notion,slack]",
    );
    process.exit(2);
  }

  const oauthArg = process.argv.find((arg) => arg.startsWith("--oauth="));
  const oauthProviders = oauthArg
    ? oauthArg
        .slice("--oauth=".length)
        .split(",")
        .map((provider) => provider.trim())
        .filter(Boolean)
    : undefined;

  const envArg = process.argv.find((arg) => arg.startsWith("--env="));
  const env = envArg ? envArg.slice("--env=".length).trim() : "production";
  const freestyleOnly = process.argv.includes("--freestyle-only");
  let errors;
  try {
    // readWranglerVar THROWS when a routing var is present but in an unparseable
    // format; that must fail the validation loudly (fail closed at the gate), never
    // fall through to requireFreestyleKey=false and disarm the guard.
    const freestyleOverride = clean(readWranglerVar(env, "FREESTYLE_SANDBOX_BACKEND_OVERRIDE"));
    const requireFreestyleKey = freestyleOverride.length > 0;
    const freestyleSnapshotId = clean(readWranglerVar(env, "FREESTYLE_DEFAULT_SNAPSHOT_ID"));
    const secrets = JSON.parse(readFileSync(path, "utf8"));
    errors = validateControlPlaneSecrets(secrets, {
      oauthProviders,
      requireFreestyleKey,
      freestyleOnly,
      freestyleSnapshotId,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
