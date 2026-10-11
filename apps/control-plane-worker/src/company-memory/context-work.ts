import { MEMORY_CONTEXT_VECTOR_SYNC_RETRY_DELAY_MS } from "../constants/memory-context";
import type { Env } from "../types";
import { consolidateMemoryScopeCardForScope } from "./context-consolidation";
import {
  claimNextMemoryWorkItem,
  completeMemoryWorkItem,
  deferMemoryWorkItem,
  failMemoryWorkItem,
  type MemoryWorkItemRow,
} from "./context-db";
import { deriveExplicitConclusionFromMemoryMessage } from "./context-derive";
import { createMemoryContextMetricSink, type MemoryContextMetricOptions } from "./context-metrics";
import { type MemoryVectorSyncDeps, syncPendingMemorySemanticDocuments } from "./context-vector-sync";

export interface ProcessMemoryWorkOptions {
  batchSize?: number;
  lockMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  now?: () => number;
  vectorSyncDeps?: MemoryVectorSyncDeps;
  metrics?: MemoryContextMetricOptions | null;
}

export interface ProcessMemoryWorkResult {
  claimed: number;
  completed: number;
  failed: number;
  retried: number;
  outcomes: Array<{ id: string; workType: string; status: "completed" | "failed" | "retried"; detail: string }>;
}

export async function processPendingMemoryWorkItems(
  env: Env,
  db: D1Database,
  options: ProcessMemoryWorkOptions = {},
): Promise<ProcessMemoryWorkResult> {
  const now = options.now ?? Date.now;
  const batchSize = clampInteger(options.batchSize, 1, 25, 5);
  const lockMs = clampInteger(options.lockMs, 1_000, 5 * 60_000, 60_000);
  const maxAttempts = clampInteger(options.maxAttempts, 1, 20, 5);
  const retryDelayMs = clampInteger(options.retryDelayMs, 1_000, 60 * 60_000, 60_000);
  const result: ProcessMemoryWorkResult = { claimed: 0, completed: 0, failed: 0, retried: 0, outcomes: [] };

  for (let index = 0; index < batchSize; index += 1) {
    const item = await claimNextMemoryWorkItem(db, { nowMs: now(), lockMs, maxAttempts });
    if (!item) break;
    result.claimed += 1;
    try {
      const processed = await processMemoryWorkItem(env, db, item, {
        nowMs: now(),
        vectorSyncDeps: options.vectorSyncDeps,
      });
      if (processed.defer) {
        // Deferrals (e.g. a scope that is not yet idle) are not terminal work:
        // reschedule without burning an attempt so the card is written once the
        // scope settles, instead of the item completing and never re-running.
        await deferMemoryWorkItem(db, {
          id: item.id,
          reason: processed.defer.reason,
          availableAtMs: now() + processed.defer.delayMs,
          nowMs: now(),
        });
        result.retried += 1;
        result.outcomes.push({ id: item.id, workType: item.workType, status: "retried", detail: processed.detail });
        continue;
      }
      await completeMemoryWorkItem(db, { id: item.id, nowMs: now() });
      result.completed += 1;
      result.outcomes.push({ id: item.id, workType: item.workType, status: "completed", detail: processed.detail });
    } catch (error) {
      const message = error instanceof Error ? error.message : "memory_work_failed";
      const retry = item.attempts < maxAttempts;
      await failMemoryWorkItem(db, {
        id: item.id,
        error: message,
        retry,
        availableAtMs: now() + (retry ? retryDelayMs : 0),
        nowMs: now(),
      });
      if (retry) {
        result.retried += 1;
        result.outcomes.push({ id: item.id, workType: item.workType, status: "retried", detail: message });
      } else {
        result.failed += 1;
        result.outcomes.push({ id: item.id, workType: item.workType, status: "failed", detail: message });
      }
    }
  }

  if (result.claimed > 0 && options.metrics !== null) {
    createMemoryContextMetricSink(env, options.metrics).emit({
      event: "memory_context.work_processed",
      claimed: result.claimed,
      completed: result.completed,
      failed: result.failed,
      retried: result.retried,
    });
  }

  return result;
}

interface ProcessedMemoryWorkItem {
  detail: string;
  defer?: { reason: string; delayMs: number };
}

async function processMemoryWorkItem(
  env: Env,
  db: D1Database,
  item: MemoryWorkItemRow,
  options: { nowMs: number; vectorSyncDeps?: MemoryVectorSyncDeps },
): Promise<ProcessedMemoryWorkItem> {
  const payload = parsePayload(item.payloadJson);
  if (item.workType === "derive") {
    if (item.targetKind !== "memory_message") throw new Error(`unsupported_derive_target:${item.targetKind}`);
    const derived = await deriveExplicitConclusionFromMemoryMessage(db, {
      businessId: item.businessId,
      messageId: item.targetId,
      nowMs: options.nowMs,
    });
    return { detail: `derive:${derived.status}:${derived.reason}:${derived.conclusionId ?? ""}` };
  }
  if (item.workType === "consolidate") {
    if (item.targetKind !== "memory_scope") throw new Error(`unsupported_consolidate_target:${item.targetKind}`);
    const observerPeerId = requiredString(payload.observerPeerId, "observerPeerId");
    const observedPeerId = requiredString(payload.observedPeerId, "observedPeerId");
    const idleMs = optionalNumber(payload.idleMs, 5 * 60_000);
    const consolidated = await consolidateMemoryScopeCardForScope(db, {
      businessId: item.businessId,
      scopeId: item.targetId,
      observerPeerId,
      observedPeerId,
      idleMs,
      limit: optionalNumber(payload.limit, 50),
      nowMs: options.nowMs,
    });
    const detail = `consolidate:${consolidated.status}:${consolidated.reason}:${consolidated.entryCount}`;
    // An active scope is not a finished job: defer so the card is (re)written once
    // the scope goes idle, instead of marking the work completed forever.
    if (consolidated.status === "skipped" && consolidated.reason === "not_idle") {
      return { detail, defer: { reason: "consolidate:not_idle", delayMs: idleMs } };
    }
    return { detail };
  }
  if (item.workType === "vector_sync") {
    const synced = await syncPendingMemorySemanticDocuments(env, db, {
      ...options.vectorSyncDeps,
      now: () => options.nowMs,
    });
    const detail = `vector_sync:scanned=${synced.scanned}:synced=${synced.synced}:failed=${synced.failed}:skipped=${synced.skipped}`;
    // Failed documents keep retry budget (sync_attempts < max), so completing the
    // work item here would strand them until an unrelated sync is enqueued. Defer
    // instead; documents that exhaust their attempts drop out of the pending list,
    // so a permanently failing document cannot defer forever.
    if (synced.failed > 0) {
      return {
        detail,
        defer: { reason: "vector_sync:retry_failed", delayMs: MEMORY_CONTEXT_VECTOR_SYNC_RETRY_DELAY_MS },
      };
    }
    return { detail };
  }
  throw new Error(`unsupported_memory_work_type:${item.workType}`);
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`missing_payload_field:${field}`);
}

function optionalNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback;
}
