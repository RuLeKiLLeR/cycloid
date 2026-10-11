/**
 * Memoize-on-success helper for side effects performed inside a session
 * Durable Object. Caches `fn`'s result in DO storage under `step:{name}` so
 * that a replay (DO restart between `fn` resolving and the caller's next
 * await) does not re-invoke `fn`.
 *
 * Crash window: if the DO crashes between `fn()` succeeding and `storage.put`
 * landing, `fn` will run again on replay. The helper narrows that window; the
 * caller is responsible for pairing it with a recovery mechanism (provider
 * idempotency key, deterministic recovery query, reaper, or D1 lease).
 *
 * In-flight dedup: concurrent callers in the same DO instance for the same
 * `stepName` share a single `fn()` invocation via an in-memory promise map.
 * This closes the live race where a second caller observes the same cache
 * miss before the first caller's `storage.put` lands; it does NOT change the
 * cross-replay crash window above.
 *
 * DO storage values are capped at 128 KiB; this helper warns at 32 KiB of
 * UTF-8 bytes (not UTF-16 string length).
 */
import type { Logger } from "../logger";

const STEP_KEY_PREFIX = "step:";
const OVERSIZE_WARN_BYTES = 32 * 1024;
const LIST_PAGE_SIZE = 128;
const DELETE_BATCH_SIZE = 128;

const textEncoder = new TextEncoder();
const inFlightSteps = new WeakMap<DurableObjectStorage, Map<string, Promise<unknown>>>();

type StepRecord<T> = { ok: true; result: T };

function stepKey(name: string): string {
  return `${STEP_KEY_PREFIX}${name}`;
}

function jsonByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : textEncoder.encode(serialized).length;
}

export async function durableStep<T>(
  storage: DurableObjectStorage,
  stepName: string,
  fn: () => Promise<T>,
  logger?: Logger,
): Promise<T> {
  const key = stepKey(stepName);

  let perStorage = inFlightSteps.get(storage);
  if (!perStorage) {
    perStorage = new Map();
    inFlightSteps.set(storage, perStorage);
  }
  const inFlight = perStorage.get(key) as Promise<T> | undefined;
  if (inFlight) return inFlight;

  const run = (async (): Promise<T> => {
    const cached = await storage.get<StepRecord<T>>(key);
    if (cached !== undefined) {
      logger?.info({ stepName, durableStepReplayed: true }, "durable_step_replayed");
      return cached.result;
    }
    const result = await fn();
    try {
      const resultSize = jsonByteLength(result);
      if (resultSize > OVERSIZE_WARN_BYTES) {
        logger?.warn({ stepName, resultSize }, "durable_step_oversize_result");
      }
    } catch {
      // Result isn't JSON-serializable for size checking; DO storage will reject
      // on put if it can't structured-clone. Let that surface naturally.
    }
    await storage.put(key, { ok: true, result } satisfies StepRecord<T>);
    return result;
  })();

  perStorage.set(key, run);
  try {
    return await run;
  } finally {
    if (perStorage.get(key) === run) perStorage.delete(key);
    if (perStorage.size === 0) inFlightSteps.delete(storage);
  }
}

/**
 * Report whether a step's result is already memoized, without re-running or
 * mutating it. Keeps the internal `step:` key layout encapsulated so callers
 * can branch on "did this side effect already happen" (e.g. recovery probes)
 * without reaching into the key format.
 */
export async function hasDurableStep(storage: DurableObjectStorage, stepName: string): Promise<boolean> {
  return (await storage.get(stepKey(stepName))) !== undefined;
}

/**
 * Delete a single step's memoized result, leaving every other step intact.
 * Used to drop one phase marker (e.g. a bridge-start record on a failed
 * recovery probe) without prefix-wiping sibling phases under the same attempt.
 */
export async function clearDurableStep(storage: DurableObjectStorage, stepName: string): Promise<void> {
  await storage.delete(stepKey(stepName));
}

/**
 * Delete every step whose name starts with `prefix`. Keeps the internal
 * `step:` key layout encapsulated so callers don't reach into the storage
 * key format directly.
 */
export async function clearDurableStepsByPrefix(storage: DurableObjectStorage, prefix: string): Promise<number> {
  const listPrefix = `${STEP_KEY_PREFIX}${prefix}`;
  let removed = 0;
  let startAfter: string | undefined;

  while (true) {
    const entries = await storage.list({
      prefix: listPrefix,
      limit: LIST_PAGE_SIZE,
      ...(startAfter ? { startAfter } : {}),
    });
    if (entries.size === 0) break;

    const keys = [...entries.keys()];
    for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
      await storage.delete(keys.slice(i, i + DELETE_BATCH_SIZE));
    }
    removed += keys.length;

    if (entries.size < LIST_PAGE_SIZE) break;
    startAfter = keys.at(-1);
  }

  return removed;
}
