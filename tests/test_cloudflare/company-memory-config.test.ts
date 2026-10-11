import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";
import {
  isCompanyMemoryDisabledForBusiness,
  isMemoryEnabledForBusiness,
} from "../../apps/control-plane-worker/src/constants/company-memory";

const WRANGLER_TOML = readFileSync("apps/control-plane-worker/wrangler.toml", "utf8");

function extractVarsBlock(env: "production" | "qa"): string {
  const header = env === "production" ? "[vars]" : "[env.qa.vars]";
  const start = WRANGLER_TOML.indexOf(header);
  expect(start, `${header} should exist`).toBeGreaterThanOrEqual(0);
  const nextHeader = WRANGLER_TOML.indexOf("\n[", start + header.length);
  return WRANGLER_TOML.slice(start, nextHeader === -1 ? undefined : nextHeader);
}

describe("company memory worker configuration", () => {
  it("sets the per-business memory refine budget cap in production and QA", () => {
    for (const env of ["production", "qa"] as const) {
      expect(extractVarsBlock(env)).toContain('MEMORY_REFINE_MONTHLY_USD_CAP_PER_BUSINESS = "50000000"');
    }
  });

  it("enables memory for production businesses", () => {
    const productionEnv = { WORKER_ENV: "production" };
    const qaEnv = { WORKER_ENV: "qa" };
    const localDogfoodEnv = { WORKER_ENV: "local", MEMORY_CONTEXT_LOCAL_DOGFOOD_ENABLED: "1" };

    expect(isMemoryEnabledForBusiness(productionEnv, SEEDED_BUSINESS_IDS.cycloid)).toBe(true);
    expect(isCompanyMemoryDisabledForBusiness(productionEnv, SEEDED_BUSINESS_IDS.cycloid)).toBe(false);
    expect(isMemoryEnabledForBusiness(productionEnv, SEEDED_BUSINESS_IDS.cycloidQa)).toBe(true);
    expect(isMemoryEnabledForBusiness(productionEnv, "customer-business")).toBe(true);
    expect(isMemoryEnabledForBusiness(productionEnv, null)).toBe(false);
    expect(isMemoryEnabledForBusiness(qaEnv, SEEDED_BUSINESS_IDS.cycloid)).toBe(false);
    expect(isMemoryEnabledForBusiness(localDogfoodEnv, SEEDED_BUSINESS_IDS.cycloid)).toBe(true);
    expect(isMemoryEnabledForBusiness(localDogfoodEnv, SEEDED_BUSINESS_IDS.cycloidQa)).toBe(false);
    expect(isMemoryEnabledForBusiness({ WORKER_ENV: "local" }, SEEDED_BUSINESS_IDS.cycloid)).toBe(false);
    expect(isMemoryEnabledForBusiness({}, SEEDED_BUSINESS_IDS.cycloid)).toBe(false);
  });
});
