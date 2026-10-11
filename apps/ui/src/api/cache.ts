import { captureApiError, trackApiAction } from "./client";
import { purgeHomeSnapshots, purgeHomeSnapshotsForApiPrefix } from "./home-snapshot";

const MAX_CACHE_ENTRIES = 200;

type CacheEntry<T> = {
  value: T;
  ts: number;
  gen: number;
};

type InFlightEntry<T> = {
  promise: Promise<T>;
  cacheGen: number;
  keyGen: number;
};

type SwrOptions<T> = {
  staleMs: number;
  force?: boolean;
  serveStale?: boolean;
  onRevalidate?: (value: T) => void;
  isEqual?: (prev: T, next: T) => boolean;
};

type SwrResult<T> = {
  value: T;
  stale: boolean;
  revalidating: boolean;
};

let cacheGen = 0;
const results = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, InFlightEntry<unknown>>();
const keyGens = new Map<string, number>();

function nowMs() {
  return Date.now();
}

function keyGen(key: string) {
  return keyGens.get(key) ?? 0;
}

function bumpKeyGen(key: string) {
  keyGens.set(key, keyGen(key) + 1);
}

function remember<T>(key: string, entry: CacheEntry<T>) {
  results.delete(key);
  results.set(key, entry);
  while (results.size > MAX_CACHE_ENTRIES) {
    const firstKey = results.keys().next().value;
    if (typeof firstKey !== "string") break;
    results.delete(firstKey);
  }
}

function getCached<T>(key: string): CacheEntry<T> | undefined {
  const entry = results.get(key) as CacheEntry<T> | undefined;
  if (!entry) return undefined;
  results.delete(key);
  results.set(key, entry);
  return entry;
}

function isCurrentGeneration(key: string, startCacheGen: number, startKeyGen: number) {
  return cacheGen === startCacheGen && keyGen(key) === startKeyGen;
}

function startRequest<T>(
  key: string,
  fetcher: () => Promise<T>,
  options?: SwrOptions<T>,
  previous?: CacheEntry<T>,
): Promise<T> {
  if (options?.force) {
    inFlight.delete(key);
    bumpKeyGen(key);
  }
  const existing = inFlight.get(key) as InFlightEntry<T> | undefined;
  // Concurrent callers share the request owner; only that owner's revalidation callback runs.
  if (existing) return existing.promise;

  const startCacheGen = cacheGen;
  const startKeyGen = keyGen(key);
  const promise = fetcher()
    .then((value) => {
      if (!isCurrentGeneration(key, startCacheGen, startKeyGen)) return value;
      remember(key, { value, ts: nowMs(), gen: startKeyGen });
      if (previous && options?.onRevalidate && !options.isEqual?.(previous.value, value)) {
        options.onRevalidate(value);
      }
      return value;
    })
    .catch((error) => {
      if (previous && isCurrentGeneration(key, startCacheGen, startKeyGen)) {
        captureApiError(error, { cacheKey: key, phase: "swr_revalidate" });
        trackApiAction("ui_api_cache_revalidate_failed", { cacheKey: key });
      }
      throw error;
    })
    .finally(() => {
      const current = inFlight.get(key);
      if (current?.promise === promise) inFlight.delete(key);
    });

  inFlight.set(key, { promise, cacheGen: startCacheGen, keyGen: startKeyGen });
  return promise;
}

export async function swr<T>(key: string, fetcher: () => Promise<T>, options: SwrOptions<T>): Promise<SwrResult<T>> {
  const cached = getCached<T>(key);
  if (cached && !options.force) {
    const stale = nowMs() - cached.ts > options.staleMs;
    if (!stale) return { value: cached.value, stale: false, revalidating: false };
    const serveStale = options.serveStale ?? Boolean(options.onRevalidate);
    if (!serveStale) {
      const value = await startRequest(key, fetcher, options, cached);
      return { value, stale: false, revalidating: false };
    }
    const revalidation = startRequest(key, fetcher, options, cached);
    void revalidation.catch(() => {});
    return { value: cached.value, stale: true, revalidating: true };
  }

  const value = await startRequest(key, fetcher, options);
  return { value, stale: false, revalidating: false };
}

export async function dedupe<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as InFlightEntry<T> | undefined;
  if (existing) return existing.promise;
  const startCacheGen = cacheGen;
  const startKeyGen = keyGen(key);
  const promise = fetcher().finally(() => {
    const current = inFlight.get(key);
    if (current?.promise === promise) inFlight.delete(key);
  });
  inFlight.set(key, { promise, cacheGen: startCacheGen, keyGen: startKeyGen });
  return promise;
}

export function invalidate(keyPrefix: string): void {
  purgeHomeSnapshotsForApiPrefix(keyPrefix);
  for (const key of results.keys()) {
    if (key.startsWith(keyPrefix)) {
      results.delete(key);
      bumpKeyGen(key);
    }
  }
  for (const key of inFlight.keys()) {
    if (key.startsWith(keyPrefix)) bumpKeyGen(key);
  }
}

export function clearApiCache(): void {
  purgeHomeSnapshots();
  cacheGen += 1;
  results.clear();
  inFlight.clear();
  keyGens.clear();
}

export const apiCacheKeys = {
  adminBusinesses: () => "/api/admin/businesses",
  adminConsoleBusinesses: () => "/api/admin/console/businesses",
  bootstrap: (options?: { refreshRepos?: boolean }) =>
    options?.refreshRepos ? "/api/bootstrap?refresh=true" : "/api/bootstrap",
  cliTokens: () => "/api/cli-tokens",
  integrations: () => "/api/user/integrations",
  models: () => "/api/models",
  openAiUsage: () => "/api/settings/openai-usage",
  pendingSignups: () => "/api/admin/pending-signups",
  repos: (options?: { refresh?: boolean }) => (options?.refresh ? "/api/repos?refresh=1" : "/api/repos?"),
  repoEnvironment: (businessId: string, repoOwner: string, repoName: string) =>
    `/api/businesses/${businessId}/repos/${repoOwner}/${repoName}/environment-variables`,
  personalSecrets: () => "/api/settings/personal-secrets",
  repoSkills: (owner: string, repo: string) => `/api/repos/${owner.toLowerCase()}/${repo.toLowerCase()}/skills`,
  sessions: (options?: {
    scope?: "personal" | "business";
    cursor?: string | null;
    status?: string | null;
    query?: string | null;
  }) => {
    const params: string[] = [];
    if (options?.scope === "business") params.push("scope=business");
    if (options?.cursor) params.push(`cursor=${encodeURIComponent(options.cursor)}`);
    if (options?.status) params.push(`status=${encodeURIComponent(options.status)}`);
    const query = options?.query?.trim();
    if (query) params.push(`q=${encodeURIComponent(query)}`);
    return `/api/sessions?${params.join("&")}`;
  },
  settings: (options?: { scope?: "full" }) =>
    options?.scope === "full" ? "/api/settings?scope=full" : "/api/settings?",
} as const;
