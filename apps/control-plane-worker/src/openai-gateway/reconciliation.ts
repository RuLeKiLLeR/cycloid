import * as Sentry from "@sentry/cloudflare";

import { withProviderRetry } from "../../../../shared/llm/retry.mjs";
import type { Logger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import type { Env } from "../types";
import { sumManagedVirtualKeySettledGatewayCostMicros, sumSettledGatewayCostMicrosByCredentialSource } from "./db";

const OPENAI_COSTS_URL = "https://api.openai.com/v1/organization/costs";
const OPENAI_COSTS_RETRY_MAX_ATTEMPTS = 3;
const DRIFT_ALERT_THRESHOLD_MICROS = 1_000_000;
const OPENAI_GATEWAY_NOT_RECONCILED_CREDENTIAL_SOURCES = ["user_byok", "business_byok"] as const;

type OpenAICostsResponse = {
  data?: Array<{
    results?: Array<{
      amount?: {
        value?: number;
      };
      api_key_id?: string | null;
    }>;
  }>;
};

type OpenAIGatewayReconciliationReport = {
  periodStartMs: number;
  periodEndMs: number;
  openaiCostUsdMicros: number;
  cycloidSettledUsdMicros: number;
  settledUsdMicrosByCredentialSource: {
    managed_virtual_key: number;
    user_byok: number;
    business_byok: number;
  };
  notReconciledCredentialSources: Array<"user_byok" | "business_byok">;
  driftUsdMicros: number;
  alerted: boolean;
};

class OpenAIGatewayReconciliationFetchError extends Error {
  readonly status: number;
  readonly headers: Headers;

  constructor(response: Response) {
    super(`OpenAI costs reconciliation failed: ${response.status}`);
    this.name = "OpenAIGatewayReconciliationFetchError";
    this.status = response.status;
    this.headers = response.headers;
  }
}

export async function runOpenAIGatewayReconciliation(
  env: Env,
  opts: { now?: number; logger: Logger },
): Promise<OpenAIGatewayReconciliationReport | null> {
  if (!env.OPENAI_ADMIN_API_KEY) return null;
  if (!env.OPENAI_GATEWAY_API_KEY_ID) {
    opts.logger.warn(
      { action: "openai_gateway_reconciliation_skipped" },
      "Skipping OpenAI gateway reconciliation because OPENAI_GATEWAY_API_KEY_ID is not configured",
    );
    return null;
  }
  const now = opts.now ?? Date.now();
  const periodEndMs = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const periodStartMs = periodEndMs - 24 * 60 * 60 * 1000;
  const openaiCostUsdMicros = await fetchOpenAICostUsdMicros(
    env.OPENAI_ADMIN_API_KEY,
    env.OPENAI_GATEWAY_API_KEY_ID,
    periodStartMs,
    periodEndMs,
  );
  const [cycloidSettledUsdMicros, settledUsdMicrosByCredentialSource] = await Promise.all([
    sumManagedVirtualKeySettledGatewayCostMicros(env.DB, { periodStartMs, periodEndMs }),
    sumSettledGatewayCostMicrosByCredentialSource(env.DB, { periodStartMs, periodEndMs }),
  ]);
  const driftUsdMicros = openaiCostUsdMicros - cycloidSettledUsdMicros;
  const alerted = Math.abs(driftUsdMicros) > DRIFT_ALERT_THRESHOLD_MICROS;
  const report = {
    periodStartMs,
    periodEndMs,
    openaiCostUsdMicros,
    cycloidSettledUsdMicros,
    settledUsdMicrosByCredentialSource,
    notReconciledCredentialSources: [...OPENAI_GATEWAY_NOT_RECONCILED_CREDENTIAL_SOURCES],
    driftUsdMicros,
    alerted,
  };

  if (alerted) {
    opts.logger.error(report, "OpenAI gateway reconciliation drift");
    Sentry.captureMessage("OpenAI gateway reconciliation drift", {
      level: "error",
      tags: { component: "openai-gateway" },
      extra: report,
    });
  } else {
    opts.logger.info(report, "OpenAI gateway reconciliation matched");
  }

  return report;
}

async function fetchOpenAICostUsdMicros(
  adminApiKey: string,
  apiKeyId: string,
  periodStartMs: number,
  periodEndMs: number,
): Promise<number> {
  const url = new URL(OPENAI_COSTS_URL);
  url.searchParams.set("start_time", String(Math.floor(periodStartMs / 1000)));
  url.searchParams.set("end_time", String(Math.floor(periodEndMs / 1000)));
  url.searchParams.set("bucket_width", "1d");
  url.searchParams.set("group_by", "api_key_id");
  const { value: response } = await withProviderRetry({
    maxAttempts: OPENAI_COSTS_RETRY_MAX_ATTEMPTS,
    op: async () => {
      const result = await tracedFetch(
        url.href,
        {
          headers: { authorization: `Bearer ${adminApiKey}` },
        },
        "openai.gateway.costs.reconcile",
      );
      if (!result.ok) throw new OpenAIGatewayReconciliationFetchError(result);
      return result;
    },
  });
  const body = (await response.json()) as OpenAICostsResponse;
  let totalUsd = 0;
  for (const bucket of body.data ?? []) {
    for (const result of bucket.results ?? []) {
      if (result.api_key_id === apiKeyId && typeof result.amount?.value === "number") totalUsd += result.amount.value;
    }
  }
  return Math.round(totalUsd * 1_000_000);
}
