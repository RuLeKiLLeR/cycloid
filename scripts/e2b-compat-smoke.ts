import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runE2BCompatSmoke } from "../apps/control-plane-worker/src/sandbox/e2b-compat";

type CleanupMode = "pause" | "kill";

type CliArgs = {
  apiKey: string;
  template: string;
  domain?: string;
  timeoutMs: number;
  cleanup: CleanupMode;
};

const DEFAULT_TIMEOUT_MS = 300_000;

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

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function usage(exitCode: number): never {
  console.error(`Usage:
  npm run smoke:e2b:compat -- [options]

Options:
  --api-key-env <name>   Environment variable containing the E2B API key. Defaults to E2B_API_KEY.
  --template <id>        Sandbox template. Defaults to E2B_SANDBOX_TEMPLATE.
  --domain <domain>      Optional E2B API domain. Defaults to E2B_DOMAIN.
  --timeout-ms <ms>      Sandbox timeout. Defaults to E2B_SANDBOX_TIMEOUT_MS or ${DEFAULT_TIMEOUT_MS}.
  --cleanup <mode>       pause or kill. Defaults to kill.
`);
  process.exit(exitCode);
}

function parseTimeoutMs(value: string | undefined, label: string): number {
  if (!value) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

function parseCleanup(value: string | undefined, label: string, defaultValue: CleanupMode): CleanupMode {
  const cleaned = clean(value);
  if (!cleaned) return defaultValue;
  if (cleaned === "pause" || cleaned === "kill") return cleaned;
  throw new Error(`${label} must be pause or kill`);
}

function parseArgs(argv: string[]): CliArgs {
  let apiKey = clean(process.env.E2B_API_KEY) ?? "";
  let template = clean(process.env.E2B_SANDBOX_TEMPLATE) ?? "";
  let domain = clean(process.env.E2B_DOMAIN);
  let timeoutMs = parseTimeoutMs(process.env.E2B_SANDBOX_TIMEOUT_MS, "E2B_SANDBOX_TIMEOUT_MS");
  let cleanup = parseCleanup(process.env.E2B_SMOKE_CLEANUP, "E2B_SMOKE_CLEANUP", "kill");

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--api-key-env" && next) {
      apiKey = clean(process.env[next]) ?? "";
      index += 1;
      continue;
    }
    if (arg === "--template" && next) {
      template = next;
      index += 1;
      continue;
    }
    if (arg === "--domain" && next) {
      domain = next;
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms" && next) {
      timeoutMs = parseTimeoutMs(next, "--timeout-ms");
      index += 1;
      continue;
    }
    if (arg === "--cleanup" && next) {
      cleanup = parseCleanup(next, "--cleanup", cleanup);
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  return { apiKey, template, domain, timeoutMs, cleanup };
}

loadWorkerDevVars();

const args = parseArgs(process.argv);

const result = await runE2BCompatSmoke({
  apiKey: args.apiKey,
  template: args.template,
  domain: args.domain,
  timeoutMs: args.timeoutMs,
  cleanup: args.cleanup,
});

// Smoke scripts should print a value that can be copied into PR evidence.
// eslint-disable-next-line no-console
console.log(
  JSON.stringify(
    {
      sandboxId: result.sandboxId,
      commandStdout: result.commandStdout.trim(),
      commandExitCode: result.commandExitCode,
      finalState: result.finalState,
      template: args.template,
      domain: args.domain ?? null,
    },
    null,
    2,
  ),
);
