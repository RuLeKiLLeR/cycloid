import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Sandbox } from "e2b";

import { stringifyError } from "../shared/utils/errors.js";

function loadWorkerDevVars(): void {
  const devVarsPath = resolve("apps/control-plane-worker/.dev.vars");
  if (!existsSync(devVarsPath)) return;

  const content = readFileSync(devVarsPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function parseTimeoutMs(value: string | undefined): number {
  if (!value) return 300_000;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid E2B_SANDBOX_TIMEOUT_MS: ${value}`);
  }
  return parsed;
}

function templateFromArgv(): string | undefined {
  const argv = process.argv;
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--template" && argv[index + 1]) return argv[index + 1].trim();
  }
  return undefined;
}

loadWorkerDevVars();

const apiKey = process.env.E2B_API_KEY?.trim();
// `E2B_SANDBOX_TEMPLATE` is the bare stem the worker appends a `-mem<MB>-cpu<N>`
// suffix to, so it is not itself a buildable template name. Callers that need a
// concrete built template (CI smoke) pass the resolved name via `--template`.
const template = templateFromArgv() ?? process.env.E2B_SANDBOX_TEMPLATE?.trim();
const timeoutMs = parseTimeoutMs(process.env.E2B_SANDBOX_TIMEOUT_MS);
const githubToken = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
const ALLOWED_HOST = "api.github.com";
const ALLOWED_URL = `https://${ALLOWED_HOST}`;
const ALLOWED_CLOUDFLARE_HOST = "app.trycycloid.com";
const ALLOWED_CLOUDFLARE_URL = `https://${ALLOWED_CLOUDFLARE_HOST}`;
// This stays off the session allowlist but is Cloudflare-fronted, so a passing
// smoke proves we are no longer trusting provider-wide Cloudflare CIDRs.
const DENIED_HOST = "www.cloudflare.com";
const DENIED_URL = `https://${DENIED_HOST}`;

if (!apiKey) throw new Error("E2B_API_KEY is required");
if (!template) throw new Error("E2B_SANDBOX_TEMPLATE or --template is required");

const sandbox = await Sandbox.create(template, {
  apiKey,
  timeoutMs,
  lifecycle: {
    onTimeout: "pause",
    autoResume: false,
  },
  metadata: {
    runtime_provider: "e2b",
    purpose: "egress_smoke",
  },
});

try {
  const result = await sandbox.commands.run(
    [
      "set -euo pipefail",
      `ALLOWED_HOST="${ALLOWED_HOST}"`,
      `ALLOWED_URL="${ALLOWED_URL}"`,
      `ALLOWED_CLOUDFLARE_HOST="${ALLOWED_CLOUDFLARE_HOST}"`,
      `ALLOWED_CLOUDFLARE_URL="${ALLOWED_CLOUDFLARE_URL}"`,
      `DENIED_HOST="${DENIED_HOST}"`,
      `DENIED_URL="${DENIED_URL}"`,
      'export ARCANIST_SANDBOX_EGRESS_ALLOWLIST="${ALLOWED_HOST},${ALLOWED_CLOUDFLARE_HOST}"',
      'if [ -n "${GITHUB_TOKEN:-}" ]; then',
      '  export ARCANIST_GITHUB_META_TOKEN="${GITHUB_TOKEN}"',
      '  sudo -E /usr/local/sbin/cycloid-enforce-egress "${ARCANIST_SANDBOX_EGRESS_ALLOWLIST}"',
      "  unset ARCANIST_GITHUB_META_TOKEN",
      "else",
      '  sudo /usr/local/sbin/cycloid-enforce-egress "${ARCANIST_SANDBOX_EGRESS_ALLOWLIST}"',
      "fi",
      'CURL_PATH="$(command -v curl)"',
      'if [ "${CURL_PATH}" != "/usr/local/bin/curl" ]; then',
      '  echo "unexpected curl path: ${CURL_PATH}" >&2',
      "  exit 1",
      "fi",
      'grep -q "curl to non-allowlisted domain" /usr/local/bin/curl || {',
      '  echo "curl wrapper missing hostname allowlist policy" >&2',
      "  exit 1",
      "}",
      'ALLOWED_IP="$(awk -v domain="${ALLOWED_HOST}" \'index($0, "[egress] allowed domain=" domain " ip=") { ip=$0; sub(/^.* ip=/, "", ip); if (index(ip, ":") == 0) { print ip; exit } }\' /var/log/cycloid-egress.log)"',
      'test -n "${ALLOWED_IP}"',
      'ALLOWED_CLOUDFLARE_IP="$(awk -v domain="${ALLOWED_CLOUDFLARE_HOST}" \'index($0, "[egress] allowed domain=" domain " ip=") { ip=$0; sub(/^.* ip=/, "", ip); if (index(ip, ":") == 0) { print ip; exit } }\' /var/log/cycloid-egress.log)"',
      'test -n "${ALLOWED_CLOUDFLARE_IP}"',
      'if curl -fsS --connect-timeout 10 "${DENIED_URL}" >/tmp/egress-denied.out 2>&1; then',
      '  echo "${DENIED_HOST} unexpectedly succeeded" >&2',
      "  exit 1",
      "fi",
      'grep -q "blocked domain=${DENIED_HOST} tool=curl" /var/log/cycloid-egress.log',
      'curl_args=(-4 -fsS --connect-timeout 10 --resolve "${ALLOWED_HOST}:443:${ALLOWED_IP}")',
      'if [ -n "${GITHUB_TOKEN:-}" ]; then',
      '  curl_args+=(-H "Authorization: Bearer ${GITHUB_TOKEN}" -H "X-GitHub-Api-Version: 2022-11-28")',
      "fi",
      'curl "${curl_args[@]}" "${ALLOWED_URL}" >/tmp/egress-allowed.out',
      'curl -4 -fsS --connect-timeout 10 --resolve "${ALLOWED_CLOUDFLARE_HOST}:443:${ALLOWED_CLOUDFLARE_IP}" "${ALLOWED_CLOUDFLARE_URL}" >/tmp/egress-allowed-cloudflare.out',
      'echo "egress-smoke-ok"',
    ].join("\n"),
    {
      timeoutMs,
      ...(githubToken ? { envs: { GITHUB_TOKEN: githubToken } } : {}),
    },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(`egress smoke failed with exit code ${result.exitCode}`);
  }
  console.log(
    JSON.stringify(
      {
        sandboxId: sandbox.sandboxId,
        template,
        deniedUrl: DENIED_URL,
        allowedUrl: ALLOWED_URL,
        allowedCloudflareUrl: ALLOWED_CLOUDFLARE_URL,
      },
      null,
      2,
    ),
  );
} finally {
  await Sandbox.kill(sandbox.sandboxId, { apiKey }).catch((error) => {
    console.warn(`[egress-smoke] failed to kill sandbox: ${stringifyError(error)}`);
  });
}
