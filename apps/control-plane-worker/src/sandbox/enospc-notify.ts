// Emits the arcanist.sandbox.disk.enospc COUNT — the real disk-full OUTCOME: a
// session git operation (commit/push) failed with an ENOSPC signature because the
// sandbox disk is exhausted. The disk equivalent of the arcanist.sandbox.memory
// .undersized OOM counter; the disk-pressure monitor pages off THIS, not a
// disk-usage threshold (a repo can sit at ~97% disk and succeed — openevidence/xyla
// does — so only the actual failure is actionable).
//
// Best-effort: no-ops without DD_API_KEY (local dev); a telemetry hiccup must never
// affect the session. Low-cardinality tags only (repo_owner/repo_name/business_id +
// source), matching undersize-notify.ts.

import { CONTROL_PLANE_SERVICE_NAME } from "../constants/observability";
import { postCountMetric } from "../observability/pr-metrics";
import type { Env } from "../types";

export interface SandboxEnospcInput {
  repoOwner: string | null;
  repoName: string | null;
  businessId: string | null;
  // The failing operation (e.g. "push"), for the source: tag.
  source: string | null;
}

type EnospcNotifyEnv = Pick<Env, "DD_API_KEY" | "WORKER_ENV">;

export async function notifySandboxEnospc(env: EnospcNotifyEnv, input: SandboxEnospcInput): Promise<void> {
  const ddApiKey = env.DD_API_KEY;
  if (!ddApiKey) return;
  const tags = [
    `service:${CONTROL_PLANE_SERVICE_NAME}`,
    `env:${env.WORKER_ENV || "production"}`,
    `repo_owner:${input.repoOwner ?? "unknown"}`,
    `repo_name:${input.repoName ?? "unknown"}`,
    ...(input.businessId ? [`business_id:${input.businessId}`] : []),
    ...(input.source ? [`source:${input.source}`] : []),
  ];
  await postCountMetric(ddApiKey, "arcanist.sandbox.disk.enospc", tags, "sandbox-enospc");
}
