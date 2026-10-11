import type { PrInboxBucket } from "../../api/pr-inbox";
import { PR_BUCKET_ORDER } from "./bucket-config";

const VALID_BUCKETS: ReadonlySet<string> = new Set(PR_BUCKET_ORDER);

/** Parse persisted collapsed buckets, dropping unknown names and corrupt JSON. */
export function parseCollapsedBuckets(raw: string | null): PrInboxBucket[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (bucket): bucket is PrInboxBucket => typeof bucket === "string" && VALID_BUCKETS.has(bucket),
      );
    }
  } catch {
    // Corrupt JSON — treat as nothing collapsed.
  }
  return [];
}
