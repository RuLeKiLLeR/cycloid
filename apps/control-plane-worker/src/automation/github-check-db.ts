export type GithubCheckAutomationRule = {
  id: string;
  businessId: string;
  configuredByUserId: string;
  repoOwner: string;
  repoName: string;
  installationId: number;
  checkName: string | null;
  modelId: string | null;
  promptTemplate: string;
  name: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

type RuleRow = {
  id: string;
  business_id: string;
  configured_by_user_id: string;
  repo_owner: string;
  repo_name: string;
  installation_id: number;
  check_name: string | null;
  model_id: string | null;
  prompt_template: string;
  name: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
};

function toRule(row: RuleRow): GithubCheckAutomationRule {
  return {
    id: row.id,
    businessId: row.business_id,
    configuredByUserId: row.configured_by_user_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    installationId: row.installation_id,
    checkName: row.check_name,
    modelId: row.model_id,
    promptTemplate: row.prompt_template,
    name: row.name,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const RULE_COLUMNS =
  "id,business_id,configured_by_user_id,repo_owner,repo_name,installation_id,check_name,model_id,prompt_template,name,enabled,created_at,updated_at";

export async function insertGithubCheckRule(db: D1Database, rule: GithubCheckAutomationRule): Promise<void> {
  await db
    .prepare(
      `INSERT INTO github_check_automation_rules
         (id,business_id,configured_by_user_id,repo_owner,repo_name,installation_id,check_name,model_id,prompt_template,name,enabled,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET id=excluded.id`,
    )
    .bind(
      rule.id,
      rule.businessId,
      rule.configuredByUserId,
      rule.repoOwner,
      rule.repoName,
      rule.installationId,
      rule.checkName,
      rule.modelId,
      rule.promptTemplate,
      rule.name,
      rule.enabled ? 1 : 0,
      rule.createdAt,
      rule.updatedAt,
    )
    .run();
}
export async function listGithubCheckRules(db: D1Database, businessId: string): Promise<GithubCheckAutomationRule[]> {
  const result = await db
    .prepare(
      `SELECT ${RULE_COLUMNS} FROM github_check_automation_rules WHERE business_id=? AND deleted_at IS NULL ORDER BY created_at DESC`,
    )
    .bind(businessId)
    .all<RuleRow>();
  return (result.results ?? []).map(toRule);
}
export async function getGithubCheckRule(
  db: D1Database,
  businessId: string,
  id: string,
): Promise<GithubCheckAutomationRule | null> {
  const row = await db
    .prepare(
      `SELECT ${RULE_COLUMNS} FROM github_check_automation_rules WHERE business_id=? AND id=? AND deleted_at IS NULL`,
    )
    .bind(businessId, id)
    .first<RuleRow>();
  return row ? toRule(row) : null;
}
export async function updateGithubCheckRule(
  db: D1Database,
  input: {
    businessId: string;
    id: string;
    name: string | null;
    promptTemplate: string;
    checkName: string | null;
    modelId: string | null;
    enabled: boolean;
    updatedAt: number;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE github_check_automation_rules SET name=?,prompt_template=?,check_name=?,model_id=?,enabled=?,updated_at=? WHERE business_id=? AND id=? AND deleted_at IS NULL",
    )
    .bind(
      input.name,
      input.promptTemplate,
      input.checkName,
      input.modelId,
      input.enabled ? 1 : 0,
      input.updatedAt,
      input.businessId,
      input.id,
    )
    .run();
  return result.meta.changes === 1;
}
export async function softDeleteGithubCheckRule(
  db: D1Database,
  businessId: string,
  id: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE github_check_automation_rules SET enabled=0,deleted_at=?,updated_at=? WHERE business_id=? AND id=? AND deleted_at IS NULL",
    )
    .bind(now, now, businessId, id)
    .run();
  return result.meta.changes === 1;
}
export async function listMatchingGithubCheckRules(
  db: D1Database,
  input: { repoOwner: string; repoName: string; checkName: string },
): Promise<GithubCheckAutomationRule[]> {
  const result = await db
    .prepare(
      `SELECT ${RULE_COLUMNS} FROM github_check_automation_rules WHERE lower(repo_owner)=lower(?) AND lower(repo_name)=lower(?) AND enabled=1 AND deleted_at IS NULL AND (check_name IS NULL OR check_name=?)`,
    )
    .bind(input.repoOwner, input.repoName, input.checkName)
    .all<RuleRow>();
  return (result.results ?? []).map(toRule);
}
export async function claimGithubCheckJob(
  db: D1Database,
  input: {
    rule: GithubCheckAutomationRule;
    checkRunId: number;
    prNumber: number;
    headSha: string;
    checkName: string;
    now: number;
  },
): Promise<boolean> {
  const id = crypto.randomUUID();
  const result = await db
    .prepare(
      "INSERT OR IGNORE INTO github_check_automation_jobs (id,job_key,rule_id,business_id,check_run_id,pr_number,head_sha,check_name,event_snapshot_json,phase,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'queued',?,?,?)",
    )
    .bind(
      id,
      `${input.rule.id}:${input.prNumber}:${input.headSha}`,
      input.rule.id,
      input.rule.businessId,
      input.checkRunId,
      input.prNumber,
      input.headSha,
      input.checkName,
      JSON.stringify({
        checkRunId: input.checkRunId,
        prNumber: input.prNumber,
        headSha: input.headSha,
        checkName: input.checkName,
      }),
      input.now,
      input.now,
      input.now,
    )
    .run();
  return result.meta.changes === 1;
}

export type GithubCheckAutomationJob = {
  id: string;
  ruleId: string;
  businessId: string;
  prNumber: number;
  headSha: string;
  checkName: string;
  phase: string;
  sessionId: string | null;
  attemptCount: number;
};
type JobRow = {
  id: string;
  rule_id: string;
  business_id: string;
  pr_number: number;
  head_sha: string;
  check_name: string;
  phase: string;
  session_id: string | null;
  attempt_count: number;
};
export async function listDueGithubCheckJobs(
  db: D1Database,
  now: number,
  limit: number,
): Promise<GithubCheckAutomationJob[]> {
  const r = await db
    .prepare(
      "SELECT id,rule_id,business_id,pr_number,head_sha,check_name,phase,session_id,attempt_count FROM github_check_automation_jobs WHERE phase IN ('queued','claimed','session_projected','prompt_enqueued') AND next_attempt_at<=? AND (lease_expires_at IS NULL OR lease_expires_at<=?) ORDER BY created_at LIMIT ?",
    )
    .bind(now, now, limit)
    .all<JobRow>();
  return (r.results ?? []).map((x) => ({
    id: x.id,
    ruleId: x.rule_id,
    businessId: x.business_id,
    prNumber: x.pr_number,
    headSha: x.head_sha,
    checkName: x.check_name,
    phase: x.phase,
    sessionId: x.session_id,
    attemptCount: x.attempt_count,
  }));
}
export async function leaseGithubCheckJob(db: D1Database, id: string, now: number): Promise<string | null> {
  const leaseOwner = crypto.randomUUID();
  const r = await db
    .prepare(
      "UPDATE github_check_automation_jobs SET phase='claimed',attempt_count=attempt_count+1,lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=? AND phase IN ('queued','claimed','session_projected','prompt_enqueued') AND (lease_expires_at IS NULL OR lease_expires_at<=?)",
    )
    .bind(leaseOwner, now + 300000, now, id, now)
    .run();
  return r.meta.changes === 1 ? leaseOwner : null;
}
export async function updateGithubCheckJob(
  db: D1Database,
  input: {
    id: string;
    phase: "session_projected" | "prompt_enqueued" | "succeeded" | "failed" | "skipped";
    sessionId: string | null;
    reason: string | null;
    now: number;
    leaseOwner: string;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE github_check_automation_jobs SET phase=?,session_id=COALESCE(?,session_id),admission_outcome=CASE WHEN ? IN ('succeeded','failed','skipped') THEN ? ELSE admission_outcome END,admission_reason=?,completed_at=CASE WHEN ? IN ('succeeded','failed','skipped') THEN ? ELSE completed_at END,lease_owner=CASE WHEN ? IN ('succeeded','failed','skipped') THEN NULL ELSE lease_owner END,lease_expires_at=CASE WHEN ? IN ('succeeded','failed','skipped') THEN NULL ELSE lease_expires_at END,updated_at=? WHERE id=? AND lease_owner=? AND phase IN ('queued','claimed','session_projected','prompt_enqueued')",
    )
    .bind(
      input.phase,
      input.sessionId,
      input.phase,
      input.phase,
      input.reason,
      input.phase,
      input.now,
      input.phase,
      input.phase,
      input.now,
      input.id,
      input.leaseOwner,
    )
    .run();
  return result.meta.changes === 1;
}
