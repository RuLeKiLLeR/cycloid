import type { Logger } from "../logger";
import { baseControlPlaneMetricTags } from "../observability/metric-tags";
import { type CountMetricSeries, postCountMetricSeries } from "../observability/pr-metrics";
import type { Env } from "../types";

const MAX_TICK_LIMIT = 1000;
const MAX_CONCURRENCY = 20;

export interface CronSweepPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CronSweepJob<T> {
  name: string;
  tickLimit: number;
  fetchPage: (db: D1Database, cursor: string | null, limit: number) => Promise<CronSweepPage<T>>;
  processItem: (item: T) => Promise<void>;
  concurrency?: number;
  persistCursor?: boolean;
}

export interface CronSweepResult {
  fetched: number;
  processed: number;
  failed: number;
  cursor: string | null;
}

function clampPositiveInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(Math.floor(value), max));
}

async function readPersistedCursor(db: D1Database, jobName: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT cursor FROM cron_sweep_cursors WHERE job_name = ?")
    .bind(jobName)
    .first<{ cursor: string | null }>();
  return row?.cursor ?? null;
}

async function persistCursor(db: D1Database, jobName: string, cursor: string | null, nowMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cron_sweep_cursors (job_name, cursor, last_updated_at, last_processed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(job_name) DO UPDATE SET
         cursor = excluded.cursor,
         last_updated_at = excluded.last_updated_at,
         last_processed_at = excluded.last_processed_at`,
    )
    .bind(jobName, cursor, nowMs, nowMs)
    .run();
}

async function processWithConcurrency<T>(
  items: T[],
  concurrency: number,
  processItem: (item: T) => Promise<void>,
  onFailure: (item: T, error: unknown) => void,
): Promise<{ processed: number; failed: number }> {
  let nextIndex = 0;
  let processed = 0;
  let failed = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      try {
        await processItem(item);
        processed += 1;
      } catch (error) {
        failed += 1;
        onFailure(item, error);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return { processed, failed };
}

function buildMetricSeries(
  env: Pick<Env, "WORKER_ENV">,
  jobName: string,
  result: Pick<CronSweepResult, "fetched" | "processed" | "failed">,
): CountMetricSeries[] {
  const tags = [...baseControlPlaneMetricTags(env), `job:${jobName}`];
  return [
    { metric: "arcanist.cron_sweep.fetched", tags, value: result.fetched },
    { metric: "arcanist.cron_sweep.processed", tags, value: result.processed },
    { metric: "arcanist.cron_sweep.failed", tags, value: result.failed },
  ];
}

async function emitCronSweepMetrics(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  jobName: string,
  result: Pick<CronSweepResult, "fetched" | "processed" | "failed">,
): Promise<void> {
  if (!env.DD_API_KEY) return;
  await postCountMetricSeries(env.DD_API_KEY, buildMetricSeries(env, jobName, result), "cron-sweep");
}

export async function runCronSweep<T>(
  env: Pick<Env, "DB" | "DD_API_KEY" | "WORKER_ENV">,
  logger: Logger,
  job: CronSweepJob<T>,
): Promise<CronSweepResult> {
  const tickLimit = clampPositiveInteger(job.tickLimit, 1, MAX_TICK_LIMIT);
  const concurrency = clampPositiveInteger(job.concurrency ?? 1, 1, MAX_CONCURRENCY);
  const shouldPersistCursor = job.persistCursor !== false;
  let cursor = shouldPersistCursor ? await readPersistedCursor(env.DB, job.name) : null;
  const result: CronSweepResult = { fetched: 0, processed: 0, failed: 0, cursor };

  while (result.fetched < tickLimit) {
    const remaining = tickLimit - result.fetched;
    const pageStartCursor = cursor;
    const page = await job.fetchPage(env.DB, cursor, remaining);
    if (page.items.length === 0) {
      if (shouldPersistCursor && cursor !== null) {
        cursor = null;
        result.cursor = cursor;
        await persistCursor(env.DB, job.name, cursor, Date.now());
      }
      break;
    }

    result.fetched += page.items.length;

    const processed = await processWithConcurrency(page.items, concurrency, job.processItem, (item, error) => {
      logger.warn({ job: job.name, item, error: String(error) }, "Cron sweep item failed");
    });
    result.processed += processed.processed;
    result.failed += processed.failed;
    if (processed.failed > 0) {
      cursor = pageStartCursor;
      result.cursor = cursor;
      break;
    }

    cursor = page.nextCursor;
    result.cursor = cursor;
    if (shouldPersistCursor) {
      await persistCursor(env.DB, job.name, cursor, Date.now());
    }

    if (page.nextCursor === null) break;
  }

  await emitCronSweepMetrics(env, job.name, result);
  return result;
}
