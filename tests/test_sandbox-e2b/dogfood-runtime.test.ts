import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const DOGFOOD_DOCKERFILE = resolve(REPO_ROOT, "Dockerfile.dogfood-runtime");
const DOGFOOD_COMPOSE = resolve(REPO_ROOT, "docker-compose.yml");
const BACKEND_TESTS_WORKFLOW = resolve(REPO_ROOT, ".github/workflows/backend-tests.yml");
const CYCLOID_CONFIG = resolve(REPO_ROOT, ".cycloid.json");
const SEED_LOCAL_SCRIPT = resolve(REPO_ROOT, "apps/control-plane-worker/scripts/seed-local.sh");
const DOGFOOD_HEALTHCHECK = resolve(REPO_ROOT, "scripts/dogfood-healthcheck.mjs");
const DOGFOOD_PREFLIGHT = resolve(REPO_ROOT, "scripts/dogfood-preflight.mjs");

describe("dogfood full-stack runtime", () => {
  const dockerfile = readFileSync(DOGFOOD_DOCKERFILE, "utf8");
  const compose = readFileSync(DOGFOOD_COMPOSE, "utf8");
  const backendTestsWorkflow = readFileSync(BACKEND_TESTS_WORKFLOW, "utf8");
  const cycloidConfig = readFileSync(CYCLOID_CONFIG, "utf8");
  const runtimeScript = readFileSync(resolve(REPO_ROOT, "scripts/dogfood-runtime.sh"), "utf8");
  const seedLocalScript = readFileSync(SEED_LOCAL_SCRIPT, "utf8");
  const healthcheckScript = readFileSync(DOGFOOD_HEALTHCHECK, "utf8");
  const preflightScript = readFileSync(DOGFOOD_PREFLIGHT, "utf8");

  it("installs the node-gyp toolchain required by native workspace dependencies", () => {
    expect(dockerfile).toContain("build-essential");
    expect(dockerfile).toContain("python3");
    expect(compose).toContain("scripts/dogfood-runtime.sh");
  });

  it("runs a local API plus UI and proxies UI auth/API requests to that API", () => {
    expect(compose).toContain("api:");
    expect(compose).toContain("ui:");
    expect(compose).toContain("DOGFOOD_SESSION_TOKEN: ${DOGFOOD_SESSION_TOKEN:-}");
    expect(compose).toContain("DOGFOOD_DEFAULT_REPO: ${DOGFOOD_DEFAULT_REPO:-trycycloid/cycloid}");
    expect(compose).toContain("ARCANIST_ADMIN_TOKEN: ${ARCANIST_ADMIN_TOKEN:-}");
    expect(compose).toContain("CONTROL_PLANE_URL: ${CONTROL_PLANE_URL:-}");
    expect(compose).toContain("E2B_API_KEY: ${E2B_API_KEY:-}");
    expect(compose).toContain("GITHUB_APP_ID: ${GITHUB_APP_ID:-}");
    expect(compose).toContain("GITHUB_PRIVATE_KEY: ${GITHUB_PRIVATE_KEY:-}");
    expect(compose).toContain("DOGFOOD_GITHUB_TOKEN: ${DOGFOOD_GITHUB_TOKEN:-}");
    expect(compose).toContain("GITHUB_USER_TOKEN: ${GITHUB_USER_TOKEN:-}");
    expect(compose).toContain("NGROK_DOMAIN: ${NGROK_DOMAIN:-}");
    expect(compose).toContain("NGROK_AUTHTOKEN: ${NGROK_AUTHTOKEN:-}");
    expect(compose).toContain("OPENAI_API_KEY_FOR_LOCAL_DEV: ${OPENAI_API_KEY_FOR_LOCAL_DEV:-}");
    expect(compose).toContain("SANDBOX_CALLBACK_SECRET: ${SANDBOX_CALLBACK_SECRET:-}");
    expect(compose).toContain("SANDBOX_RUNTIME_CLEANUP_SECRET: ${SANDBOX_RUNTIME_CLEANUP_SECRET:-}");
    expect(compose).toContain("TOKEN_ENCRYPTION_KEY: ${TOKEN_ENCRYPTION_KEY:-}");
    expect(compose).toContain("VITE_API_URL: http://api:3000");
    expect(compose).toContain("VITE_AUTH_URL: http://api:3000");
    expect(compose).toContain("condition: service_healthy");
    expect(compose).toContain("scripts/dogfood-healthcheck.mjs");
    expect(healthcheckScript).toContain("readFileSync(tokenPath");
    expect(healthcheckScript).toContain("/api/bootstrap");
    expect(healthcheckScript).not.toContain("refresh=true");
    expect(healthcheckScript).not.toContain("/api/repos");
    expect(healthcheckScript).toContain("AbortSignal.timeout(1200)");
    expect(healthcheckScript).toContain("defaultRepo");
    expect(compose).toContain("timeout: 3s");
    expect(compose).toContain("dogfood-ui-node-modules");
    expect(compose).toContain("dogfood-wrangler-state");
  });

  it("keeps dogfood Wrangler env outside the bind-mounted source tree", () => {
    expect(runtimeScript).toContain("DOGFOOD_ENV_FILE:-/tmp/cycloid-dogfood.env");
    expect(runtimeScript).toContain("env_var_value()");
    expect(runtimeScript).toContain('printenv "$key"');
    expect(runtimeScript).toContain('wrangler dev --env-file "$dogfood_env_file"');
    expect(runtimeScript).toContain("trap 'rm -f \"$tmp_sql\"' RETURN");
    expect(runtimeScript).toContain("random_hex()");
    expect(runtimeScript).toContain('dev_or_default "OPENAI_API_KEY_FOR_LOCAL_DEV"');
    expect(runtimeScript).toContain('dev_or_default "OPENAI_API_KEY_INTERNAL_REVIEW"');
    expect(runtimeScript).not.toContain("dogfood-local-token-encryption-key");
    expect(runtimeScript).not.toContain("dogfood-admin-token");
    expect(runtimeScript).not.toContain('WORKER_DIR/.dev.vars"');
  });

  it("seeds dogfood user settings with live columns only", () => {
    expect(runtimeScript).toContain(
      `INSERT INTO user_settings (
  user_id, default_pr_draft, auto_verify_enabled, use_codex_subscription,
  default_model, default_repo, created_at, updated_at
)`,
    );
    expect(runtimeScript).toContain("SELECT id, 0, 0, 0,");
    expect(runtimeScript).not.toContain("user_id, theme");
    expect(runtimeScript).not.toContain("auto_create_pr_enabled");
  });

  it("exposes the API service for local sandbox callbacks", () => {
    const appRuntime = JSON.parse(cycloidConfig).appRuntime;
    expect(appRuntime.additionalPorts).toEqual([{ service: "api", hostPort: 3000, containerPort: 3000 }]);
    expect(appRuntime.auth.credentials).toBeUndefined();
  });

  it("uses local E2B template defaults and rejects hosted callback URLs", () => {
    expect(runtimeScript).toContain("default_e2b_sandbox_template()");
    expect(runtimeScript).toContain("cycloid-sandbox-dev-%s");
    expect(runtimeScript).toContain("assert_local_control_plane_url");
    expect(runtimeScript).toContain("hosted Cycloid");
    expect(runtimeScript).toContain("http://app.trycycloid.com");
    expect(runtimeScript).toContain("http://qa.app.trycycloid.com");
    expect(runtimeScript).toContain("http://qa.trycycloid.com");
    expect(runtimeScript).not.toContain("cycloid-sandbox-dogfood");
  });

  it("normalizes local GitHub App private keys and seeds GitHub without gh in dogfood", () => {
    expect(runtimeScript).toContain("normalize_private_key_for_dev_vars()");
    expect(runtimeScript).toContain("seed_local_integrations");
    expect(runtimeScript).toContain("assert_dogfood_repo_credentials");
    expect(runtimeScript).toContain("warning: dogfood GitHub repo credential is missing");
    expect(runtimeScript).toContain("local-github-app-installation-token");
    expect(runtimeScript).toContain("GitHub App secrets alone cannot list user repositories");
    expect(runtimeScript).toContain("DOGFOOD_DEFAULT_REPO");
    expect(seedLocalScript).toContain("normalizePrivateKey");
    expect(seedLocalScript).toContain("read_first_env_or_dev_var");
    expect(seedLocalScript).toContain("seed_github_token_for_all_users_from_env");
    expect(seedLocalScript).toContain('"DOGFOOD_GITHUB_TOKEN" "GITHUB_USER_TOKEN"');
    expect(seedLocalScript).toContain("seed_github_installation_token_for_all_users");
    expect(seedLocalScript).toContain("seed_github_token_for_all_users_from_gh");
    expect(seedLocalScript).toContain("Skipping github_installations seed");
    expect(seedLocalScript).toContain("Seeded/refreshed GitHub installation token fallback");
    expect(seedLocalScript).toContain("local-github-app-installation-token");
    expect(seedLocalScript).toContain("Date.parse(installationAuth.expiresAt)");
    expect(seedLocalScript).toContain("oauth_expires_at = ${expiresAt}");
    expect(seedLocalScript).toContain("SELECT id, 'github', ${token}, NULL, ${expiresAt}");
    expect(seedLocalScript).toContain("service_url = excluded.service_url");
    expect(seedLocalScript).not.toContain("WHERE integration_id = 'github' AND external_user_id IS NULL");
  });

  it("fails dogfood preflight when the local user cannot see the target repo", () => {
    expect(preflightScript).toContain("dogfood.github_user_token");
    expect(preflightScript).toContain("DOGFOOD_GITHUB_TOKEN");
    expect(preflightScript).toContain("GitHub App installation tokens cannot populate /user/repos");
    expect(preflightScript).toContain("dogfood.github_user_repo_access");
    expect(preflightScript).toContain("ghAuthToken");
    expect(preflightScript).toContain('"gh", ["auth", "token"]');
    expect(preflightScript).toContain("/user/memberships/orgs");
    expect(preflightScript).toContain("SAML SSO");
    expect(preflightScript).toContain("dogfood.user_repos");
    expect(preflightScript).toContain('"/api/repos"');
    expect(preflightScript).toContain("dogfood.bootstrap_repos");
    expect(preflightScript).toContain('"/api/bootstrap"');
    expect(preflightScript).toContain("reposPending");
    expect(preflightScript).toContain("default repo");
  });

  it("generates the dogfood session token at runtime", () => {
    expect(cycloidConfig).toContain('"generatedComposeEnv"');
    expect(cycloidConfig).toContain('"DOGFOOD_SESSION_TOKEN"');
    expect(runtimeScript).toContain("DOGFOOD_SESSION_TOKEN_FILE");
    expect(runtimeScript).toContain('chmod 600 "$DOGFOOD_SESSION_TOKEN_FILE"');
    expect(cycloidConfig).not.toContain("cycloid-dogfood-session-token");
    expect(compose).not.toContain("cycloid-dogfood-session-token");
  });

  it("runs backend guardrails when dogfood runtime config changes", () => {
    expect(backendTestsWorkflow).toContain("Dockerfile\\.dogfood-runtime$");
    expect(backendTestsWorkflow).toContain("docker-compose\\.yml$");
    expect(backendTestsWorkflow).toContain("\\.cycloid\\.json$");
    expect(backendTestsWorkflow).toContain(
      "scripts\\/(cycloid-auth\\.mjs|dogfood-(e2e|runtime)\\.sh|dogfood-(healthcheck|preflight)\\.mjs)",
    );
  });
});
