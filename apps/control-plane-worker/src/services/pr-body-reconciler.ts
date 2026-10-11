import { createInstallationToken } from "../github/octokit";
import { getPullRequestBodyAndState, updatePullRequest } from "../github/pr";
import type { Logger } from "../logger";
import { upsertVisualEvidenceSection } from "../session/pr-body";
import type { Env } from "../types";
import {
  getPrBodyDocument,
  listPrBodyRegions,
  type PrBodyIdentity,
  type PrBodyRegionName,
  type PrBodyRegionRow,
  releasePrBodyLease,
  tryAcquirePrBodyLease,
  upsertPrBodyDocument,
  upsertPrBodyRegion,
} from "./pr-body-regions-db";

export type { PrBodyIdentity, PrBodyRegionName } from "./pr-body-regions-db";

export class PrBodyStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrBodyStorageUnavailableError";
  }
}

export function composeManagedPrBody(baseBody: string, regions: PrBodyRegionRow[]): string {
  return regions.reduce((body, region) => {
    if (region.region === "visualEvidence") return upsertVisualEvidenceSection(body, region.body);
    return body;
  }, baseBody);
}

export async function storePrBodyBaseAndReconcile(
  env: Env,
  input: {
    identity: PrBodyIdentity;
    baseBody: string;
    tokenHint?: string;
    logger: Logger;
    nowMs?: number;
    rememberBody?: (body: string) => Promise<void>;
    patchWithoutStorage?: boolean;
  },
): Promise<string | null> {
  const nowMs = input.nowMs ?? Date.now();
  try {
    await upsertPrBodyDocument(env.DB, input.identity, input.baseBody, nowMs);
  } catch (error) {
    input.logger.warn(
      {
        action: "pr_body_base_store_failed",
        prUrl: input.identity.prUrl,
        prNumber: input.identity.prNumber,
        error: String(error),
      },
      "PR body base store failed",
    );
    if (input.rememberBody) await input.rememberBody(input.baseBody);
    if (!input.patchWithoutStorage) return input.baseBody;
    throw new PrBodyStorageUnavailableError("PR body base store unavailable");
  }
  return reconcileManagedPrBody(env, input);
}

export async function storePrBodyRegionAndReconcile(
  env: Env,
  input: {
    identity: PrBodyIdentity;
    region: PrBodyRegionName;
    body: string;
    tokenHint?: string;
    logger: Logger;
    nowMs?: number;
    rememberBody?: (body: string) => Promise<void>;
  },
): Promise<string | null> {
  const nowMs = input.nowMs ?? Date.now();
  try {
    await upsertPrBodyRegion(env.DB, input.identity, input.region, input.body, nowMs);
  } catch (error) {
    input.logger.warn(
      {
        action: "pr_body_region_store_failed",
        prUrl: input.identity.prUrl,
        prNumber: input.identity.prNumber,
        region: input.region,
        error: String(error),
      },
      "PR body region store failed",
    );
    return patchDirectPrBodyRegion(env, input);
  }
  return reconcileManagedPrBody(env, input);
}

export async function reconcileManagedPrBody(
  env: Env,
  input: {
    identity: PrBodyIdentity;
    tokenHint?: string;
    logger: Logger;
    nowMs?: number;
    rememberBody?: (body: string) => Promise<void>;
  },
): Promise<string | null> {
  const nowMs = input.nowMs ?? Date.now();
  const leaseOwner = crypto.randomUUID();
  const acquired = await tryAcquirePrBodyLease(env.DB, input.identity, leaseOwner, nowMs);
  if (!acquired) {
    input.logger.info(
      {
        action: "pr_body_reconcile_deferred",
        prUrl: input.identity.prUrl,
        prNumber: input.identity.prNumber,
      },
      "PR body reconcile deferred: lease held",
    );
    return null;
  }

  try {
    const document = await getPrBodyDocument(env.DB, input.identity);
    const token = input.tokenHint ?? (await createInstallationToken(env, input.identity.installationId));
    const { body: currentBody, state } = await getPullRequestBodyAndState(
      token,
      input.identity.repoOwner,
      input.identity.repoName,
      input.identity.prNumber,
    );
    if (state !== "open") return null;
    const regions = await listPrBodyRegions(env.DB, input.identity);
    const nextBody = composeManagedPrBody(document?.baseBody ?? currentBody, regions);
    if (currentBody === nextBody) return nextBody;

    await updatePullRequest(token, input.identity.repoOwner, input.identity.repoName, input.identity.prNumber, {
      body: nextBody,
    });
    if (input.rememberBody) await input.rememberBody(nextBody);
    return nextBody;
  } finally {
    await releasePrBodyLease(env.DB, input.identity, leaseOwner, nowMs);
  }
}

async function patchDirectPrBodyRegion(
  env: Env,
  input: {
    identity: PrBodyIdentity;
    region: PrBodyRegionName;
    body: string;
    tokenHint?: string;
    logger: Logger;
    rememberBody?: (body: string) => Promise<void>;
  },
): Promise<string | null> {
  const token = input.tokenHint ?? (await createInstallationToken(env, input.identity.installationId));
  const { body: currentBody, state } = await getPullRequestBodyAndState(
    token,
    input.identity.repoOwner,
    input.identity.repoName,
    input.identity.prNumber,
  );
  if (state !== "open") return null;
  const body = composeManagedPrBody(currentBody, [{ region: input.region, body: input.body, updatedAt: Date.now() }]);
  if (body !== currentBody) {
    await updatePullRequest(token, input.identity.repoOwner, input.identity.repoName, input.identity.prNumber, {
      body,
    });
  }
  if (input.rememberBody) await input.rememberBody(body);
  return body;
}
