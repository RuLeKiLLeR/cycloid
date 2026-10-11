export type FakeD1BatchResult = { results: Array<Record<string, unknown>>; meta?: { changes?: number } };

type FakeLinearIssueSessionRefStore = {
  linearIssueSessionRefs: Map<string, string>;
};

export abstract class BaseFakeD1Statement<DB> {
  protected boundValues: unknown[] = [];

  constructor(
    protected readonly db: DB,
    protected readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    const clone = Object.assign(Object.create(Object.getPrototypeOf(this)) as this, this);
    clone.boundValues = [...values];
    return clone;
  }

  protected isReadQuery(): boolean {
    const normalized = this.query.trim().toUpperCase();
    return normalized.startsWith("SELECT") || normalized.startsWith("WITH");
  }

  protected isSchemaQuery(): boolean {
    return (
      this.query.includes("CREATE TABLE IF NOT EXISTS") ||
      this.query.includes("CREATE INDEX IF NOT EXISTS") ||
      this.query.includes("CREATE UNIQUE INDEX IF NOT EXISTS")
    );
  }

  protected unhandled(method: "run" | "all" | "first"): never {
    throw new Error(`Unhandled ${method} query: ${this.query}`);
  }

  async run(): Promise<{ success: true }> {
    return this.unhandled("run");
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return this.unhandled("all");
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.unhandled("first");
  }

  async executeBatch(): Promise<FakeD1BatchResult> {
    if (this.isReadQuery()) {
      try {
        return await this.all<Record<string, unknown>>();
      } catch (error) {
        // Some fakes only model a given read via `first()` (it was reached through
        // the now-removed non-batch fallback path). Bridge to `{ results }` so a
        // batched single-row SELECT still resolves.
        if (error instanceof Error && error.message.startsWith("Unhandled all query")) {
          const row = await this.first<Record<string, unknown>>();
          return { results: row ? [row] : [] };
        }
        throw error;
      }
    }

    // Preserve `meta` so batch callers that read `result.meta.changes` (e.g. the
    // atomic ref+job claim in `claimLinearBootstrapJob`) see real change counts.
    const result = (await this.run()) as { meta?: { changes?: number } };
    return { results: [], meta: result.meta };
  }
}

export async function batchFakeD1Statements(
  statements: Array<{ executeBatch(): Promise<FakeD1BatchResult> }>,
): Promise<FakeD1BatchResult[]> {
  const results: FakeD1BatchResult[] = [];
  for (const statement of statements) {
    results.push(await statement.executeBatch());
  }
  return results;
}

export function runFakeLinearIssueSessionRefMutation(
  db: FakeLinearIssueSessionRefStore,
  query: string,
  boundValues: unknown[],
): { success: true; meta: { changes: number } } | null {
  if (
    query.includes("INSERT INTO linear_issue_session_refs") &&
    query.includes("ON CONFLICT(linear_issue_id) DO NOTHING")
  ) {
    const [linearIssueId, sessionId] = boundValues as [string, string];
    if (db.linearIssueSessionRefs.has(linearIssueId)) {
      return { success: true, meta: { changes: 0 } };
    }
    db.linearIssueSessionRefs.set(linearIssueId, sessionId);
    return { success: true, meta: { changes: 1 } };
  }

  if (query.includes("INSERT INTO linear_issue_session_refs")) {
    const [linearIssueId, sessionId] = boundValues as [string, string];
    db.linearIssueSessionRefs.set(linearIssueId, sessionId);
    return { success: true, meta: { changes: 1 } };
  }

  if (query.includes("DELETE FROM linear_issue_session_refs WHERE linear_issue_id = ? AND session_id = ?")) {
    const [linearIssueId, sessionId] = boundValues as [string, string];
    if (db.linearIssueSessionRefs.get(linearIssueId) !== sessionId) {
      return { success: true, meta: { changes: 0 } };
    }
    db.linearIssueSessionRefs.delete(linearIssueId);
    return { success: true, meta: { changes: 1 } };
  }

  return null;
}

// --- Linear webhook bootstrap jobs (ARC-1051) ---

export type FakeLinearBootstrapJobRow = {
  linear_issue_id: string;
  session_id: string;
  business_id: string;
  actor_user_id: string;
  repo_owner: string;
  repo_name: string;
  installation_id: number;
  model: string | null;
  prompt_template: string;
  issue_snapshot: string;
  uploaded_images_json: string | null;
  phase: string;
  terminal_outcome: string | null;
  failure_reason: string | null;
  linear_attachment_external_id: string | null;
  attempt_count: number;
  retry_after_ms: number;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
};

type FakeLinearBootstrapJobStore = FakeLinearIssueSessionRefStore & {
  linearWebhookBootstrapJobs: Map<string, FakeLinearBootstrapJobRow>;
};

/**
 * In-memory model of the `linear_webhook_bootstrap_jobs` mutations the Linear
 * webhook handler and sweep issue. Mirrors the real DAO semantics: the claim
 * insert is gated on the ref having been won, phase advances are
 * phase-conditional, and the delete is scoped to both keys.
 */
export function runFakeLinearBootstrapJobMutation(
  db: FakeLinearBootstrapJobStore,
  query: string,
  boundValues: unknown[],
): { success: true; meta: { changes: number } } | null {
  if (!query.includes("linear_webhook_bootstrap_jobs")) return null;

  if (query.includes("INSERT INTO linear_webhook_bootstrap_jobs")) {
    // SELECT ... WHERE EXISTS (ref matches) ON CONFLICT DO NOTHING. The last two
    // binds are the EXISTS (linear_issue_id, session_id) check.
    const v = boundValues;
    const existsIssueId = v[v.length - 2] as string;
    const existsSessionId = v[v.length - 1] as string;
    const [
      linearIssueId,
      sessionId,
      businessId,
      actorUserId,
      repoOwner,
      repoName,
      installationId,
      model,
      promptTemplate,
      issueSnapshot,
      uploadedImagesJson,
      retryAfterMs,
      createdAt,
      updatedAt,
    ] = v as [
      string,
      string,
      string,
      string,
      string,
      string,
      number,
      string | null,
      string,
      string,
      string | null,
      number,
      number,
      number,
    ];
    const refWon = db.linearIssueSessionRefs.get(existsIssueId) === existsSessionId;
    if (!refWon || db.linearWebhookBootstrapJobs.has(linearIssueId)) {
      return { success: true, meta: { changes: 0 } };
    }
    db.linearWebhookBootstrapJobs.set(linearIssueId, {
      linear_issue_id: linearIssueId,
      session_id: sessionId,
      business_id: businessId,
      actor_user_id: actorUserId,
      repo_owner: repoOwner,
      repo_name: repoName,
      installation_id: installationId,
      model: model ?? null,
      prompt_template: promptTemplate,
      issue_snapshot: issueSnapshot,
      uploaded_images_json: uploadedImagesJson ?? null,
      phase: "linear_issue_claimed",
      terminal_outcome: null,
      failure_reason: null,
      linear_attachment_external_id: null,
      attempt_count: 0,
      retry_after_ms: retryAfterMs,
      lease_expires_at: null,
      created_at: createdAt,
      updated_at: updatedAt,
    });
    return { success: true, meta: { changes: 1 } };
  }

  if (query.includes("DELETE FROM linear_webhook_bootstrap_jobs")) {
    if (query.includes("session_id = ?") && query.includes("linear_issue_id = ?")) {
      const [linearIssueId, sessionId] = boundValues as [string, string];
      const row = db.linearWebhookBootstrapJobs.get(linearIssueId);
      if (!row || row.session_id !== sessionId) return { success: true, meta: { changes: 0 } };
      db.linearWebhookBootstrapJobs.delete(linearIssueId);
      return { success: true, meta: { changes: 1 } };
    }
    // Session-scoped cleanup (deleteOrphanedWebhookRefs).
    const [sessionId] = boundValues as [string];
    let changes = 0;
    for (const [issueId, row] of db.linearWebhookBootstrapJobs) {
      if (row.session_id === sessionId) {
        db.linearWebhookBootstrapJobs.delete(issueId);
        changes += 1;
      }
    }
    return { success: true, meta: { changes } };
  }

  if (query.includes("UPDATE linear_webhook_bootstrap_jobs")) {
    const v = boundValues;
    // Lease claim.
    if (query.includes("SET lease_expires_at = ?, updated_at = ?")) {
      const [leaseExpiresAt, now, linearIssueId, dueBy] = v as [number, number, string, number];
      const row = db.linearWebhookBootstrapJobs.get(linearIssueId);
      if (!row || row.terminal_outcome !== null) return { success: true, meta: { changes: 0 } };
      if (!(row.lease_expires_at === null || row.lease_expires_at <= dueBy)) {
        return { success: true, meta: { changes: 0 } };
      }
      row.lease_expires_at = leaseExpiresAt;
      row.updated_at = now;
      return { success: true, meta: { changes: 1 } };
    }
    // Reschedule.
    if (query.includes("attempt_count = attempt_count + 1")) {
      const [retryAfterMs, failureReason, now, linearIssueId] = v as [number, string | null, number, string];
      const row = db.linearWebhookBootstrapJobs.get(linearIssueId);
      if (!row || row.terminal_outcome !== null) return { success: true, meta: { changes: 0 } };
      row.retry_after_ms = retryAfterMs;
      row.lease_expires_at = null;
      row.failure_reason = failureReason;
      row.attempt_count += 1;
      row.updated_at = now;
      return { success: true, meta: { changes: 1 } };
    }
    // Terminal.
    if (query.includes("SET terminal_outcome = ?")) {
      const [outcome, failureReason, now, linearIssueId] = v as [string, string | null, number, string];
      const row = db.linearWebhookBootstrapJobs.get(linearIssueId);
      if (!row || row.terminal_outcome !== null) return { success: true, meta: { changes: 0 } };
      row.terminal_outcome = outcome;
      row.failure_reason = failureReason;
      row.lease_expires_at = null;
      row.updated_at = now;
      return { success: true, meta: { changes: 1 } };
    }
    // Phase advance (phase-conditional). Last two binds: linear_issue_id, fromPhase.
    const fromPhase = v[v.length - 1] as string;
    const linearIssueId = v[v.length - 2] as string;
    const toPhase = v[0] as string;
    const now = v[1] as number;
    const row = db.linearWebhookBootstrapJobs.get(linearIssueId);
    if (!row || row.terminal_outcome !== null || row.phase !== fromPhase) {
      return { success: true, meta: { changes: 0 } };
    }
    row.phase = toPhase;
    row.updated_at = now;
    let idx = 2;
    if (query.includes("installation_id = ?")) row.installation_id = v[idx++] as number;
    if (query.includes("linear_attachment_external_id = ?")) {
      row.linear_attachment_external_id = (v[idx++] as string | null) ?? null;
    }
    return { success: true, meta: { changes: 1 } };
  }

  return null;
}

/**
 * Read model for the bootstrap-job table. Returns `{ rows }` when the query is a
 * bootstrap-job read (so the caller can serve `first`/`all`), or null otherwise.
 */
export function readFakeLinearBootstrapJob(
  db: FakeLinearBootstrapJobStore,
  query: string,
  boundValues: unknown[],
): { rows: FakeLinearBootstrapJobRow[] } | null {
  if (!query.includes("FROM linear_webhook_bootstrap_jobs")) return null;

  if (query.includes("WHERE linear_issue_id = ?")) {
    const [linearIssueId] = boundValues as [string];
    const row = db.linearWebhookBootstrapJobs.get(linearIssueId);
    return { rows: row ? [{ ...row }] : [] };
  }

  // listDueLinearBootstrapJobs: terminal_outcome IS NULL AND retry_after_ms <= ?
  // AND (lease_expires_at IS NULL OR lease_expires_at <= ?) ORDER BY updated_at ASC LIMIT ?
  if (query.includes("terminal_outcome IS NULL")) {
    const [nowDue, nowLease, limit] = boundValues as [number, number, number];
    const rows = [...db.linearWebhookBootstrapJobs.values()]
      .filter(
        (r) =>
          r.terminal_outcome === null &&
          r.retry_after_ms <= nowDue &&
          (r.lease_expires_at === null || r.lease_expires_at <= nowLease),
      )
      .sort((a, b) => a.updated_at - b.updated_at)
      .slice(0, limit)
      .map((r) => ({ ...r }));
    return { rows };
  }

  return { rows: [] };
}
