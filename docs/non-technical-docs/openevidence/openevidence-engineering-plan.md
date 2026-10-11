# OpenEvidence — Engineering Plan (Pre-Execution Tickets)

Scope: code/infra half. Companion to [openevidence-docs-plan.md](openevidence-docs-plan.md). Each ticket is a single-PR-sized unit grounded in real patterns from this codebase.

Post-execution items (§3.5, §3.3 JIT, §2.2, §10.1 SDLC formalization, §3.2, §3.3 FIDO2, §14.1, §8.6) are tracked in the action items doc and not ticketed here.

---

## Ticket summary

| Ticket | Work                                                                | Difficulty | Work type       | Depends on | Notes                                                                                                    |
| ------ | ------------------------------------------------------------------- | ---------- | --------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| T1     | Restricted-mode business preset                                     | Hard       | Outside-of-code | T2, T5     | Runtime policy, credential suppression, egress, retention, UI, audit, and rollout proof.                 |
| T2     | Business admin toggle expansion                                     | Hard       | Outside-of-code | None       | New settings must flow into sandbox start, egress policy, BYOK, write controls, and retention.           |
| T3     | Customer-initiated content deletion                                 | Hard       | Outside-of-code | T5, T2     | Destructive D1/S3/Braintrust job with idempotency, retries, audit, and broad table coverage.             |
| T4     | Customer Content bulk export                                        | Hard       | Outside-of-code | T5, T11    | Archive/download behavior, artifact aggregation, audit logs, redaction, and schema validation.           |
| T5     | Audit-log table + per-business audit export API                     | Medium     | Code-only       | None       | Foundation table/API plus multiple call-site emits using normal D1/service/route patterns.               |
| T6     | Retention purge for transcripts, artifacts, customer-content logs   | Hard       | Outside-of-code | T2         | Scheduled destructive purge across D1/S3 plus Datadog retention semantics.                               |
| T7     | GitHub agent write-path restrictions                                | Medium     | Code-only       | T14        | Sandbox-bridge guardrail and tests; ship after T14 because it blocks workflow edits.                     |
| T8     | GitHub Octokit attribution instrumentation                          | Medium     | Code-only       | None       | Small factory change plus direct-GitHub-fetch sweep.                                                     |
| T9     | Secret-injection audit + snapshot regression test                   | Easy       | Code-only       | T11        | Documentation plus focused static/runtime regression tests.                                              |
| T10    | Plaintext customer-secret read-path removal                         | Medium     | Code-only       | None       | Audit and targeted masking/gating across secret read surfaces.                                           |
| T11    | Extend secret redaction middleware to Datadog / Braintrust / Sentry | Medium     | Code-only       | None       | Cross-package redactor consolidation plus boundary-wrapper tests.                                        |
| T12    | 24h post-hoc notification on privileged-access events               | Medium     | Outside-of-code | T5         | Needs `PRIVILEGED_ACCESS_SLACK_CHANNEL` env/SSM and Slack delivery proof.                                |
| T13    | Break-glass intake + audit                                          | Medium     | Code-only       | T5, T12    | Admin route, migration, validator, audit write; Slack can no-op when config is missing locally.          |
| T14    | Enable GHAS: Dependabot + CodeQL                                    | Easy       | Outside-of-code | None       | GitHub repo/org settings plus first green CodeQL/Dependabot evidence.                                    |
| T15    | Vulnerability tracking + SLA workflow                               | Easy       | Code-only       | T14        | Workflow/process code; actual label creation and first Dependabot triage are operational follow-through. |
| T16    | PagerDuty integration + on-call escalation                          | Medium     | Outside-of-code | None       | Terraform monitor changes plus Datadog/PagerDuty setup and QA alert proof.                               |
| T17    | Key + token rotation tooling                                        | Hard       | Outside-of-code | T5, T12    | Destructive credential rotation scripts/routes, audit, notification, dry-run, and QA proof.              |
| T18    | D1 time-travel + S3 backup + DR restore test                        | Hard       | Outside-of-code | None       | Terraform/import risk, Cloudflare D1 time-travel, S3 versioning, and RTO/RPO evidence.                   |

**Suggested ship order:**

1. T2, T5, T11 (foundations, parallel)
2. T14 (workflow/package security setup, before T7 blocks workflow edits)
3. T7, T8, T9, T10 (parallel — single-PR audits + tests)
4. T3, T4, T6, T12, T13 (parallel — depend on T2/T5/T11)
5. T1 (depends on T2 + T5)
6. T15
7. T16, T17, T18 (parallel)

Each ticket is one PR; T3/T4/T5 each include their migration + DAO + route + tests in a single PR to keep the deploy atomic.

---

## Implementation conventions

- **Routes**: `Route` shape in `apps/control-plane-worker/src/routes/businesses.ts:143-224`. `auth: "authenticated"`, handler receives `(request, env, match, auth)`, returns `jsonResponse(...)` / `jsonErrorResponse(msg, status)`. Bodies parsed via `parseJsonBody(request)`. DB via `assertDatabase(env)`.
- **DAO**: D1 prepared statements (`db.prepare(...).bind(...).first<T>() | .run()`) returning typed rows. Example `business/db.ts:38-68, 148-170`.
- **Service**: thin wrapper around DAO in e.g. `business/service.ts`; no error throwing.
- **Migrations**: `apps/control-plane-worker/migrations/NNNN_snake_case.sql`, `CREATE TABLE IF NOT EXISTS`, integer ms timestamps, `CREATE INDEX IF NOT EXISTS`. See `0099_integration_lifecycle_events.sql`, `0111_impersonation_sessions.sql`.
- **Admin gating**: `ensureActorCanImpersonate` (`routes/admin-impersonation.ts:38-69`) — `authMode === "user_session"` + Cycloid admin check via `verifyCycloidAdmin` + current browser session cookie (no sudo-style freshness window).
- **Scheduled tasks**: `withScheduledTask(failureMessage, async (db) => {...}, { requiresDb: true })` dispatched by `controller.cron` in `router.ts:255-460`. Cron list at `wrangler.toml:95-96`.
- **Logger**: `createLogger({ bindings: {component: "..."} })`, `log.info({event, ...}, msg)`. Correlation fields auto-attached. Datadog export via `postDatadogLogs(env, entries)` in `observability/events-exporter.ts:76-120`.
- **Slack**: `postMessage(token, channel, text, blocks?)` in `apps/control-plane-worker/src/slack/notify.ts:140-151`.
- **Secret redaction**: `SECRET_PATTERNS` + `redactSecrets()` at `shared/transcript/customer-activity-projector.ts:103-134`.
- **Octokit**: factory at `apps/control-plane-worker/src/github/octokit.ts:71-116`. Per-request, no plugins today.
- **Protection**: `checkToolSafety(tool, input) → ToolSafetyViolation | null` at `apps/sandbox-bridge/src/utils/protection.ts:72-114`. Constants in `apps/sandbox-bridge/src/constants/bridge.ts:372-396`. Pre-execution guard at `apps/sandbox-bridge/src/bridge.ts:emitParentToolCallWithInput`.
- **Validation**: hand-rolled type guards returning `Response | TypedValue` (see `parseBusinessSettingsUpdatePayload` at `routes/businesses.ts:65-82`).

---

## Ticket details

## T1. Restricted-mode business preset (§15.3)

**Backs.** Redline counters for §10.2 / §11.4 / §15.3; OpenEvidence addendum §3; security package Section 7.2.

**Depends on.** T2 (the toggle columns it bundles), T5 (audit-log writes on enable/disable).

**Migration.** `apps/control-plane-worker/migrations/0112_business_restricted_mode.sql`:

```sql
ALTER TABLE businesses ADD COLUMN restricted_mode_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE businesses ADD COLUMN restricted_mode_enabled_at INTEGER;
ALTER TABLE businesses ADD COLUMN restricted_mode_enabled_by INTEGER REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_businesses_restricted_mode ON businesses(restricted_mode_enabled);
```

**DAO.** Extend `apps/control-plane-worker/src/business/db.ts`:

```typescript
export async function updateBusinessRestrictedMode(
  db: D1Database,
  id: string,
  enabled: boolean,
  actorUserId: number,
): Promise<boolean> {
  const now = Date.now();
  const result = await db
    .prepare(
      "UPDATE businesses SET restricted_mode_enabled = ?, restricted_mode_enabled_at = ?, restricted_mode_enabled_by = ?, updated_at = ? WHERE id = ?",
    )
    .bind(enabled ? 1 : 0, enabled ? now : null, enabled ? actorUserId : null, now, id)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}
```

Extend `getBusiness` row mapper to return `restrictedModeEnabled: boolean`.

**Route.** Add `"restrictedModeEnabled"` to `BUSINESS_SETTING_FIELDS` at `routes/businesses.ts:46`. Reuse the existing `PUT /api/businesses/:id` handler. When `parsed.field === "restrictedModeEnabled"`, the handler enforces a server-side bundle effect: when set to `true`, also force the following T2 columns: `persistence_disabled = 1`, `write_capability_disabled = 1`, `transcript_retention_days = 1`, `artifact_retention_days = 1`. Persist them in the same transaction (D1 batch). Audit-log via T5 with `event_type = "business.restricted_mode.update"`.

**Service.** `setBusinessRestrictedMode(db, businessId, enabled, actorUserId)` in `business/service.ts`.

**Sandbox session-start.** At session start, extend `apps/control-plane-worker/src/integrations/runtime.ts` and the session creation path that builds the sandbox runtime payload. When `restricted_mode_enabled = 1`, short-circuit to the restricted profile: refuse agent writes, skip user and business integration credential injection from `user_integrations` / `business_integration_credentials`, skip repo login env blob injection from `env_blobs`, apply the business-specific egress allowlist from T2, force 1-day retention, and refuse PHI activation. Do not rely on a credential `prod` tag; no such column exists today.

**UI.** Add a "Restricted mode" toggle to the Workspace integrations page (currently routed at `/settings/workspace-integrations` via `apps/ui/src/pages/SettingsPage.tsx`). Above the existing toggles. Confirm modal listing the bundled effects before enable.

**Tests.** `tests/test_cloudflare/business/restricted-mode.test.ts`:

- Toggling on returns `{ok: true}` and the GET reflects all bundled fields.
- Session created under a restricted business has `agent write blocked` assertion (reuse harness from `tests/test_agent/protection.test.ts:11-120` pattern but at session level).
- Audit log row exists after toggle.

**Done when.** All assertions pass; UI flip in QA exercises the full bundle.

---

## T2. Business admin toggle expansion (§15.1)

**Backs.** Redline counter for §15.1; addendum §3; package Section 7.1.

**Migration.** `apps/control-plane-worker/migrations/0113_business_admin_toggles.sql`:

```sql
ALTER TABLE businesses ADD COLUMN persistence_disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE businesses ADD COLUMN write_capability_disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE businesses ADD COLUMN transcript_retention_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE businesses ADD COLUMN artifact_retention_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE businesses ADD COLUMN customer_log_retention_days INTEGER NOT NULL DEFAULT 14;
ALTER TABLE businesses ADD COLUMN egress_allowlist_json TEXT;
ALTER TABLE businesses ADD COLUMN byok_model_provider_integration_id TEXT;
```

**DAO.** Seven new setters in `business/db.ts` following the `updateBusinessSharedSessions` pattern (one statement, returns boolean from `result.meta?.changes`). All bind validated values; retention setters clamp to a sane band: `transcript_retention_days ∈ [1, 365]`, `artifact_retention_days ∈ [1, 365]`, `customer_log_retention_days ∈ [1, 365]`. `egress_allowlist_json` is a stringified array; route validation parses it as `string[]` before save and rejects with a 400 otherwise. `byok_model_provider_integration_id` is `openai`, `anthropic`, or `null` depending on the configured model provider.

**Route.** Extend `BUSINESS_SETTING_FIELDS` at `routes/businesses.ts:46` to:

```typescript
const BUSINESS_SETTING_FIELDS = new Set([
  "sharedSessions",
  "selfHostedSandboxesEnabled",
  "restrictedModeEnabled", // T1
  "persistenceDisabled",
  "writeCapabilityDisabled",
  "transcriptRetentionDays",
  "artifactRetentionDays",
  "customerLogRetentionDays",
  "egressAllowlist",
  "byokModelProviderIntegrationId",
]);
```

Update `parseBusinessSettingsUpdatePayload` to validate the new fields (boolean, integer in band, string[], `"openai"`-or-null). Keep the existing per-field rate limit (KV bucket key includes `field`).

**Wire-up.** Sandbox session-start path must read these from D1, not from env vars:

- `persistence_disabled` flips pause/resume disabled.
- `write_capability_disabled` disables the agent's GitHub push path (`apps/sandbox-bridge/src/services/git/push.ts`).
- `egress_allowlist_json`, when set, overrides the env-var-sourced allowlist at `E2B_SANDBOX_EGRESS_ALLOWLIST_BY_BUSINESS_JSON`. Migrate the existing consumer in `apps/control-plane-worker/src/sandbox/egress-policy.ts` to read D1 first, fall back to env var if column is null. Document the transition in `docs/non-technical-docs/security/source/cycloid-security-package.md` Section 2.4.
- `byok_model_provider_integration_id`, when set, requires the model-provider integration scope for that provider to resolve to `business` in `business_integrations` and requires a corresponding encrypted row in `business_integration_credentials`; do not invent a credential ID because that table is keyed by `(business_id, integration_id)`.
- Retention columns are read by T6 purge handlers.

**Tests.** Extend `tests/test_cloudflare/business/settings.test.ts` (or create) — one test per field for happy path + invalid input (e.g., retention days = -1 returns 400).

**Done when.** Each field round-trips PUT → GET; egress allowlist from D1 takes precedence in a session-start integration test; retention values flow into T6.

---

## T3. Customer-initiated content deletion (§9.5)

**Backs.** Package Section 5.3.

**Depends on.** T5 (audit log row on initiation + completion), T2 (retention columns inform what "in-scope" means).

**Route.** `apps/control-plane-worker/src/routes/businesses.ts` — new entry in the route array. Keep the route thin: validate auth/input, then call a content-deletion service; the service owns DAO calls, S3/Braintrust/Datadog orchestration, and audit-log writes.

```typescript
{
  method: "POST",
  pattern: parsePattern("/api/businesses/:id/content/deletion-jobs"),
  auth: "authenticated",
  handler: async (request, env, match, auth) => {
    const businessId = match.groups!.id;
    const gate = await ensureBusinessAdminOrCanAccessAll(env, auth!, businessId);
    if (!gate.ok) return gate.response;
    const db = assertDatabase(env);
    const jobId = crypto.randomUUID();
    await requestContentDeletionJob(env, db, { id: jobId, businessId, requestedBy: gate.actorId, requestedAt: Date.now() });
    return jsonResponse({ ok: true, jobId }, 202);
  },
},
{
  method: "GET",
  pattern: parsePattern("/api/businesses/:id/content/deletion-jobs/:jobId"),
  auth: "authenticated",
  handler: /* returns { id, status, progress, completedAt, error } */
},
```

Reuse `ensureBusinessAdminOrCanAccessAll` (write the helper if not present, paralleling `requireAdmin` in `routes/businesses.ts` and `getBusinessForAdmin` in `business/db.ts`).

**Migration.** `0114_content_deletion_jobs.sql`:

```sql
CREATE TABLE IF NOT EXISTS content_deletion_jobs (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  requested_by INTEGER NOT NULL REFERENCES users(id),
  requested_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | complete | failed
  d1_deleted INTEGER NOT NULL DEFAULT 0,
  s3_deleted INTEGER NOT NULL DEFAULT 0,
  braintrust_deleted INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  completed_at INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_content_deletion_jobs_business ON content_deletion_jobs(business_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_deletion_jobs_status ON content_deletion_jobs(status);
```

**Execution.** Add a scheduled handler in `router.ts` (every 5 min slot already exists):

```typescript
ctx.waitUntil(
  withScheduledTask(
    "Content deletion job processor failed",
    async (db) => {
      const { processContentDeletionJobs } = await import("./session/content-deletion.js");
      await processContentDeletionJobs(env, db);
    },
    { requiresDb: true },
  ),
);
```

`processContentDeletionJobs` claims one pending job with a D1 compare-and-set update (select the oldest pending row, then `UPDATE ... WHERE id = ? AND status = 'pending'`; D1 does not support `UPDATE ... LIMIT 1 RETURNING` portably), runs:

1. **S3**: list sessions for the business from `session_index`, then list-and-delete each archive prefix `sessions/{sessionId}/` in `S3_SESSION_BUCKET` using the existing `aws4fetch` S3 helpers in `apps/control-plane-worker/src/services/archive.ts`. 1000-key batches.
2. **D1**: select the business's `session_index.session_id` values first; delete dependent session rows by `session_id` from `durable_event_replay_metadata`, `session_webhook_refs`, `slack_thread_session_refs`, `linear_issue_session_refs`, `session_feedback`, `session_evaluations`, `session_memory_usage`, `memory_usage_events`, `memory_pr_tracking`, `child_session_limit_reservations`, `runtime_capacity_admissions`, `slack_posts`, and `slack_interaction_requests`; then delete business-scoped rows from `usage_records`, `prompt_runs`, `session_completions`, `codegraph_observations`, `env_blobs`, and `session_index`. Do not delete `business_integrations` or credential rows; credential rotation/removal belongs to T17 / integration settings.
3. **Braintrust**: archive project for the business (Braintrust API — wire from `BRAINTRUST_API_KEY`). Soft-archive only; Braintrust UI exposes it.
4. **Datadog**: NOT deleted directly (retention-only). Document in the job result `notes` field.

On success, update `status='complete', completed_at`, emit T5 audit-log `business.content.deletion_completed` with summary counts. On failure, set `status='failed'`, write `error`; the next sweep retries up to 3 times (track via a `retry_count` column added in the same migration).

**Tests.** `tests/test_cloudflare/business/content-deletion.test.ts`:

- Seed a business with 3 sessions, 5 transcripts, S3 keys; POST job; manually run the scheduled handler; assert job becomes `complete`, all D1 rows + S3 keys are gone, audit-log shows initiation + completion.
- Idempotency: re-run after completion → no-op.

**Done when.** End-to-end test passes; sample QA business with synthetic content gets fully deleted within 7 days SLA per package Section 5.3.

---

## T4. Customer Content bulk export (§9.7)

**Backs.** Package Section 5.4.

**Depends on.** T5 (audit log on initiation + completion), T11 (redaction patterns applied to exported logs / configs).

**Route.** Mirror T3 and keep routes thin; use a `content-export` service for job creation, processing, archive assembly, S3 writes, and audit-log emits.

```typescript
{ method: "POST", pattern: parsePattern("/api/businesses/:id/exports"), ... }
{ method: "GET",  pattern: parsePattern("/api/businesses/:id/exports/:exportId"), ... }
```

POST returns `{ ok: true, exportId }`, 202. GET returns `{ id, status, downloadUrl, expiresAt }`.

**Migration.** `0115_content_exports.sql`:

```sql
CREATE TABLE IF NOT EXISTS content_exports (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  requested_by INTEGER NOT NULL REFERENCES users(id),
  requested_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  s3_key TEXT,
  bytes INTEGER,
  completed_at INTEGER,
  expires_at INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_content_exports_business ON content_exports(business_id, requested_at DESC);
```

**Execution.** Scheduled job (same router.ts pattern). For each pending export, assemble a single archive in S3 under `exports/{businessId}/{exportId}.tar.gz`. Workers do not currently have a tar helper in this repo; either add one narrowly scoped dependency or write newline-delimited JSON plus copied artifacts under an export prefix instead of hand-rolling tar bytes.

- `sessions/*.json` — paginated dump from `session_index` + `prompt_runs` + `session_completions` joined per session. Reuse `buildSessionTranscript` from `apps/control-plane-worker/src/eval/transcript.ts:172-235` for the markdown transcript per session.
- `artifacts/{sessionId}/...` — S3-to-S3 copy from existing archive keys under `sessions/{sessionId}/artifacts/...`.
- `audit-logs.json` — query T5 `audit_logs` for the business, run all string fields through `redactSecrets()` from T11 before write.
- `config.json` — `getBusiness()` snapshot with secret-bearing fields redacted (BYOK creds shown as masked previews only).

Return a 24h presigned S3 URL; set `expires_at = completed_at + 86_400_000`.

**Tests.** `tests/test_cloudflare/business/content-export.test.ts`: end-to-end seed → request → run handler → download URL → unpack → JSON-schema validate each member.

**Done when.** Exported tarball round-trips through a schema validator; secret-redaction regression covers the audit-logs.json + config.json files.

---

## T5. Audit-log table + per-business audit export API (§11.2)

**Backs.** Package Section 7.4 + 11.4; foundation for T3, T4, T12, T13, plus business setting changes.

**Migration.** `0116_audit_logs.sql`:

```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  business_id TEXT,
  event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL,         -- 'app' | 'end_user' | 'provider_employee' | 'agent'
  actor_id TEXT NOT NULL,
  target_kind TEXT,                 -- 'business' | 'session' | 'integration' | 'user' | ...
  target_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_business ON audit_logs(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event ON audit_logs(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_kind, actor_id, created_at DESC);
```

**DAO + service.** `apps/control-plane-worker/src/audit/db.ts` contains prepared-statement helpers; `apps/control-plane-worker/src/audit/service.ts` is the route/call-site entry point so routes keep the route -> service -> DAO layering.

```typescript
export interface WriteAuditLogParams {
  businessId?: string | null;
  eventType: string;
  actorKind: "app" | "end_user" | "provider_employee" | "agent";
  actorId: string;
  targetKind?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function writeAuditLog(db: D1Database, params: WriteAuditLogParams): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO audit_logs (id, business_id, event_type, actor_kind, actor_id, target_kind, target_id, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      params.businessId ?? null,
      params.eventType,
      params.actorKind,
      params.actorId,
      params.targetKind ?? null,
      params.targetId ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
      Date.now(),
    )
    .run();
  return id;
}

export async function listAuditLogs(
  db: D1Database,
  filter: {
    businessId?: string | null;
    sinceMs?: number;
    untilMs?: number;
    eventType?: string;
    eventTypePrefix?: string;
    notified?: boolean;
    limit: number;
    cursorMs?: number;
  },
): Promise<AuditLogRow[]> {
  /* paginated SELECT with bounded WHERE */
}
```

`audit/service.ts` exposes `recordAuditLog`, `listBusinessAuditLogs`, `listUnnotifiedPrivilegedAuditLogs`, and `markAuditLogsNotified`.

**Wire-up.** Audit-log emit added at every privileged or customer-visible state change:

- `routes/businesses.ts:172-223` — every successful settings update (after the existing `log.info({...}, "Business shared_sessions updated")` calls).
- `routes/admin-impersonation.ts:154-165` and `:209-217` — alongside the existing `log.warn` impersonation logs.
- `routes/admin-approvals.ts:75-145` — admin approval events.
- T3 deletion initiation + completion.
- T4 export initiation + completion.
- T13 break-glass intake.
- T12 privileged-access notifications (notification emit also recorded).

**Route.** `GET /api/businesses/:id/audit-log?since=...&until=...&event_type=...&cursor=...&limit=...` — admin-only, returns `{items, nextCursor}`. Reuse the `ensureBusinessAdminOrCanAccessAll` helper from T3 and call `listBusinessAuditLogs`; do not call DAO helpers directly from the route.

**Retention.** 1-year hard floor per package Section 5.2.K. Add a scheduled handler that deletes rows with `created_at < now - 365d` in 1000-row batches (mirror `deleteIntegrationLifecycleEventsBefore` pattern at `integrations/lifecycle/db.ts:165-198`).

**Tests.** `tests/test_cloudflare/audit/audit-log.test.ts`: a settings change writes one row; a deletion writes initiation + completion; the GET returns them in reverse-chronological order; cursor pagination works.

**Done when.** All wired call sites emit; GET returns the expected rows; retention sweep deletes only rows older than 365d.

---

## T6. Retention purge for transcripts, artifacts, customer-content logs (§9.4)

**Backs.** Package Section 5.2.

**Depends on.** T2 (retention columns).

**Scheduled handlers.** Add three to `router.ts` (gate behind the `1 6 * * *` daily cron):

```typescript
ctx.waitUntil(
  withScheduledTask(
    "Transcript retention purge failed",
    async (db) => {
      const { purgeExpiredTranscripts } = await import("./session/retention-purge.js");
      const summary = await purgeExpiredTranscripts(db, Date.now());
      logger.info({ ...summary }, "Transcript retention purge");
      await writeAuditLog(db, {
        eventType: "retention.transcript_purge",
        actorKind: "app",
        actorId: "scheduler",
        metadata: summary,
      });
    },
    { requiresDb: true },
  ),
);
// Similar for artifact purge (S3 list+delete) and customer-content log purge (Datadog Logs API retention adjust).
```

**Transcript purge.** Per business, compute `cutoff = now - transcript_retention_days * 86_400_000`; delete `prompt_runs` and `session_completions` rows where `business_id = ?` AND `created_at < ?`. For whole expired sessions, select expired `session_index.session_id` rows first, then delete dependent session rows (`durable_event_replay_metadata`, webhook/thread refs, feedback/evaluations, memory/session auxiliary tables) before deleting `session_index`. Batch 1000 per call. SQL pattern from `deleteIntegrationLifecycleEventsBefore`.

**Artifact purge.** Per business, list expired sessions from `session_index`, then S3 `ListObjectsV2` under `sessions/{sessionId}/artifacts/` filtered by `LastModified < cutoff`, batch-delete 1000 keys per call. Reuse the S3 helper extracted from `apps/control-plane-worker/src/services/archive.ts`; archive keys are session-scoped, not business-scoped.

**Customer-content log purge.** Datadog Logs API does not delete per-tag, only retention-by-tag. Two options — pick: (a) configure Datadog log indexes with custom retention per `business_id` tag via the Datadog Indexes API; (b) tag customer-content logs with `cycloid_customer_content:true` and apply a tag-scoped retention. Go with (a): write a one-time terraform `datadog_logs_index` per business when restricted-mode is enabled, defaulting to 14d. Out of scope for daily cron — this is config drift, not a purge.

**Tests.** `tests/test_cloudflare/retention/transcript-purge.test.ts`: seed expired rows, run handler, assert deletion + audit-log entry. Same for artifact purge against a local S3 mock.

**Done when.** Daily cron produces non-zero `deleted` counts in a test env; QA business with synthetic ancient data gets its rows + S3 keys purged at the next sweep.

---

## T7. GitHub agent write-path restrictions (§4.6)

**Backs.** Package Section 6.6; redline counter for §8.5.

**Extend protection constants.** `apps/sandbox-bridge/src/constants/bridge.ts:372-396`:

```typescript
export const PROTECTED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".github/workflows", // T7
]);

export const PROTECTED_BASENAMES: ReadonlySet<string> = new Set([
  ".env",
  ".key",
  ".pem",
  ".npmrc",
  ".pypirc",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "credentials.json",
  "credentials.yaml",
  "credentials.yml",
  "CODEOWNERS", // T7 (matches both ./CODEOWNERS and .github/CODEOWNERS via basename rule)
]);
```

Note: the existing `PROTECTED_DIRECTORIES` matcher checks segment equality, so `.github/workflows` won't match as a single segment — extend the matcher in `protection.ts:isProtectedPath` (lines 25-52) to also match multi-segment patterns by splitting the directory entry on `/` and checking a window of segments. Add `PROTECTED_DIRECTORY_PATTERNS: ReadonlyArray<readonly string[]>` for multi-segment entries (e.g., `[".github", "workflows"]`).

**Add a GitHub-API operation guard.** New file `apps/sandbox-bridge/src/utils/github-api-protection.ts`:

```typescript
export const BLOCKED_GITHUB_OPERATIONS = new Set([
  "PATCH /repos/{owner}/{repo}/branches/{branch}/protection",
  "PUT /repos/{owner}/{repo}/branches/{branch}/protection",
  "DELETE /repos/{owner}/{repo}/branches/{branch}/protection",
  "POST /repos/{owner}/{repo}/actions/secrets/{secret_name}",
  "PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}",
  "POST /repos/{owner}/{repo}/environments/{environment_name}",
  "POST /repos/{owner}/{repo}/deployments",
  "POST /repos/{owner}/{repo}/packages",
  "PATCH /repos/{owner}/{repo}", // repo settings
  "PATCH /orgs/{org}", // org settings
]);

export function isBlockedGithubOperation(method: string, urlPath: string): boolean {
  /* ... */
}
```

The agent in this codebase doesn't call Octokit from sandbox-bridge directly (push.ts shells out to `git`). The risk surface is: (a) `git` commands editing files in `.github/workflows` or `CODEOWNERS` — covered by the protection-constants change above; (b) any future Octokit usage from sandbox-bridge — covered by `isBlockedGithubOperation`. Wire `isBlockedGithubOperation` into the bridge's HTTP interception layer if/when one exists; document that no Octokit calls are currently made from inside the sandbox, and add a CI grep guard in `tests/sandbox-bridge/` that fails if `@octokit/` is added to `apps/sandbox-bridge/package.json` without review.

**App-permissions code reference.** New file `shared/github/app-permissions.ts`:

```typescript
// Canonical list reconciled against live GitHub App settings (see security package §6).
// Section 6.2 of cycloid-security-package.md must mirror this.
export const CYCLOID_APP_PERMISSIONS = {
  contents: "write",
  metadata: "read",
  pull_requests: "write",
  issues: "write",
  checks: "write",
  statuses: "read",
  // Deliberately NOT requested: workflows, secrets, environments, deployments, packages,
  // administration, security_events, members, plan.
} as const;
```

**Tests.** Extend `tests/test_agent/protection.test.ts:11-120`:

```typescript
it("blocks edits to .github/workflows/*", () => {
  expect(isProtectedPath(".github/workflows/ci.yml")).toBe(true);
  expect(isProtectedPath("/repo/.github/workflows/deploy.yml")).toBe(true);
});

it("blocks edits to CODEOWNERS at root and in .github/", () => {
  expect(isProtectedPath("CODEOWNERS")).toBe(true);
  expect(isProtectedPath(".github/CODEOWNERS")).toBe(true);
});

it("blocks the apply_patch + bash variants for CODEOWNERS and workflows", () => {
  expect(checkToolSafety("apply_patch", { patch: "*** Update File: .github/workflows/ci.yml\n@@" })?.kind).toBe(
    "protected_path",
  );
  expect(checkToolSafety("bash", { command: "echo bad > CODEOWNERS" })?.kind).toBe("protected_path");
});
```

**Done when.** New protection tests pass; the app-permissions constant matches the live App settings (verification step recorded in the docs plan's "verification refreshes").

---

## T8. GitHub Octokit attribution instrumentation (§4.7)

**Backs.** Package Section 6.7.

**Hook.** Modify `apps/control-plane-worker/src/github/octokit.ts:71-116` so both factories accept an optional `context` and attach a request hook:

```typescript
export interface GithubCallContext {
  actorKind: "app" | "end_user" | "provider_employee" | "agent";
  actorId?: string;
  businessId?: string;
  sessionId?: string;
  promptId?: string;
  taskId?: string;
}

function attachAttribution(client: Octokit, context: GithubCallContext, log: Logger): void {
  client.hook.before("request", (options) => {
    options.headers = { ...options.headers, "x-cycloid-actor-kind": context.actorKind };
  });
  client.hook.after("request", (response, options) => {
    log.info(
      {
        event: "github.api_call",
        method: options.method,
        url: options.url,
        status: response.status,
        rateLimit: response.headers["x-ratelimit-remaining"],
        ...context,
      },
      "github api call",
    );
  });
  client.hook.error("request", (error, options) => {
    log.warn(
      {
        event: "github.api_call_error",
        method: options.method,
        url: options.url,
        error: String(error),
        ...context,
      },
      "github api call failed",
    );
    throw error;
  });
}

export function createInstallationOctokit(env: Env, installationId: number, context: GithubCallContext): Octokit { ... }
export function createAppOctokit(env: Env, context: GithubCallContext): Octokit { ... }
```

**Call-site sweep.** The current repo has only two Octokit factory consumers, both inside `apps/control-plane-worker/src/github/octokit.ts`: `getAppSlug` and `createInstallationToken`. Most GitHub API code uses the lightweight fetch client in `apps/control-plane-worker/src/github/pr.ts` or direct `fetch` call sites, so do not chase nonexistent Octokit callers. Update the exported helpers first:

- `getAppSlug(env, context)` defaults to `{ actorKind: "app" }` where no request actor exists.
- `createInstallationToken(env, installationId, context)` receives context from callers that mint installation tokens.

Then sweep direct GitHub REST call sites (`rg -n "api.github.com|github.rest|createInstallationToken" apps/control-plane-worker/src`) and route them through either the instrumented Octokit helper or a shared GitHub fetch wrapper that logs the same `github.api_call` schema.

At each call site, derive `actorKind` from the surrounding context:

- Webhook handler → `"app"` (GitHub-initiated)
- User-session route (auth/routes.ts) → `"end_user"`
- Session-DO triggered call → `"agent"` (with `sessionId` + `promptId`)
- Admin script / impersonation context → `"provider_employee"` (with `actorId` from auth)

**Lock-in.** Add a repo-grep CI script under `scripts/` that fails if any file imports `@octokit/rest` directly except `github/octokit.ts`, and separately fails on new raw `api.github.com` fetches outside the approved GitHub client/wrapper files.

**Datadog schema.** No schema change needed — the logger already attaches `sessionId`/`promptId`/`businessId` via the correlation provider. The attribution hook adds `event: "github.api_call"` + `actor_kind` so the Datadog index can pivot.

**Tests.** `tests/test_cloudflare/github/attribution.test.ts`: stub Octokit, exercise each factory entry path, assert the after-hook logged the right `actor_kind` + correlation fields.

**Done when.** Smoke run shows three distinct `actor_kind` values in Datadog logs from a single agent + webhook + UI session.

---

## T9. Secret-injection audit + snapshot regression test (§5.4)

**Backs.** Package Section 3.4 + 5.1 row 8.

**Audit doc.** Create `docs/non-technical-docs/security/secret-injection-audit.md` enumerating the end-to-end customer-secret flow:

1. Customer writes secret to control plane via `routes/businesses.ts` integration credentials endpoint → encrypted in `business_integration_credentials` via `TOKEN_ENCRYPTION_KEY`.
2. Session start in `apps/control-plane-worker/src/session/` resolves required secrets → returns to the bridge via `/api/sessions/:id/clone-token` and equivalent paths (`apps/sandbox-bridge/src/services/git/push.ts:145-173` shows the clone-token fetch).
3. Bridge injects into the running sandbox process — for git, via the remote URL `https://x-access-token:${token}@github.com/...` at `push.ts:33`.
4. Sandbox session ends → E2B sandbox teardown (`cleanupExpiredE2BRuntimes`) destroys the FS.

**No persistent snapshot today.** Confirmed via the agent investigation. The risk is future regression.

**Regression test.** `tests/sandbox-bridge/secret-injection.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const FORBIDDEN_PATTERNS = [
  /JSON\.stringify\(process\.env\)/,
  /Object\.entries\(process\.env\)/,
  /Object\.keys\(process\.env\)/,
  /\.\.\.process\.env/,
  /readFileSync\([^)]*\.env/,
];

const SNAPSHOT_OR_PERSIST_GLOBS = [
  "apps/sandbox-bridge/src/**/persist*.ts",
  "apps/sandbox-bridge/src/**/snapshot*.ts",
  "apps/sandbox-bridge/src/**/state-export*.ts",
];

it("bridge persistence paths do not enumerate process.env", () => {
  for (const file of resolveGlobs(SNAPSHOT_OR_PERSIST_GLOBS)) {
    const src = fs.readFileSync(file, "utf8");
    for (const pat of FORBIDDEN_PATTERNS) {
      expect(src, `${file} matches ${pat}`).not.toMatch(pat);
    }
  }
});
```

**Sentinel test (runtime).** Add a second test that boots the bridge in a test harness with `CYCLOID_TEST_SENTINEL_TOKEN="gh_sentinel_canary_12345"` set, runs an end-of-session teardown, then asserts no file written by the bridge contains the sentinel (recursive `grep` in test cleanup dir).

**Done when.** Both tests run in CI; adding a `JSON.stringify(process.env)` call in any persist-pattern file fails the static test.

---

## T10. Plaintext customer-secret read-path removal (§7.3)

**Backs.** Package Section 3.4.

**Audit.** Produce `docs/non-technical-docs/security/secret-read-path-audit.md` listing every route handler that reads from `business_integration_credentials` or returns Workers Secret values. Grep starting points:

- `grep -rn "TOKEN_ENCRYPTION_KEY" apps/control-plane-worker/src/`
- `grep -rn "business_integration_credentials" apps/control-plane-worker/src/`
- `grep -rn "user_integrations" apps/control-plane-worker/src/`
- `apps/control-plane-worker/src/routes/cli-tokens.ts` — entire file.
- `apps/ui/src/api/secrets.ts` — what the UI requests (repository settings and personal secrets).

For each endpoint, classify: (a) returns plaintext (must change), (b) returns masked preview (OK), (c) writes-only (OK), (d) decrypts server-side and forwards downstream (OK if downstream is sandbox-only).

**Code changes.** For category (a), replace with masked preview helper:

```typescript
// shared/security/secret-mask.ts
export function maskSecret(raw: string): string {
  if (raw.length <= 4) return "[redacted]";
  return `…${raw.slice(-4)}`;
}
```

Any handler returning a plaintext secret returns `{ preview: maskSecret(raw), updatedAt }` instead. For the legitimate rotation path (T17), require the existing impersonation gate (`ensureActorCanImpersonate`) plus an audit-log write (T5) with `event_type: "secret.plaintext_read"`.

**Tests.** `tests/test_cloudflare/security/secret-read-paths.test.ts`: per-endpoint assertion that response body does not match any of the `SECRET_PATTERNS` regex.

**Done when.** Audit doc reviewed; every category-(a) endpoint either masked or gated; regression test enforces no secret-shape leakage in responses.

---

## T11. Extend secret redaction middleware to Datadog / Braintrust / Sentry (§7.4)

**Backs.** Package Section 3.6.

**Move + share.** Create `shared/observability/secret-redaction.ts` as the canonical implementation. Consolidate the currently separate redactors in `shared/transcript/customer-activity-projector.ts` and `apps/sandbox-bridge/src/constants/observability.ts` / `apps/sandbox-bridge/src/utils/redact.ts`. Update imports directly rather than adding compatibility re-exports.

**Datadog wrapper.** Modify `apps/control-plane-worker/src/observability/events-exporter.ts:76-120` so `postDatadogLogs` runs entries through a redactor before fetch:

```typescript
function redactEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (typeof v === "string") out[k] = redactSecrets(v);
    else if (v && typeof v === "object") out[k] = redactEntry(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}

export async function postDatadogLogs(
  env: Pick<Env, "DD_API_KEY">,
  entries: Record<string, unknown>[],
): Promise<DatadogLogsPostResult> {
  const redacted = entries.map(redactEntry);
  /* ... existing fetch with body: JSON.stringify(redacted) ... */
}
```

**Braintrust.** There are Braintrust paths in sandbox bridge, not a control-plane observability uploader. Reconcile `apps/sandbox-bridge/src/services/braintrust.ts` / `apps/sandbox-bridge/src/utils/redact.ts` onto the shared redactor. Keep sandbox-bridge truncation behavior (`BT_MAX_*`) but use the shared secret patterns before logging spans.

**Sentry.** Modify `apps/control-plane-worker/src/observability/sentry.ts:resolveSentryRuntimeOptions:44-55` to add a `beforeSend` chain that redacts:

```typescript
return {
  dsn: enabled ? env.SENTRY_DSN?.trim() : undefined,
  enabled,
  beforeSend: (event) => {
    if (!enabled) return null;
    return redactSentryEvent(event); // walks message + breadcrumbs + extra + tags through redactSecrets
  },
};
```

**Tests.** `tests/test_cloudflare/observability/redaction.test.ts`:

- For each pattern in `SECRET_PATTERNS`, feed a string containing it into `postDatadogLogs` with a `fetch` stub; assert the captured body does not contain the raw secret.
- Same for the Braintrust wrapper.
- Same for the Sentry `beforeSend`.

**Done when.** All 9+ patterns redacted across the three sinks; sentinel value leaked into a session's prompts shows up as `[redacted]` in the Datadog dashboard QA run.

---

## T12. 24h post-hoc notification on privileged-access events (§3.3)

**Backs.** Privileged-access + break-glass one-pager.

**Depends on.** T5 audit table.

**Event sources to wire.** Each writes an `audit_logs` row AND triggers notification:

| Source                                                           | Event type                            | Notification timing        |
| ---------------------------------------------------------------- | ------------------------------------- | -------------------------- |
| `routes/admin-impersonation.ts:154-165` (impersonation start)    | `privileged.impersonation_started`    | Immediate                  |
| `routes/admin-impersonation.ts:209-217` (impersonation revoke)   | `privileged.impersonation_revoked`    | Immediate                  |
| `routes/admin-approvals.ts:75-145`                               | `privileged.admin_approval`           | Immediate                  |
| T10 rotation-flow secret reads                                   | `privileged.secret_plaintext_read`    | Immediate                  |
| T3 deletion start / complete                                     | `privileged.content_deletion_*`       | Daily digest               |
| T4 export start / complete                                       | `privileged.content_export_*`         | Daily digest               |
| Business settings change (`routes/businesses.ts:172-223`)        | `privileged.business_settings_change` | Daily digest               |
| Out-of-band console access (Cloudflare/AWS/GH org/E2B/Datadog/…) | `privileged.external_console`         | Manual log via T17 runbook |

**Notification module.** `apps/control-plane-worker/src/security/privileged-notify.ts`:

```typescript
export async function notifyImmediate(env: Env, audit: AuditLogRow): Promise<void> {
  const channel = env.PRIVILEGED_ACCESS_SLACK_CHANNEL;
  const token = env.SLACK_BOT_TOKEN;
  if (!channel || !token) {
    log.warn({ auditId: audit.id }, "Privileged-access slack notification skipped: missing config");
    return;
  }
  await postMessage(
    token,
    channel,
    `:closed_lock_with_key: ${audit.event_type}: actor=${audit.actor_id} target=${audit.target_id ?? "—"} ts=${new Date(audit.created_at).toISOString()}`,
  );
}

export async function digestPrivileged(env: Env, db: D1Database, now: number): Promise<void> {
  const since = now - 24 * 60 * 60 * 1000;
  const rows = await listAuditLogs(db, {
    sinceMs: since,
    eventTypePrefix: "privileged.",
    limit: 1000 /* not yet notified */,
  });
  if (rows.length === 0) return;
  await postMessage(env.SLACK_BOT_TOKEN, env.PRIVILEGED_ACCESS_SLACK_CHANNEL, formatDigest(rows));
  await markNotified(
    db,
    rows.map((r) => r.id),
  );
}
```

`audit_logs` table gets one extra column: `notified_at INTEGER` (add to T5 migration retroactively or in `0117_audit_log_notified.sql`). The T5 service should either return the inserted `AuditLogRow` or expose `getAuditLogById`; `notifyImmediate` should not synthesize partial rows at call sites.

**Wiring.** `notifyImmediate` called inline in the four immediate-source handlers above. `digestPrivileged` scheduled at `1 7 * * mon-sat` (matches existing daily cron slot).

**Config.** Add `PRIVILEGED_ACCESS_SLACK_CHANNEL` to `Env` and to the SSM-backed variable maps in `infra/ssm.tf` and `infra/qa.tf`. `SLACK_BOT_TOKEN` already exists in SSM. Do not hard-code the channel in `wrangler.toml`.

**Tests.** `tests/test_cloudflare/security/privileged-notify.test.ts`: stub Slack `postMessage`; simulate impersonation create; assert one Slack call with the right text; for digest, seed 5 audit rows, run, assert one call containing all 5.

**Done when.** QA impersonation triggers an immediate Slack message; QA business settings change appears in next-day digest; audit-log entries get `notified_at` set.

---

## T13. Break-glass intake + audit (§3.4)

**Backs.** Privileged-access + break-glass one-pager.

**Migration.** `0118_break_glass_events.sql`:

```sql
CREATE TABLE IF NOT EXISTS break_glass_events (
  id TEXT PRIMARY KEY,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  systems_accessed_json TEXT NOT NULL,
  customer_content_accessed INTEGER NOT NULL DEFAULT 0,
  business_id TEXT,
  commands TEXT,
  remediation TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  approver_id INTEGER REFERENCES users(id),
  approved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_break_glass_actor ON break_glass_events(actor_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_break_glass_business ON break_glass_events(business_id, started_at DESC);
```

**Routes.** `apps/control-plane-worker/src/routes/admin-break-glass.ts`:

```typescript
export const breakGlassRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/api/admin/break-glass"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const gate = await ensureActorCanImpersonate(request, env, auth!); // reuse the impersonation gate
      if (!gate.ok) return gate.response;
      const payload = (await parseJsonBody(request)) || {};
      const parsed = parseBreakGlassIntake(payload);
      if (parsed instanceof Response) return parsed;
      const id = await createBreakGlassEvent(assertDatabase(env), { actorId: gate.actorId, ...parsed });
      const audit = await recordAuditLog(assertDatabase(env), {
        businessId: parsed.businessId,
        eventType: "privileged.break_glass_started",
        actorKind: "provider_employee",
        actorId: String(gate.actorId),
        metadata: { id, reason: parsed.reason },
      });
      await notifyImmediate(env, audit);
      return jsonResponse({ ok: true, id }, 201);
    },
  },
  {
    method: "PATCH",
    pattern: parsePattern("/api/admin/break-glass/:id"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const gate = await ensureActorCanImpersonate(request, env, auth!);
      if (!gate.ok) return gate.response;
      const id = match.groups!.id;
      const payload = (await parseJsonBody(request)) || {};
      const parsed = parseBreakGlassClose(payload); // requires commands + remediation
      if (parsed instanceof Response) return parsed;
      await closeBreakGlassEvent(assertDatabase(env), id, parsed);
      await recordAuditLog(assertDatabase(env), {
        eventType: "privileged.break_glass_closed",
        actorKind: "provider_employee",
        actorId: String(gate.actorId),
        metadata: { id },
      });
      return jsonResponse({ ok: true });
    },
  },
];
```

Register `breakGlassRoutes` in `apps/control-plane-worker/src/routes/table.ts` alongside `adminApprovalRoutes` and `adminImpersonationRoutes`.

**Validators.** `parseBreakGlassIntake` requires `reason ≥ 20 chars`, `systemsAccessed: string[]` non-empty, `customerContentAccessed: boolean`; optional `businessId`. `parseBreakGlassClose` requires non-empty `commands` and `remediation` strings.

**Runbook.** `docs/non-technical-docs/security/runbooks/break-glass.md` — when to file, what to capture, post-hoc approval flow, link to the BCP/DR + IR sections.

**Tests.** `tests/test_cloudflare/security/break-glass.test.ts`: full happy path + missing remediation rejection + non-admin caller rejection.

**Done when.** Filing → Slack ping; closing → row populated; trying to close without commands/remediation returns 400.

---

## T14. Enable GHAS: Dependabot + CodeQL (§10.1)

**Backs.** Secure-SDLC one-pager.

**`.github/dependabot.yml`** — net-new:

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
    groups:
      minor-patch:
        update-types: ["minor", "patch"]
    open-pull-requests-limit: 5
  - package-ecosystem: "npm"
    directory: "/apps/control-plane-worker"
    schedule: { interval: "weekly" }
    groups: { minor-patch: { update-types: ["minor", "patch"] } }
  # Repeat per package that has its own package.json:
  # apps/ui, apps/sandbox-bridge, apps/cli, apps/control-plane-worker,
  # apps/sandbox-e2b
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule: { interval: "weekly" }
  - package-ecosystem: "terraform"
    directory: "/infra"
    schedule: { interval: "weekly" }
  - package-ecosystem: "docker"
    directory: "/"
    schedule: { interval: "weekly" }
```

Group minor/patch to reduce PR noise; major versions stay separate.

**`.github/workflows/codeql.yml`** — net-new, follow `secret-scan.yml` shape:

```yaml
name: CodeQL

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
  schedule:
    - cron: "0 6 * * 1"

permissions:
  actions: read
  contents: read
  security-events: write

jobs:
  analyze:
    runs-on: ubuntu-24.04-arm
    strategy:
      matrix:
        language: [javascript-typescript]
    steps:
      - uses: actions/checkout@v6
      - uses: github/codeql-action/init@v3
        with:
          languages: ${{ matrix.language }}
      - uses: github/codeql-action/analyze@v3
```

**GHAS org settings.** Out-of-code; verify in GitHub org settings page that **Code scanning**, **Secret scanning**, and **Push protection** are enabled. Capture a screenshot for the secure-SDLC one-pager.

**Sequencing note.** T14 edits `.github/workflows/*`, so ship T14 before T7's agent write-path restriction, or have a provider employee make the workflow change outside the restricted agent path.

**Done when.** First Dependabot PR opens; CodeQL workflow has a green run on `main`; org settings screenshot is in the one-pager.

---

## T15. Vulnerability tracking + SLA workflow (§10.4)

**Backs.** Vuln-management one-pager.

**Depends on.** T14 (Dependabot alerts → issues).

**GitHub labels.** Create via `scripts/init-security-labels.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
for sev in critical:7d high:30d medium:90d low:none actively-exploited:72h; do
  name="sev:${sev%:*}"
  gh label create "$name" --description "Vuln severity ${sev%:*} — SLA ${sev#*:}" --color "$(case ${sev%:*} in critical) echo b60205;; high) echo d93f0b;; medium) echo fbca04;; low) echo 0e8a16;; actively-exploited) echo 5319e7;; esac)"
done
```

**Workflow.** `.github/workflows/security-sla.yml`:

```yaml
name: Security SLA tracker

on:
  issues:
    types: [labeled]
  schedule:
    - cron: "0 14 * * 1" # weekly Monday 14:00 UTC

permissions:
  issues: write
  pull-requests: read

jobs:
  sla-comment:
    if: github.event.label.name == 'sev:critical' || github.event.label.name == 'sev:high' || github.event.label.name == 'sev:medium' || github.event.label.name == 'sev:actively-exploited'
    runs-on: ubuntu-24.04-arm
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            const slaDays = { 'sev:critical': 7, 'sev:high': 30, 'sev:medium': 90, 'sev:actively-exploited': 3 }[context.payload.label.name];
            const due = new Date(Date.now() + slaDays * 86400000).toISOString().slice(0, 10);
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: `:hourglass: SLA: due ${due} (${slaDays}d) per the vulnerability management policy.`,
            });

  weekly-overdue:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-24.04-arm
    steps:
      - uses: actions/github-script@v7
        # Lists open sev:* issues whose SLA comment date is past today; posts to Slack via webhook env var.
```

**Dependabot → issue.** GitHub creates Dependabot alerts; this workflow doesn't auto-open issues but the team triages weekly. Document the triage process in the vuln-management one-pager.

**Done when.** Applying `sev:critical` writes the SLA comment; weekly cron Slack-pings overdue sev-tagged issues; team has triaged the first Dependabot batch.

---

## T16. PagerDuty integration + on-call escalation (§12.1)

**Backs.** Package Section 10; IR commitments.

**One-time setup.** In Datadog UI: add the PagerDuty integration; capture the resulting `service_name`. Add to `infra/variables.tf`:

```hcl
variable "datadog_pagerduty_service" {
  description = "Datadog PagerDuty service handle (e.g., '@pagerduty-cycloid-control-plane')."
  type        = string
  default     = "@pagerduty-cycloid"
}
```

**Terraform.** Modify `infra/datadog-monitors.tf` for sev-1 monitors only:

```hcl
worker_p95_latency = {
  name = "[Control Plane] Request latency elevated"
  query = "logs(\"service:cycloid-control-plane env:production @span.name:worker.fetch -@span.http.route:*/events -@span.http.route:*/ws -@span.http.status_code:101\").index(\"*\").rollup(\"pc95\", \"@span.duration_ms\").last(\"15m\") > 2500"
  warning = 1000
  critical = 2500
  message = <<-EOT
    Control-plane request latency is above the normal operating band.
    Check worker.fetch spans in Log Explorer, split by @span.http.route,
    and worker logs in Datadog.
    ${var.datadog_slack_handle} ${var.datadog_pagerduty_service}
  EOT
  tags = ["service:cycloid-control-plane", "component:control-plane", "severity:1"]
}
```

Add `${var.datadog_pagerduty_service}` only to sev-1 messages. Tag sev-1 monitors with `severity:1`; lower tiers keep `severity:2|3`. Start from existing monitor keys in `infra/datadog-monitors.tf`: `worker_p95_latency`, `prompt_failure_spike`, `prompt_trace_completeness`, `trace_queue_export_failures`, and `bridge_reconnect_spike`. Do not invent a generic `log_ingest` key; the existing log-ingest monitors are `control_plane_log_ingest_wow_growth`, `control_plane_worker_invocation_log_dod_growth`, and `datadog_logs_ingest_spike`.

**Schedule.** In PagerDuty (UI): create an `Cycloid On-Call` schedule with two named humans, weekly rotation, escalation policy with a 15-minute timeout to a backup.

**Tests.** `terraform plan` shows the diff cleanly; manual sev-1 monitor force-trigger in QA pages the on-call.

**Done when.** A deliberate sev-1 alert in QA pages PagerDuty; sev-2 alert stays Slack-only.

---

## T17. Key + token rotation tooling (§12.4)

**Backs.** Credential / GitHub-compromise one-pager.

**Script 1.** `scripts/rotate-github-app-key.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: rotate-github-app-key.sh
# Prereqs: gh CLI logged in as app owner; aws CLI; wrangler.
# Rotates GITHUB_PRIVATE_KEY in SSM + Cloudflare Workers Secrets, verifies, revokes old key.

OLD_KEY_PEM=$(aws ssm get-parameter --name /cycloid/GITHUB_PRIVATE_KEY --with-decryption --query 'Parameter.Value' --output text)
OLD_KEY_FINGERPRINT=$(openssl pkey -in <(printf "%s" "$OLD_KEY_PEM") -pubout 2>/dev/null | openssl sha256 | awk '{print $2}')
echo "Old fingerprint: $OLD_KEY_FINGERPRINT"

NEW_KEY_RESPONSE=$(gh api -X POST /app/keys --jq '.')
NEW_KEY_ID=$(echo "$NEW_KEY_RESPONSE" | jq -r '.id')
NEW_KEY_PEM=$(echo "$NEW_KEY_RESPONSE" | jq -r '.pem')

aws ssm put-parameter --name /cycloid/GITHUB_PRIVATE_KEY --value "$NEW_KEY_PEM" --type SecureString --overwrite
echo "{\"GITHUB_PRIVATE_KEY\": $(jq -Rs . <<< "$NEW_KEY_PEM")}" | npx wrangler secret bulk --name cycloid-control-plane-production

# Sanity: create a fresh installation token via the live worker
node -e "/* small script that calls a known installation, fails non-zero on failure */"

# If sanity passes, look up and revoke the previous key. Implement this helper
# against the GitHub App key-list response shape; fail closed if no exact
# fingerprint/id match is found.
OLD_KEY_ID="$(resolve_old_github_app_key_id "$OLD_KEY_FINGERPRINT")"
gh api -X DELETE "/app/keys/${OLD_KEY_ID}"
echo "Old key revoked. New key id: $NEW_KEY_ID"
```

**Script 2.** `scripts/rotate-customer-tokens.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: rotate-customer-tokens.sh <business_id>
# Forces expiration of all customer GitHub user tokens + installation tokens for a business.

BUSINESS_ID="${1:?business_id required}"
TOKEN="${ARCANIST_ADMIN_TOKEN:?admin token required}"

curl -sf -X POST -H "Authorization: Bearer ${TOKEN}" \
  "https://app.trycycloid.com/api/admin/businesses/${BUSINESS_ID}/tokens/expire" \
  | jq .
```

Backing route in `apps/control-plane-worker/src/routes/admin-token-rotation.ts`: clears user tokens + revokes installation tokens via `octokit.apps.revokeInstallationToken`, writes T5 audit log, fires T12 immediate notification.

**Runbook.** `docs/non-technical-docs/security/runbooks/credential-rotation.md` — referenced from the credential-compromise one-pager. Sections: (a) when to run, (b) GitHub App key rotation steps, (c) customer-token rotation steps, (d) customer-notification template, (e) post-rotation verification.

**Tests.** Both scripts run against the QA environment as a dry-run flag (`--dry-run` short-circuits the destructive step). QA rotation completes end-to-end without manual editing.

**Done when.** Both scripts run green in QA; the GH App key rotation completes within 5 minutes; customer-token script writes an audit-log entry and pings T12.

---

## T18. D1 time-travel + S3 backup + DR restore test (§16.1)

**Backs.** BCP/DR one-pager.

**D1 time-travel verification.** D1 has 30d point-in-time recovery by default. Add `scripts/dr-test-d1.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Picks a recent timestamp, runs `wrangler d1 time-travel restore` to a QA db,
# validates row counts against a fixture set.

DATABASE="cycloid-control-plane-qa"
TIMESTAMP="${1:-$(node -e 'console.log(new Date(Date.now() - 3600000).toISOString())')}"
RESTORE_BOOKMARK=$(npx wrangler d1 time-travel info "$DATABASE" --timestamp="$TIMESTAMP" --json | jq -r '.bookmark')
npx wrangler d1 time-travel restore "$DATABASE" --bookmark="$RESTORE_BOOKMARK"

# Validate
EXPECTED=$(cat tests/dr-fixtures/d1-row-counts.json)
ACTUAL=$(npx wrangler d1 execute "$DATABASE" --command "SELECT (SELECT count(*) FROM businesses) as businesses, (SELECT count(*) FROM session_index) as sessions" --json)
diff <(echo "$EXPECTED" | jq -S .) <(echo "$ACTUAL" | jq -S .)
```

**S3 versioning + lifecycle.** Add to `infra/`:

```hcl
# infra/s3-session.tf — new file
resource "aws_s3_bucket" "session_artifacts" {
  bucket = "cycloid-session-artifacts-${var.env}"
  lifecycle { prevent_destroy = true }
  tags = { Project = "cycloid", ManagedBy = "terraform" }
}
resource "aws_s3_bucket_versioning" "session_artifacts" {
  bucket = aws_s3_bucket.session_artifacts.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_public_access_block" "session_artifacts" {
  bucket = aws_s3_bucket.session_artifacts.id
  block_public_acls = true
  block_public_policy = true
  ignore_public_acls = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_lifecycle_configuration" "session_artifacts" {
  bucket = aws_s3_bucket.session_artifacts.id
  rule {
    id = "expire-noncurrent"
    status = "Enabled"
    noncurrent_version_expiration { noncurrent_days = 30 }
  }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "session_artifacts" {
  bucket = aws_s3_bucket.session_artifacts.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
    bucket_key_enabled = true
  }
}
```

(If the production S3 session bucket exists outside Terraform, import via `terraform import` rather than re-create; document the import in the PR description.)

**S3 restore test.** `scripts/dr-test-s3.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
BUCKET="${1:?bucket required}"
KEY="dr-test/$(date +%s).txt"
TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT
echo "dr canary $(date)" > "$TMP_FILE"
aws s3 cp "$TMP_FILE" "s3://${BUCKET}/${KEY}"
EXPECTED_MD5=$(aws s3api head-object --bucket "$BUCKET" --key "$KEY" --query ETag --output text)
aws s3api delete-object --bucket "$BUCKET" --key "$KEY"
LATEST_VERSION=$(aws s3api list-object-versions --bucket "$BUCKET" --prefix "$KEY" --query 'Versions[?IsLatest!=`true`]|[0].VersionId' --output text)
aws s3api copy-object --copy-source "${BUCKET}/${KEY}?versionId=${LATEST_VERSION}" --bucket "$BUCKET" --key "$KEY"
RESTORED_MD5=$(aws s3api head-object --bucket "$BUCKET" --key "$KEY" --query ETag --output text)
test "$EXPECTED_MD5" = "$RESTORED_MD5"
```

**Recording.** Run both scripts in QA; record RTO (script wall-clock) and RPO (the timestamp gap that's recoverable). Put numbers into the BCP/DR one-pager.

**Done when.** Both scripts run green in QA; `terraform plan` shows clean diff for the new S3 resources; RTO/RPO numbers are in the one-pager.
