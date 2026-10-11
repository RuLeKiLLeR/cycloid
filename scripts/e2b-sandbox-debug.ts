#!/usr/bin/env tsx

import { Sandbox, type SandboxInfo, type SandboxState } from "e2b";

import { stringifyError } from "../shared/utils/errors.js";

type ListOptions = {
  states?: SandboxState[];
  metadata?: Record<string, string>;
  limit?: number;
};

type E2BConnectionConfig = {
  apiKey: string;
  domain?: string;
};

function usage(exitCode = 2): never {
  console.error(`Usage:
  E2B_API_KEY=<key> npm run debug:e2b:sandbox -- list [--state running,paused] [--metadata key=value,key2=value2] [--limit 20] [--domain <domain>]
  E2B_API_KEY=<key> npm run debug:e2b:sandbox -- status <sandbox-id> [--domain <domain>]
  E2B_API_KEY=<key> npm run debug:e2b:sandbox -- exec <sandbox-id> [--domain <domain>] -- <command>
  E2B_API_KEY=<key> npm run debug:e2b:sandbox -- pause <sandbox-id> [--domain <domain>]
  E2B_API_KEY=<key> npm run debug:e2b:sandbox -- kill <sandbox-id> [--domain <domain>]

Connection options:
  --api-key-env <name>   Environment variable containing the API key. Defaults to E2B_API_KEY.
  --domain <domain>      Optional E2B API domain. Defaults to E2B_DOMAIN.
`);
  process.exit(exitCode);
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseConnectionOptions(argv: string[]): { config: E2BConnectionConfig; argv: string[] } {
  let apiKey = clean(process.env.E2B_API_KEY) ?? "";
  let domain = clean(process.env.E2B_DOMAIN);
  const remaining: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--") {
      remaining.push(...argv.slice(index));
      break;
    }
    if (arg === "--api-key-env" && next) {
      apiKey = clean(process.env[next]) ?? "";
      index += 1;
      continue;
    }
    if (arg === "--domain" && next) {
      domain = next;
      index += 1;
      continue;
    }
    remaining.push(arg);
  }

  if (!apiKey) {
    throw new Error("E2B_API_KEY is required");
  }
  return {
    config: {
      apiKey,
      ...(domain ? { domain } : {}),
    },
    argv: remaining,
  };
}

function parseMetadata(raw: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const part of raw.split(",")) {
    if (!part) continue;
    const separator = part.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid metadata filter: ${part}`);
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key || !value) throw new Error(`Invalid metadata filter: ${part}`);
    metadata[key] = value;
  }
  return metadata;
}

function parseStates(raw: string): SandboxState[] {
  const states = raw.split(",").map((state) => state.trim());
  for (const state of states) {
    if (state !== "running" && state !== "paused") {
      throw new Error(`Invalid sandbox state: ${state}`);
    }
  }
  return states as SandboxState[];
}

function parseListOptions(argv: string[]): ListOptions {
  const options: ListOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--state" && next) {
      options.states = parseStates(next);
      index += 1;
      continue;
    }
    if (arg === "--metadata" && next) {
      const metadata = parseMetadata(next);
      options.metadata = { ...(options.metadata ?? {}), ...metadata };
      index += 1;
      continue;
    }
    if (arg === "--limit" && next) {
      const limit = Number.parseInt(next, 10);
      if (!Number.isFinite(limit) || limit <= 0) throw new Error("--limit must be a positive integer");
      options.limit = limit;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete list argument: ${arg}`);
  }
  return options;
}

function printInfo(info: SandboxInfo): void {
  console.log(
    JSON.stringify(
      {
        sandboxId: info.sandboxId,
        state: info.state,
        templateId: info.templateId,
        name: info.name ?? null,
        metadata: info.metadata,
        startedAt: info.startedAt,
        endAt: info.endAt,
        cpuCount: info.cpuCount,
        memoryMB: info.memoryMB,
        lifecycle: info.lifecycle ?? null,
      },
      null,
      2,
    ),
  );
}

async function listSandboxes(config: E2BConnectionConfig, argv: string[]): Promise<void> {
  const options = parseListOptions(argv);
  const paginator = Sandbox.list({
    ...config,
    ...(options.limit ? { limit: options.limit } : {}),
    query: {
      state: options.states ?? ["running", "paused"],
      ...(options.metadata ? { metadata: options.metadata } : {}),
    },
  });

  const items: SandboxInfo[] = [];
  while (paginator.hasNext && (!options.limit || items.length < options.limit)) {
    const page = await paginator.nextItems();
    items.push(...page);
  }
  console.log(
    JSON.stringify(
      items.slice(0, options.limit).map((info) => ({
        sandboxId: info.sandboxId,
        state: info.state,
        templateId: info.templateId,
        name: info.name ?? null,
        metadata: info.metadata,
        startedAt: info.startedAt,
        endAt: info.endAt,
      })),
      null,
      2,
    ),
  );
}

async function run(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const rawCommand = rawArgv[0];
  if (!rawCommand) usage();
  if (rawCommand === "--help" || rawCommand === "-h") usage(0);

  const parsed = parseConnectionOptions(rawArgv);
  const [command, sandboxId, ...rest] = parsed.argv;
  if (!command) usage();

  if (command === "list") {
    await listSandboxes(parsed.config, [sandboxId, ...rest].filter(Boolean));
    return;
  }

  if (!sandboxId) usage();

  if (command === "status") {
    printInfo(await Sandbox.getInfo(sandboxId, parsed.config));
    return;
  }

  if (command === "exec") {
    const separatorIndex = rest.indexOf("--");
    const commandParts = separatorIndex >= 0 ? rest.slice(separatorIndex + 1) : rest;
    if (commandParts.length === 0) {
      throw new Error("exec requires a command after --");
    }
    const sandbox = await Sandbox.connect(sandboxId, parsed.config);
    const result = await sandbox.commands.run(commandParts.join(" "));
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
    return;
  }

  if (command === "pause") {
    const paused = await Sandbox.pause(sandboxId, parsed.config);
    console.log(JSON.stringify({ sandboxId, paused }, null, 2));
    return;
  }

  if (command === "kill") {
    const killed = await Sandbox.kill(sandboxId, parsed.config);
    console.log(JSON.stringify({ sandboxId, killed }, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

run().catch((error) => {
  console.error(stringifyError(error));
  process.exit(1);
});
