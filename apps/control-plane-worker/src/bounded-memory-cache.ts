type CacheEntry<V> = {
  expiresAt: number;
  value: V;
};

interface BoundedTtlMemoryCache<K, V> {
  clear(): void;
  delete(key: K): void;
  get(key: K, now?: number): V | null;
  set(key: K, value: V, ttlMs: number, now?: number): void;
}

export function createBoundedTtlMemoryCache<K, V>(maxEntries: number): BoundedTtlMemoryCache<K, V> {
  const store = new Map<K, CacheEntry<V>>();

  function evictExpired(now: number): void {
    // Lazy expiry on `get` handles the common path. This proactive sweep only
    // runs when the cache is at capacity, so a new insert would otherwise
    // force an LRU eviction — expired entries are preferred eviction
    // candidates over valid-but-old ones.
    if (store.size < maxEntries) return;
    for (const [key, entry] of store.entries()) {
      if (entry.expiresAt <= now) {
        store.delete(key);
      }
    }
  }

  function evictOverflow(): void {
    while (store.size > maxEntries) {
      const oldestKey = store.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      store.delete(oldestKey);
    }
  }

  return {
    clear(): void {
      store.clear();
    },
    delete(key: K): void {
      store.delete(key);
    },
    get(key: K, now = Date.now()): V | null {
      const entry = store.get(key);
      if (!entry) {
        return null;
      }
      if (entry.expiresAt <= now) {
        store.delete(key);
        return null;
      }

      // Refresh insertion order so the map doubles as a small LRU.
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },
    set(key: K, value: V, ttlMs: number, now = Date.now()): void {
      evictExpired(now);
      store.delete(key);
      store.set(key, { expiresAt: now + ttlMs, value });
      evictOverflow();
    },
  };
}
