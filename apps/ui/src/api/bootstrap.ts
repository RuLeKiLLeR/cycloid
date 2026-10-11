import type { BootstrapResponse } from "../../../../shared/types/bootstrap";
import { apiCacheKeys, swr } from "./cache";
import { requestJson } from "./client";

const BOOTSTRAP_STALE_MS = 30_000;

export async function fetchBootstrap(
  options: { refreshRepos?: boolean; force?: boolean; onRevalidate?: (value: BootstrapResponse) => void } = {},
): Promise<BootstrapResponse> {
  const key = apiCacheKeys.bootstrap(options);
  // NOTE: route-coverage test parses this fetch path statically -- keep string literals in requestJson calls
  if (options.refreshRepos) {
    const result = await swr(
      key,
      () => requestJson<BootstrapResponse>("/api/bootstrap?refresh=true", undefined, "Failed to fetch bootstrap data"),
      { staleMs: BOOTSTRAP_STALE_MS, force: options.force, onRevalidate: options.onRevalidate },
    );
    return result.value;
  }
  const result = await swr(
    key,
    () => requestJson<BootstrapResponse>("/api/bootstrap", undefined, "Failed to fetch bootstrap data"),
    { staleMs: BOOTSTRAP_STALE_MS, force: options.force, onRevalidate: options.onRevalidate },
  );
  return result.value;
}
