import { getE2BOrphanReaperBatchLimit, getE2BOrphanReaperMinAgeMs } from "../constants/e2b-cleanup";
import type { Logger } from "../logger";
import { createLogger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { emitRuntimeTerminateEvent } from "../session/e2b-runtime-lifecycle";
import type {
  E2BOrphanGuardReasonCode,
  E2BOrphanGuardRequest,
  E2BOrphanGuardResponse,
  E2BOrphanGuardRuntimeReadUnavailableKind,
} from "../session/internal-routes";
import { SESSION_INTERNAL_ORIGIN } from "../session/internal-routes";
import { getSessionStub } from "../session/state";
import type { Env } from "../types";
import type { E2BListedSandbox } from "./e2b-client";
import { createSandboxProviderClient, type SandboxProviderClient } from "./provider-client";
import {
  E2B_CLOUD_RUNTIME_BACKEND,
  isValidRuntimeBackend,
  parsePersistedRuntimeBackendOrNull,
  type RuntimeBackend,
} from "./runtime-backend";

type SandboxReferenceSource = "session_index";

export type E2BSandboxD1Reference = {
  runtimeSandboxId: string;
  runtimeBackend: RuntimeBackend | null;
  source: SandboxReferenceSource;
  state: string | null;
  ownerId: string;
};

export type E2BOrphanReaperListedSandbox = E2BListedSandbox & {
  runtimeBackend: RuntimeBackend;
};

export type E2BOrphanReaperCandidate = E2BOrphanReaperListedSandbox & {
  ageMs: number;
};

export type E2BOrphanReaperResult = {
  listed: number;
  referenced: number;
  young: number;
  candidates: number;
  reaped: number;
  missing: number;
  // Candidates carrying metadata.session_id whose owning Session DO confirmed it
  // still owns the live VM — never terminated.
  protected: number;
  // Owned/ambiguous candidates skipped this sweep (owner guard returned defer or
  // the guard call itself failed — fail closed).
  deferred: number;
  errors: number;
};

type E2BOrphanReaperClient = Pick<SandboxProviderClient, "listCycloidSandboxes" | "terminateSandbox">;

// Owner guard: asks the owning Session DO whether an unreferenced candidate that
// carries metadata.session_id is still owned by a live session. Injectable for
// tests; the default calls the internal DO endpoint.
export type E2BOrphanOwnerGuard = (req: E2BOrphanGuardRequest) => Promise<E2BOrphanGuardResponse>;

async function callE2BOwnerGuardViaSessionDO(env: Env, req: E2BOrphanGuardRequest): Promise<E2BOrphanGuardResponse> {
  const stub = getSessionStub(env, req.sessionId);
  const response = await stub.fetch(new URL("/internal/runtime/e2b/owner-guard", SESSION_INTERNAL_ORIGIN).href, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.SANDBOX_RUNTIME_CLEANUP_SECRET}`,
    },
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    throw new Error(`Owner-guard DO call failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as E2BOrphanGuardResponse;
}

const log = createLogger({ bindings: { component: "e2b-orphan-reaper" } });
const MAX_D1_QUERY_BINDINGS = 100;

function parseRuntimeBackendFromMetadata(metadata: Record<string, string>): RuntimeBackend {
  const runtimeBackend = metadata.runtime_backend;
  if (runtimeBackend != null && runtimeBackend !== "" && isValidRuntimeBackend(runtimeBackend)) {
    return runtimeBackend;
  }
  return E2B_CLOUD_RUNTIME_BACKEND;
}

export function selectE2BOrphanReaperCandidates(
  sandboxes: E2BOrphanReaperListedSandbox[],
  references: Iterable<E2BSandboxD1Reference>,
  nowMs: number,
  minAgeMs: number,
): {
  candidates: E2BOrphanReaperCandidate[];
  referenced: number;
  young: number;
} {
  const referencedIds = new Set([...references].map(referenceKey));
  const candidates: E2BOrphanReaperCandidate[] = [];
  let referenced = 0;
  let young = 0;

  for (const sandbox of sandboxes) {
    if (referencedIds.has(referenceKey(sandbox))) {
      referenced++;
      continue;
    }
    const ageMs = nowMs - sandbox.createdAt;
    if (ageMs < minAgeMs) {
      young++;
      continue;
    }
    candidates.push({ ...sandbox, ageMs });
  }

  candidates.sort((a, b) => b.ageMs - a.ageMs || a.runtimeSandboxId.localeCompare(b.runtimeSandboxId));
  return { candidates, referenced, young };
}

export async function runE2BOrphanSandboxReaper(
  env: Env,
  options: {
    nowMs?: number;
    minAgeMs?: number;
    batchLimit?: number;
    client?: E2BOrphanReaperClient;
    ownerGuard?: E2BOrphanOwnerGuard;
    logger?: Logger;
  } = {},
): Promise<E2BOrphanReaperResult> {
  const logger = options.logger ?? log;
  const ownerGuard = options.ownerGuard ?? ((req: E2BOrphanGuardRequest) => callE2BOwnerGuardViaSessionDO(env, req));
  if (!env.DB) {
    return emptyResult();
  }

  const nowMs = options.nowMs ?? Date.now();
  const minAgeMs = options.minAgeMs ?? getE2BOrphanReaperMinAgeMs(env);
  const batchLimit = options.batchLimit ?? getE2BOrphanReaperBatchLimit(env);
  // Single pool: E2B isolates by team, and all Cycloid sandboxes for this env
  // live behind one API key, so the reaper lists and terminates via one client.
  const client = options.client ?? buildE2BOrphanReaperClient(env, logger);
  if (!client) return emptyResult();

  const sandboxes: E2BOrphanReaperListedSandbox[] = (await client.listCycloidSandboxes()).map((sandbox) => ({
    ...sandbox,
    runtimeBackend: parseRuntimeBackendFromMetadata(sandbox.metadata),
  }));
  const runtimeSandboxIds = sandboxes.map((sandbox) => sandbox.runtimeSandboxId);
  const references = await listE2BSandboxD1References(env.DB, runtimeSandboxIds);
  const selected = selectE2BOrphanReaperCandidates(sandboxes, references, nowMs, minAgeMs);
  const candidates = selected.candidates.slice(0, batchLimit);
  const latestReferencesBySandboxId = groupReferencesBySandboxId(
    await listE2BSandboxD1References(
      env.DB,
      candidates.map((candidate) => candidate.runtimeSandboxId),
    ),
  );
  let reaped = 0;
  let missing = 0;
  let protectedCount = 0;
  let deferred = 0;
  let errors = 0;

  for (const candidate of candidates) {
    const latestReferences = latestReferencesBySandboxId.get(candidate.runtimeSandboxId) ?? [];
    if (latestReferences.some((reference) => referenceKey(reference) === referenceKey(candidate))) continue;

    // Owner guard (the pinned-terminator fix): a candidate carrying
    // metadata.session_id may be a LIVE active-session VM that is only
    // transiently absent from session_index (projection desync). Ask the owning
    // Session DO before terminating, and fail CLOSED — protect, defer, and any
    // guard error all skip termination. Candidates with no session_id are true
    // orphans and proceed to the existing terminate path.
    const ownerSessionId = candidate.metadata?.session_id;
    // ARC-1248 observability: the owner-guard reason behind a session-tagged
    // reap (e.g. terminate_killed / terminate_zombie_confirmed / terminate_paused
    // _unreferenced). Null for a true orphan (no metadata.session_id), so the
    // reap log distinguishes "no owner" from "owner said terminate, here's why".
    let ownerGuardReasonCode: E2BOrphanGuardReasonCode | null = null;
    let ownerGuardRuntimeReadUnavailableKind: E2BOrphanGuardRuntimeReadUnavailableKind | null = null;
    let ownerGuardRuntimeReadUnavailableSweeps: number | null = null;
    if (ownerSessionId) {
      let guard: E2BOrphanGuardResponse;
      try {
        guard = await ownerGuard({
          sessionId: ownerSessionId,
          runtimeSandboxId: candidate.runtimeSandboxId,
          runtimeBackend: candidate.runtimeBackend,
          sweepStartedAtMs: nowMs,
          // ARC-1248: the physical E2B state the reaper already observed, so the
          // owner guard can prove liveness without a second listing/probe.
          candidateE2bStatus: candidate.status,
        });
      } catch (error) {
        deferred++;
        logger.warn(
          {
            event: "e2b_orphan_owner_guard_deferred",
            runtimeSandboxId: candidate.runtimeSandboxId,
            runtimeBackend: candidate.runtimeBackend,
            sessionId: ownerSessionId,
            ageMs: candidate.ageMs,
            status: candidate.status,
            error: String(error),
          },
          "E2B orphan owner guard deferred (guard call failed; fail closed)",
        );
        continue;
      }
      if (guard.decision !== "terminate") {
        if (guard.decision === "protect") protectedCount++;
        else deferred++;
        logger.info(
          {
            event: "e2b_orphan_owner_guard_skipped",
            runtimeSandboxId: candidate.runtimeSandboxId,
            runtimeBackend: candidate.runtimeBackend,
            sessionId: ownerSessionId,
            decision: guard.decision,
            reasonCode: guard.reasonCode,
            runtimeReadUnavailableKind: guard.runtimeReadUnavailableKind ?? null,
            runtimeReadUnavailableSweeps: guard.runtimeReadUnavailableSweeps ?? null,
            ageMs: candidate.ageMs,
            status: candidate.status,
          },
          "E2B orphan owner guard skipped termination",
        );
        continue;
      }
      // Guard returned terminate: record WHY so the reap is reason-attributable.
      ownerGuardReasonCode = guard.reasonCode;
      ownerGuardRuntimeReadUnavailableKind = guard.runtimeReadUnavailableKind ?? null;
      ownerGuardRuntimeReadUnavailableSweeps = guard.runtimeReadUnavailableSweeps ?? null;
    }

    try {
      const result = await client.terminateSandbox(candidate.runtimeSandboxId, "orphan_reaper");
      if (result.status === "killed") reaped++;
      else missing++;
      // Kill-path read channel (arm 3): direct-post so a reaper kill is queryable
      // in Datadog and joinable to a disconnect loss. Awaited (no DO waitUntil in
      // the cron context); the reaper is not a hot path.
      await emitRuntimeTerminateEvent({
        env,
        sessionId: ownerSessionId ?? null,
        runtimeSandboxId: candidate.runtimeSandboxId,
        reason: "orphan_reaper",
        terminateOutcome: result.status,
      });
      const logReaped = result.status === "killed" ? logger.info.bind(logger) : logger.warn.bind(logger);
      logReaped(
        {
          event: "e2b_orphan_reaped",
          runtimeSandboxId: candidate.runtimeSandboxId,
          runtimeBackend: candidate.runtimeBackend,
          runtimeTemplateId: candidate.runtimeTemplateId,
          ageMs: candidate.ageMs,
          status: candidate.status,
          d1Reference: null,
          // null when no metadata.session_id (true orphan); set when the owner
          // guard explicitly returned terminate for a claimed-but-stale session.
          ownerSessionId: ownerSessionId ?? null,
          // ARC-1248: low-cardinality facets so a reap is queryable end-to-end in
          // Datadog — `ownerSessionTagged` separates owner-guard reaps from true
          // orphans, `ownerGuardReasonCode` records the guard's terminate reason.
          ownerSessionTagged: ownerSessionId != null,
          ownerGuardReasonCode,
          ownerGuardRuntimeReadUnavailableKind,
          ownerGuardRuntimeReadUnavailableSweeps,
          terminateStatus: result.status,
        },
        "E2B orphan sandbox reaped",
      );
    } catch (error) {
      errors++;
      logger.error(
        {
          event: "e2b_orphan_reap_failed",
          runtimeSandboxId: candidate.runtimeSandboxId,
          runtimeBackend: candidate.runtimeBackend,
          runtimeTemplateId: candidate.runtimeTemplateId,
          ageMs: candidate.ageMs,
          status: candidate.status,
          error: String(error),
        },
        "E2B orphan sandbox reap failed",
      );
    }
  }

  const result: E2BOrphanReaperResult = {
    listed: sandboxes.length,
    referenced: selected.referenced,
    young: selected.young,
    candidates: selected.candidates.length,
    reaped,
    missing,
    protected: protectedCount,
    deferred,
    errors,
  };

  // Sweep heartbeat: the reaper otherwise emits nothing on a healthy zero-work
  // sweep, so Datadog cannot tell "ran cleanly, no work" from "never ran"/"hung".
  // Direct-post (control-plane app logs are not shipped to Datadog) on every
  // sweep that completes, including the zero-orphan case. Low cardinality only —
  // bounded counts, no IDs. Swallow post failures; the sweep already succeeded.
  await postStructuredEventToDd(env, {
    event: "e2b_orphan_reaper.swept",
    listed: result.listed,
    referenced: result.referenced,
    young: result.young,
    candidates: result.candidates,
    reaped: result.reaped,
    missing: result.missing,
    protected: result.protected,
    deferred: result.deferred,
    errors: result.errors,
  }).catch(() => false);

  return result;
}

export async function listE2BSandboxD1References(
  db: D1Database,
  runtimeSandboxIds: string[],
): Promise<E2BSandboxD1Reference[]> {
  const uniqueIds = [...new Set(runtimeSandboxIds.filter(Boolean))];
  const references: E2BSandboxD1Reference[] = [];

  for (let offset = 0; offset < uniqueIds.length; offset += MAX_D1_QUERY_BINDINGS) {
    const ids = uniqueIds.slice(offset, offset + MAX_D1_QUERY_BINDINGS);
    if (ids.length === 0) continue;
    const placeholders = ids.map(() => "?").join(", ");
    // Truth-filter the protect-set: only non-terminal owners shield a sandbox
    // from the reaper. A killed/draining/failed/expired-lease row still retains
    // runtime_sandbox_id, so without these filters a leaked sandbox is shielded
    // forever.
    // No `runtime_provider` predicate: the candidate ids are E2B sandbox ids and
    // freestyle ids live in a different namespace, so this can only ever ADD rows to
    // the protect-set (never reap more). Dropping it is defense-in-depth against a
    // hypothetical id collision and future-proofs a second provider's ids.
    const sessionRows = await db
      .prepare(
        `SELECT runtime_sandbox_id, runtime_backend, session_id, runtime_state
           FROM session_index
           WHERE runtime_state IN ('running', 'paused')
             AND runtime_sandbox_id IN (${placeholders})`,
      )
      .bind(...ids)
      .all();

    references.push(
      ...(
        (sessionRows.results ?? []) as Array<{
          runtime_sandbox_id: string;
          runtime_backend: string | null;
          session_id: string;
          runtime_state: string | null;
        }>
      ).map((row) => ({
        runtimeSandboxId: row.runtime_sandbox_id,
        runtimeBackend: parsePersistedRuntimeBackendOrNull(row.runtime_backend),
        source: "session_index" as const,
        state: row.runtime_state,
        ownerId: row.session_id,
      })),
    );
  }

  return references;
}

// Returns null when E2B is unconfigured so the reaper early-returns emptyResult()
// instead of constructing a keyless client whose listCycloidSandboxes() would
// throw missing_config and turn a disabled reaper into scheduled-task failures.
function buildE2BOrphanReaperClient(env: Env, logger: Logger): E2BOrphanReaperClient | null {
  if (!env.E2B_API_KEY) return null;
  return createSandboxProviderClient(E2B_CLOUD_RUNTIME_BACKEND, {
    apiKey: env.E2B_API_KEY,
    domain: env.E2B_DOMAIN,
    logger,
  });
}

function referenceKey(value: { runtimeSandboxId: string }): string {
  return value.runtimeSandboxId;
}

function groupReferencesBySandboxId(references: E2BSandboxD1Reference[]): Map<string, E2BSandboxD1Reference[]> {
  const referencesBySandboxId = new Map<string, E2BSandboxD1Reference[]>();
  for (const reference of references) {
    const existing = referencesBySandboxId.get(reference.runtimeSandboxId);
    if (existing) existing.push(reference);
    else referencesBySandboxId.set(reference.runtimeSandboxId, [reference]);
  }
  return referencesBySandboxId;
}

function emptyResult(): E2BOrphanReaperResult {
  return {
    listed: 0,
    referenced: 0,
    young: 0,
    candidates: 0,
    reaped: 0,
    missing: 0,
    protected: 0,
    deferred: 0,
    errors: 0,
  };
}
