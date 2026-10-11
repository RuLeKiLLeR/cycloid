import type { Env } from "../types";
import { type MemoryReconciliationRepoTarget, runMemoryReconciliation } from "./reconcile";
import {
  getMemoryReviewCandidate,
  listMemoryReviewCandidates,
  type MemoryReviewStatus,
  resolveMemoryReviewCandidate,
} from "./review-db";

export type MemoryReviewSourceFilter = "d1" | "repo" | "cross_store";

export async function listMemoryReviewForBusiness(
  db: D1Database,
  input: {
    businessId: string;
    status: MemoryReviewStatus | null;
    source: MemoryReviewSourceFilter | null;
    cursor?: string | null;
    limit: number;
  },
) {
  return listMemoryReviewCandidates(db, input);
}

export async function getMemoryReviewForBusiness(db: D1Database, businessId: string, id: string) {
  return getMemoryReviewCandidate(db, businessId, id);
}

export async function resolveMemoryReviewForBusiness(
  db: D1Database,
  input: { businessId: string; id: string; action: "approve" | "reject" | "dismiss"; resolvedByUserId: number | null },
) {
  return resolveMemoryReviewCandidate(db, input);
}

export async function runMemoryReviewReconciliation(
  env: Env,
  input: { businessId: string; repoTargets: MemoryReconciliationRepoTarget[] },
) {
  return runMemoryReconciliation(env, input);
}
