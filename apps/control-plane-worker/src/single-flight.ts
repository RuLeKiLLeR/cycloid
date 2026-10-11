/**
 * In-isolate single-flight: collapse concurrent calls for the same key onto one
 * in-flight promise. The first caller runs `fn`; callers that arrive while it is
 * still pending share the same promise. The entry self-deletes on settle, so the
 * map self-bounds without TTL/LRU bookkeeping and the next call after settle runs
 * `fn` again normally (no staleness — there is no retained value, only an
 * in-flight promise).
 *
 * Mirrors the in-flight-dedup half of `durable-step.ts` and
 * `inFlightPromptPublishes`, but generic and storage-agnostic. Dedup is
 * per-isolate only: callers on different isolates do not share a flight.
 */
export function createSingleFlight<K, V>(): (key: K, fn: () => Promise<V>) => Promise<V> {
  const inFlight = new Map<K, Promise<V>>();
  return (key, fn) => {
    const existing = inFlight.get(key);
    if (existing) return existing;
    // Invoke through an async wrapper so a *synchronous* throw in `fn` becomes a
    // rejected promise that still runs the cleanup below, instead of escaping
    // before the entry is registered and leaving a never-cleared key.
    const run = (async () => fn())();
    inFlight.set(key, run);
    // Clear on settle (success OR failure) so a failed run never poisons the
    // next caller. The identity check avoids deleting a newer entry if one was
    // somehow registered under the same key.
    return run.finally(() => {
      if (inFlight.get(key) === run) inFlight.delete(key);
    });
  };
}
