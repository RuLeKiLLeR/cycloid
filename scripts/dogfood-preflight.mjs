#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = resolve(ROOT_DIR, "apps/control-plane-worker");
const DEV_VARS_PATH = resolve(WORKER_DIR, ".dev.vars");
const READY_PATH = resolve(ROOT_DIR, ".tmp/dogfood-ready.json");
const DOGFOOD_GITHUB_ID = 900000001;
const DOGFOOD_BUSINESS_ID = "dogfood-cycloid";
const DOGFOOD_GITHUB_APP_FALLBACK_SERVICE_URL = "local-github-app-installation-token";
const DEFAULT_TEMPLATE_SPEC = { cpuCount: 2, memoryMB: 4096 };
const REPO_TEMPLATE_SPECS = new Map([["trycycloid/cycloid", { cpuCount: 4, memoryMB: 8192 }]]);
const SANDBOX_TOKEN_PERMISSIONS = { contents: "write", pull_requests: "read" };
const GITHUB_API_BASE_URL = "https://api.github.com";

function toolPath(tool) {
  for (const baseDir of [ROOT_DIR, WORKER_DIR]) {
    const path = resolve(baseDir, "node_modules/.bin", tool);
    if (existsSync(path)) return path;
  }
  throw new Error(`${tool} is not installed; run npm ci or bash scripts/worktree-setup.sh first`);
}

function usage(exitCode = 2) {
  console.error(`Usage: node scripts/dogfood-preflight.mjs [--mode session|claude] [--skip-e2b] [--skip-e2b-template] [--skip-github]

Checks the running dogfood stack and exits non-zero on missing prerequisites.`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { mode: "session", skipE2b: false, skipE2bTemplate: false, skipGithub: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--mode" && argv[index + 1]) {
      args.mode = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--skip-e2b") {
      args.skipE2b = true;
      continue;
    }
    if (arg === "--skip-e2b-template") {
      args.skipE2bTemplate = true;
      continue;
    }
    if (arg === "--skip-github") {
      args.skipGithub = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["session", "claude"].includes(args.mode)) throw new Error("--mode must be session or claude");
  return args;
}

function parseDevVars(path) {
  const values = new Map();
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([^#=\s][^=]*)=(.*)$/.exec(line);
    if (match) values.set(match[1], match[2].trim());
  }
  return values;
}

function readReady() {
  if (!existsSync(READY_PATH)) return {};
  return JSON.parse(readFileSync(READY_PATH, "utf8"));
}

function writeReady(value) {
  writeFileSync(READY_PATH, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function normalizePrivateKey(raw) {
  let key = String(raw || "")
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/\\n/g, "\n");
  if (!key.includes("\n")) {
    const match = key.match(/^(-----BEGIN [^-]+-----)\s+(.+?)\s+(-----END [^-]+-----)$/);
    if (match) {
      const body = match[2].replace(/\s+/g, "");
      const chunks = body.match(/.{1,64}/g) ?? [];
      key = [match[1], ...chunks, match[3]].join("\n");
    }
  }
  return key;
}

function firstValue(values, keys) {
  for (const key of keys) {
    const value = values.get(key)?.trim();
    if (value) return value;
  }
  return "";
}

function firstEnvOrDevValue(values, keys) {
  for (const key of keys) {
    const envValue = process.env[key]?.trim();
    if (envValue) return envValue;
    const devValue = values.get(key)?.trim();
    if (devValue) return devValue;
  }
  return "";
}

function ghAuthToken() {
  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function githubUserToken(values) {
  return firstEnvOrDevValue(values, ["DOGFOOD_GITHUB_TOKEN", "GITHUB_USER_TOKEN"]) || ghAuthToken();
}

function isBadControlPlaneUrl(raw) {
  if (!raw) return true;
  try {
    const url = new URL(raw);
    return [
      "localhost",
      "127.0.0.1",
      "0.0.0.0",
      "app.trycycloid.com",
      "qa.app.trycycloid.com",
      "qa.trycycloid.com",
    ].includes(url.hostname);
  } catch {
    return true;
  }
}

async function fetchStatus(url, init = {}) {
  return await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
}

async function fetchDogfoodJson(apiUrl, path, token) {
  const response = await fetchStatus(new URL(path, apiUrl), {
    headers: {
      accept: "application/json",
      cookie: `session_token=${token}`,
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${path} returned HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return await response.json();
}

async function fetchGithub(path, token) {
  return await fetch(`${GITHUB_API_BASE_URL}${path}`, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "cycloid-dogfood-preflight",
    },
  });
}

async function fetchGithubJson(path, token, label) {
  const response = await fetchGithub(path, token);
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}`);
  }
  return { response, data: await response.json() };
}

function d1Json(command) {
  const output = execFileSync(
    toolPath("wrangler"),
    ["d1", "execute", "DB", "--local", "--json", "--command", command],
    {
      cwd: WORKER_DIR,
      env: {
        ...process.env,
        PATH: `${resolve(ROOT_DIR, "node_modules/.bin")}:${resolve(WORKER_DIR, "node_modules/.bin")}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return JSON.parse(output)?.[0]?.results ?? [];
}

function normalizeRepoFullName(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function repoFullName(repo) {
  if (!repo || typeof repo !== "object") return "";
  return normalizeRepoFullName(repo.fullName);
}

function assertRepoPayloadIncludes(payload, expectedRepos, label) {
  if (!payload || !Array.isArray(payload.repos)) {
    throw new Error(`${label} did not return a repository list`);
  }
  const visibleRepos = new Set(payload.repos.map(repoFullName).filter(Boolean));
  const missingRepos = expectedRepos
    .map(normalizeRepoFullName)
    .filter(Boolean)
    .filter((repo) => !visibleRepos.has(repo));
  if (missingRepos.length > 0) {
    throw new Error(`${label} is missing ${missingRepos.join(", ")}; visible repo count=${visibleRepos.size}`);
  }
  return visibleRepos;
}

function assertBootstrapRepos(payload, expectedRepos, defaultRepo) {
  if (payload?.authenticated !== true) throw new Error("/api/bootstrap rejected the dogfood session token");
  if (payload?.reposPending === true) {
    throw new Error("/api/bootstrap still reports reposPending after /api/repos preflight");
  }
  const visibleRepos = assertRepoPayloadIncludes(payload, expectedRepos, "/api/bootstrap");
  const normalizedDefaultRepo = normalizeRepoFullName(defaultRepo);
  if (normalizedDefaultRepo && !visibleRepos.has(normalizedDefaultRepo)) {
    throw new Error(`/api/bootstrap default repo ${defaultRepo} is not visible to dogfood`);
  }
}

function checkDogfoodGithubUserCredential() {
  const escapedFallback = DOGFOOD_GITHUB_APP_FALLBACK_SERVICE_URL.replace(/'/g, "''");
  const rows = d1Json(`SELECT COUNT(*) AS count
    FROM users
    JOIN user_integrations ON user_integrations.user_id = users.id
    WHERE users.github_id = ${DOGFOOD_GITHUB_ID}
      AND user_integrations.integration_id = 'github'
      AND COALESCE(user_integrations.oauth_access_token, '') != ''
      AND (
        user_integrations.service_url IS NULL
        OR user_integrations.service_url != '${escapedFallback}'
      );`);
  if (Number(rows[0]?.count ?? 0) < 1) {
    throw new Error(
      "missing dogfood GitHub user token; set DOGFOOD_GITHUB_TOKEN for the shell that runs npm run dogfood:e2e and rerun. GitHub App installation tokens cannot populate /user/repos.",
    );
  }
}

async function checkGithubUserRepoAccess(values, repoFullNameValue) {
  const token = githubUserToken(values);
  if (!token) {
    throw new Error("DOGFOOD_GITHUB_TOKEN/GITHUB_USER_TOKEN is not set and gh auth token is unavailable");
  }

  const [owner, repo] = repoFullNameValue.split("/");
  if (!owner || !repo) throw new Error(`invalid default repo: ${repoFullNameValue}`);

  const user = await fetchGithubJson("/user", token, "GitHub user probe");
  const login = typeof user.data?.login === "string" ? user.data.login : "unknown";

  const visibleRepos = new Set();
  const ssoHeaders = [];
  for (let page = 1; page <= 20; page += 1) {
    const repos = await fetchGithubJson(
      `/user/repos?sort=updated&per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`,
      token,
      "GitHub /user/repos probe",
    );
    const ssoHeader = repos.response.headers.get("x-github-sso");
    if (ssoHeader) ssoHeaders.push(ssoHeader);
    const pageRepos = Array.isArray(repos.data) ? repos.data : [];
    for (const item of pageRepos) {
      if (typeof item?.full_name === "string") visibleRepos.add(item.full_name.toLowerCase());
    }
    if (pageRepos.length < 100) break;
  }

  const normalizedRepo = normalizeRepoFullName(repoFullNameValue);
  if (visibleRepos.has(normalizedRepo)) return;

  const directRepo = await fetchGithub(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token);
  const membership = await fetchGithub(`/user/memberships/orgs/${encodeURIComponent(owner)}`, token);
  let membershipState = "";
  if (membership.ok) {
    const body = await membership.json().catch(() => null);
    membershipState = typeof body?.state === "string" ? body.state : "unknown";
  }

  const ssoDetail = ssoHeaders.length > 0 ? ` GitHub SSO header: ${ssoHeaders.join(" | ")}` : "";
  if (membership.status === 404) {
    throw new Error(
      `DOGFOOD_GITHUB_TOKEN belongs to ${login}, but that account is not an active member of ${owner} or cannot see the org membership. /repos/${repoFullNameValue} returned HTTP ${directRepo.status}.${ssoDetail}`,
    );
  }
  if (membership.ok && membershipState && membershipState !== "active") {
    throw new Error(
      `DOGFOOD_GITHUB_TOKEN belongs to ${login}, but ${owner} membership is ${membershipState}. /repos/${repoFullNameValue} returned HTTP ${directRepo.status}.${ssoDetail}`,
    );
  }
  if (ssoHeaders.length > 0) {
    throw new Error(
      `DOGFOOD_GITHUB_TOKEN belongs to ${login}, but GitHub withheld ${owner} repos from /user/repos, likely because the token needs SAML SSO authorization.${ssoDetail}`,
    );
  }
  throw new Error(
    `DOGFOOD_GITHUB_TOKEN belongs to ${login}, but /user/repos did not include ${repoFullNameValue}; /repos/${repoFullNameValue} returned HTTP ${directRepo.status}. Ensure the account has repo access and the token has repo scope.`,
  );
}

async function checkGithubRepos(values, repos) {
  const [{ createAppAuth }, { Octokit }] = await Promise.all([import("@octokit/auth-app"), import("@octokit/rest")]);
  const appId = values.get("GITHUB_APP_ID");
  const privateKey = normalizePrivateKey(values.get("GITHUB_PRIVATE_KEY"));
  if (!appId || !privateKey) throw new Error("GITHUB_APP_ID/GITHUB_PRIVATE_KEY missing");

  const octokit = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });

  for (const repo of repos) {
    const [owner, name] = repo.split("/");
    if (!owner || !name) throw new Error(`invalid repo catalog entry: ${repo}`);
    const escapedOwner = owner.replace(/'/g, "''");
    const dbRows = d1Json(
      `SELECT installation_id FROM github_installations WHERE owner_login = '${escapedOwner}' LIMIT 1;`,
    );
    if (dbRows.length === 0) throw new Error(`missing github_installations row for ${owner}`);
    const installationId = Number(dbRows[0].installation_id);
    if (!Number.isInteger(installationId) || installationId <= 0) {
      throw new Error(`invalid github_installations.installation_id for ${owner}`);
    }
    const installation = await octokit.apps.getInstallation({ installation_id: installationId });
    const installedOwner =
      installation.data.account && "login" in installation.data.account ? installation.data.account.login : "";
    if (installedOwner.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(`DB installation ${installationId} belongs to ${installedOwner || "unknown"}, not ${owner}`);
    }
    const installationAuth = await octokit.apps.createInstallationAccessToken({
      installation_id: installationId,
      repositories: [name],
      permissions: SANDBOX_TOKEN_PERMISSIONS,
    });
    const repoResponse = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${installationAuth.data.token}`,
        "user-agent": "cycloid-dogfood-preflight",
      },
    });
    if (!repoResponse.ok) throw new Error(`GitHub repo read failed for ${repo}: HTTP ${repoResponse.status}`);
  }
}

async function checkE2B(values) {
  const { Sandbox } = await import("e2b");
  const apiKey = values.get("E2B_API_KEY");
  if (!apiKey) throw new Error("E2B_API_KEY missing");
  const paginator = Sandbox.list({
    apiKey,
    ...(values.get("E2B_DOMAIN") ? { domain: values.get("E2B_DOMAIN") } : {}),
    limit: 1,
    query: { state: ["running", "paused"] },
  });
  await paginator.nextItems();
}

function resolveE2BTemplate(values, repo) {
  const base = values.get("E2B_SANDBOX_TEMPLATE") || `cycloid-sandbox-dev-${process.env.USER || "local"}`;
  const normalizedRepo = repo.trim().toLowerCase();
  const explicitTemplate = parseRepoTemplateMap(
    [values.get("E2B_REPO_SANDBOX_TEMPLATE"), values.get("E2B_REPO_SANDBOX_TEMPLATES")].filter(Boolean).join(","),
  ).get(normalizedRepo);
  if (explicitTemplate) return explicitTemplate;
  const spec = REPO_TEMPLATE_SPECS.get(normalizedRepo) || DEFAULT_TEMPLATE_SPEC;
  return `${base}-mem${spec.memoryMB}-cpu${spec.cpuCount}`;
}

function parseRepoTemplateMap(raw) {
  const map = new Map();
  for (const item of String(raw || "").split(",")) {
    const [repo, template, ...extra] = item.split(":").map((part) => part.trim());
    if (!repo && !template) continue;
    if (!repo || !template || extra.length > 0) throw new Error(`invalid E2B_REPO_SANDBOX_TEMPLATES entry: ${item}`);
    map.set(repo.toLowerCase(), template);
  }
  return map;
}

async function checkE2BTemplate(values, template) {
  const { Sandbox } = await import("e2b");
  const apiKey = values.get("E2B_API_KEY");
  if (!apiKey) throw new Error("E2B_API_KEY missing");
  let sandbox;
  try {
    sandbox = await Sandbox.create(template, {
      apiKey,
      ...(values.get("E2B_DOMAIN") ? { domain: values.get("E2B_DOMAIN") } : {}),
      timeoutMs: 300_000,
      lifecycle: {
        onTimeout: "pause",
        autoResume: false,
      },
    });
    const command = await sandbox.commands.run("echo cycloid-e2b-ok", { timeoutMs: 30_000 });
    if (command.exitCode !== 0 || !command.stdout.includes("cycloid-e2b-ok")) {
      throw new Error(`template smoke command failed with exit ${command.exitCode}`);
    }
  } catch (error) {
    throw new Error(`template ${template} failed smoke: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (sandbox) await sandbox.kill().catch(() => {});
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const values = parseDevVars(DEV_VARS_PATH);
  const ready = readReady();
  const apiUrl = "http://127.0.0.1:3000";
  const uiUrl = "http://127.0.0.1:5173";
  const controlPlaneUrl = values.get("CONTROL_PLANE_URL") || "";
  const token = process.env.DOGFOOD_SESSION_TOKEN || ready.dogfoodSessionToken || "";
  const repos = Array.isArray(ready.repos)
    ? ready.repos
    : (values.get("DOGFOOD_REPOS") || "trycycloid/cycloid")
        .split(",")
        .map((repo) => repo.trim())
        .filter(Boolean);
  const defaultRepo = ready.defaultRepo || values.get("DOGFOOD_DEFAULT_REPO") || repos[0] || "trycycloid/cycloid";
  const e2bTemplate = resolveE2BTemplate(values, defaultRepo);
  const checks = [];

  async function check(name, fn) {
    try {
      await fn();
      checks.push({ name, status: "ok" });
    } catch (error) {
      checks.push({ name, status: "failed", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  await check("dev.vars", () => {
    if (!existsSync(DEV_VARS_PATH)) throw new Error(".dev.vars not found");
  });
  await check("dogfood.ready_file", () => {
    if (!existsSync(READY_PATH)) throw new Error(".tmp/dogfood-ready.json not found; run npm run dogfood:prepare");
  });
  await check("dogfood.auth_token", () => {
    if (!token) throw new Error("DOGFOOD_SESSION_TOKEN missing");
  });
  await check("local.api", async () => {
    const response = await fetchStatus(`${apiUrl}/api/health`);
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  });
  await check("local.ui_auth", async () => {
    const response = await fetchStatus(`${uiUrl}/auth/status`, { headers: { cookie: `session_token=${token}` } });
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data?.authenticated !== true) throw new Error("dogfood token rejected");
  });
  await check("control_plane_url", () => {
    if (isBadControlPlaneUrl(controlPlaneUrl)) throw new Error("CONTROL_PLANE_URL must be a public local tunnel");
  });
  await check("tunnel.health", async () => {
    const response = await fetchStatus(new URL("/api/health", controlPlaneUrl));
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  });
  await check("tunnel.websocket", async () => {
    const response = await fetchStatus(
      new URL("/api/sessions/dogfood-local-preflight/ws?type=sandbox", controlPlaneUrl),
    );
    if (response.status !== 426) throw new Error(`HTTP ${response.status}, expected 426`);
  });
  await check("dogfood.admin", () => {
    const rows = d1Json(`SELECT COUNT(*) AS count
      FROM users
      JOIN business_members ON business_members.user_id = users.id
      WHERE users.github_id = ${DOGFOOD_GITHUB_ID}
        AND business_members.business_id = '${DOGFOOD_BUSINESS_ID}'
        AND business_members.role = 'admin';`);
    if (Number(rows[0]?.count ?? 0) < 1) throw new Error("dogfood admin membership missing");
  });
  await check("dogfood.github_user_token", () => {
    if (args.skipGithub) return;
    checkDogfoodGithubUserCredential();
  });
  await check("dogfood.github_user_repo_access", async () => {
    if (args.skipGithub) return;
    await checkGithubUserRepoAccess(values, defaultRepo);
  });
  await check("dogfood.user_repos", async () => {
    if (args.skipGithub) return;
    const data = await fetchDogfoodJson(apiUrl, "/api/repos", token);
    assertRepoPayloadIncludes(data, repos, "/api/repos");
  });
  await check("dogfood.bootstrap_repos", async () => {
    if (args.skipGithub) return;
    const data = await fetchDogfoodJson(apiUrl, "/api/bootstrap", token);
    assertBootstrapRepos(data, repos, defaultRepo);
  });
  await check("model.openai", () => {
    if (!firstValue(values, ["OPENAI_API_KEY", "OPENAI_API_KEY_INTERNAL_REVIEW", "ARCANIST_OPENAI_API_KEY"])) {
      throw new Error("OpenAI key missing");
    }
  });
  if (args.mode === "claude") {
    await check("model.anthropic", () => {
      if (!firstValue(values, ["ANTHROPIC_API_KEY", "ARCANIST_ANTHROPIC_API_KEY"])) {
        throw new Error("Anthropic key missing");
      }
    });
  }
  await check("e2b.auth", async () => {
    if (args.skipE2b) return;
    await checkE2B(values);
  });
  await check("e2b.template", async () => {
    if (args.skipE2b || args.skipE2bTemplate) return;
    await checkE2BTemplate(values, e2bTemplate);
  });
  await check("github.repos", async () => {
    if (args.skipGithub) return;
    await checkGithubRepos(values, repos);
  });

  const failed = checks.filter((item) => item.status === "failed");
  console.error(`dogfood preflight: ${failed.length === 0 ? "ok" : "failed"}`);
  for (const item of checks) {
    console.error(`- ${item.name}: ${item.status}${item.detail ? ` (${item.detail})` : ""}`);
  }
  if (failed.length > 0) {
    console.error("next: fix the failed prerequisite, then rerun npm run dogfood:e2e");
    process.exit(1);
  }

  writeReady({ ...ready, e2bTemplate });

  console.error("dogfood ready");
  console.error(`UI=${uiUrl}`);
  console.error(`API=${apiUrl}`);
  console.error(`CONTROL_PLANE_URL=${controlPlaneUrl}`);
  console.error("AUTH_STATE=/tmp/cycloid-auth/dogfood/storage-state.json");
  console.error(`REPOS=${repos.join(",")}`);
  console.error(`E2B_TEMPLATE=${e2bTemplate}`);
}

run().catch((error) => {
  console.error("dogfood preflight: failed");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
