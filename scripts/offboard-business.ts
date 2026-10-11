import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { stringifyError } from "../shared/utils/errors.js";

type CliOptions = {
  baseUrl: string;
  businessId: string;
  confirm: boolean;
  overrideProtectedBusiness: boolean;
};

const DEFAULT_BASE_URL = "https://app.trycycloid.com";
const ERROR_BODY_EXCERPT_LENGTH = 500;

function usage(): string {
  return [
    "Usage: ARCANIST_ADMIN_TOKEN=<token> tsx scripts/offboard-business.ts --business-id <id> [options]",
    "",
    "Options:",
    "  --base-url <url>                  Cycloid API/UI base URL. Defaults to ARCANIST_API_URL or https://app.trycycloid.com.",
    "  --business-id <id>                Business id to offboard.",
    "  --confirm                         Execute destructive offboarding after a dry-run and exact name prompt.",
    "  --override-protected-business      Required for protected internal Cycloid businesses.",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    baseUrl: trimTrailingSlash(process.env.ARCANIST_API_URL || DEFAULT_BASE_URL),
    businessId: "",
    confirm: false,
    overrideProtectedBusiness: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--base-url") {
      if (!next) throw new Error("--base-url requires a value");
      options.baseUrl = trimTrailingSlash(next);
      index++;
      continue;
    }
    if (arg.startsWith("--base-url=")) {
      options.baseUrl = trimTrailingSlash(arg.slice("--base-url=".length));
      continue;
    }
    if (arg === "--business-id") {
      if (!next) throw new Error("--business-id requires a value");
      options.businessId = next;
      index++;
      continue;
    }
    if (arg.startsWith("--business-id=")) {
      options.businessId = arg.slice("--business-id=".length);
      continue;
    }
    if (arg === "--confirm") {
      options.confirm = true;
      continue;
    }
    if (arg === "--override-protected-business") {
      options.overrideProtectedBusiness = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.businessId) throw new Error("--business-id is required");
  return options;
}

async function postOffboardingRequest(
  options: CliOptions,
  body: { confirm: boolean; businessNameConfirmation?: string },
): Promise<Record<string, unknown>> {
  const token = process.env.ARCANIST_ADMIN_TOKEN?.trim();
  if (!token) throw new Error("ARCANIST_ADMIN_TOKEN is required");
  const response = await fetch(
    `${options.baseUrl}/api/admin/businesses/${encodeURIComponent(options.businessId)}/offboard`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...body,
        overrideProtectedBusiness: options.overrideProtectedBusiness,
      }),
    },
  );
  const text = await response.text();
  const parsed = parseJsonObject(text);
  if (!response.ok) {
    throw new Error(`Offboarding request failed: ${response.status} ${formatResponseBodyForError(text, parsed)}`);
  }
  if (!parsed)
    throw new Error(`Offboarding request returned invalid JSON: ${formatResponseBodyForError(text, parsed)}`);
  return parsed;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const dryRun = await postOffboardingRequest(options, { confirm: false });
  console.log(JSON.stringify(dryRun, null, 2));
  if (!options.confirm) return;

  const business = dryRun.business as { name?: string } | undefined;
  const businessName = business?.name;
  if (!businessName) throw new Error("Dry-run response did not include business.name");

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`Type the exact business name to offboard (${businessName}): `);
    if (answer !== businessName) throw new Error("Business name confirmation did not match");
  } finally {
    rl.close();
  }

  const result = await postOffboardingRequest(options, { confirm: true, businessNameConfirmation: businessName });
  console.log(JSON.stringify(result, null, 2));
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch (error) {
    void error;
    return null;
  }
}

function formatResponseBodyForError(text: string, parsed: Record<string, unknown> | null): string {
  if (parsed) return JSON.stringify(parsed);
  const excerpt = text.slice(0, ERROR_BODY_EXCERPT_LENGTH);
  return excerpt ? `raw=${JSON.stringify(excerpt)}` : "empty body";
}

if (process.argv[1]?.endsWith("offboard-business.ts")) {
  main().catch((error) => {
    console.error(stringifyError(error));
    process.exit(1);
  });
}
