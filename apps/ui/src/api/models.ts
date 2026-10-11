import type { Provider } from "../types";
import { apiCacheKeys, dedupe } from "./cache";
import { requestJson } from "./client";

export async function fetchModels(): Promise<Provider[]> {
  // NOTE: route-coverage test parses this fetch path statically -- keep string literals in requestJson calls
  return dedupe(apiCacheKeys.models(), () =>
    requestJson<Provider[]>("/api/models", { cache: "no-store" }, "Failed to fetch models"),
  );
}
