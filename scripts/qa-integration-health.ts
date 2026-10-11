import { stringifyError } from "../shared/utils/errors.js";
/* eslint-disable no-console */

const DEFAULT_QA_BASE_URL = "https://qa.app.trycycloid.com";
const KNOWN_FIXTURES = new Set(["cloudflare", "datadog", "braintrust"]);

type FixtureStatus = "configured" | "missing" | "invalid_config";

interface QaIntegrationFixtureHealth {
  integrationId: string;
  status: FixtureStatus;
  reason: string;
  env: {
    required: string[];
    present: string[];
    missing: string[];
  };
  credentialRow: "present" | "missing";
  scope: "business" | "user" | "disabled" | "missing";
}

export interface QaIntegrationHealthResponse {
  ok: true;
  workerEnv: string | null;
  businessId: string;
  fixtures: QaIntegrationFixtureHealth[];
}

interface CliOptions {
  baseUrl: string;
  requireFixtures: string[];
  json: boolean;
}

interface HealthEvaluation {
  ok: boolean;
  failures: string[];
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function usage(): string {
  return [
    "Usage: ARCANIST_ADMIN_TOKEN=<qa token> npm run qa:integration-health -- [options]",
    "",
    "Options:",
    "  --base-url <url>             QA frontend/API base URL. Defaults to https://qa.app.trycycloid.com.",
    "  --require <list>             Comma-separated fixtures that must be configured: cloudflare,datadog,braintrust,all.",
    "  --json                       Print raw safe health JSON.",
    "  -h, --help                   Show this help.",
  ].join("\n");
}

function parseRequiredFixtures(value: string): string[] {
  const requested = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (requested.includes("all")) {
    return [...KNOWN_FIXTURES].sort();
  }
  const unknown = requested.filter((fixture) => !KNOWN_FIXTURES.has(fixture));
  if (unknown.length > 0) {
    throw new Error(`Unknown fixture in --require: ${unknown.join(", ")}`);
  }
  return [...new Set(requested)].sort();
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    baseUrl: trimTrailingSlash(process.env.ARCANIST_API_URL || DEFAULT_QA_BASE_URL),
    requireFixtures: [],
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--base-url") {
      const value = argv[i + 1];
      if (!value) throw new Error("--base-url requires a value");
      options.baseUrl = trimTrailingSlash(value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--base-url=")) {
      options.baseUrl = trimTrailingSlash(arg.slice("--base-url=".length));
      continue;
    }
    if (arg === "--require") {
      const value = argv[i + 1];
      if (!value) throw new Error("--require requires a comma-separated fixture list");
      options.requireFixtures = parseRequiredFixtures(value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--require=")) {
      const value = arg.slice("--require=".length);
      if (!value) throw new Error("--require= requires a comma-separated fixture list");
      options.requireFixtures = parseRequiredFixtures(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function evaluateHealth(health: QaIntegrationHealthResponse, requireFixtures: string[]): HealthEvaluation {
  const byId = new Map(health.fixtures.map((fixture) => [fixture.integrationId, fixture]));
  const failures: string[] = [];
  for (const fixtureId of requireFixtures) {
    const fixture = byId.get(fixtureId);
    if (!fixture) {
      failures.push(`${fixtureId}: fixture is absent from health response`);
      continue;
    }
    if (fixture.status !== "configured") {
      failures.push(`${fixtureId}: expected configured, got ${fixture.status} (${fixture.reason})`);
    }
  }
  return { ok: failures.length === 0, failures };
}

export function formatSummary(health: QaIntegrationHealthResponse, evaluation: HealthEvaluation): string {
  const lines = [
    `QA integration health: workerEnv=${health.workerEnv ?? "unknown"} businessId=${health.businessId}`,
    "",
  ];
  for (const fixture of health.fixtures) {
    lines.push(
      `- ${fixture.integrationId}: ${fixture.status}; env missing=${fixture.env.missing.join(", ") || "-"}; credentialRow=${fixture.credentialRow}; scope=${fixture.scope}`,
    );
  }
  if (evaluation.failures.length > 0) {
    lines.push("", "Failures:");
    lines.push(...evaluation.failures.map((failure) => `- ${failure}`));
  }
  return lines.join("\n");
}

export function formatRequiredFailureText(evaluation: HealthEvaluation): string | null {
  if (evaluation.failures.length === 0) return null;
  return ["QA integration health required fixture failures:", ...evaluation.failures].join("\n- ");
}

async function fetchHealth(baseUrl: string, adminToken: string): Promise<QaIntegrationHealthResponse> {
  const response = await fetch(`${baseUrl}/api/internal/qa/integration-health`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(`QA integration health failed (${response.status}): ${JSON.stringify(body)}`);
  }
  if (!body || typeof body !== "object" || !("fixtures" in body) || !Array.isArray(body.fixtures)) {
    throw new Error("QA integration health returned an unexpected response shape");
  }
  return body as QaIntegrationHealthResponse;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const adminToken = process.env.ARCANIST_ADMIN_TOKEN;
  if (!adminToken) {
    throw new Error("ARCANIST_ADMIN_TOKEN is required");
  }

  const health = await fetchHealth(options.baseUrl, adminToken);
  const evaluation = evaluateHealth(health, options.requireFixtures);
  if (options.json) {
    console.log(JSON.stringify(health, null, 2));
    const failureText = formatRequiredFailureText(evaluation);
    if (failureText) console.error(failureText);
  } else {
    console.log(formatSummary(health, evaluation));
  }
  if (!evaluation.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("qa-integration-health.ts")) {
  main().catch((error) => {
    console.error(stringifyError(error));
    process.exit(1);
  });
}
