import { createDurableNamespace, type DurableNamespace, FakeKV, type WorkerModule } from "./worker-harness";

const DEFAULT_WORKER_ENV: Record<string, unknown> = {
  WORKER_ENV: "test",
  AUTH_SMOKE_TOKEN: "smoke-token",
  ARCANIST_ADMIN_TOKEN: "admin-secret",
  CI_AUTOMATION_TOKEN: "ci-automation-secret",
  SANDBOX_CALLBACK_SECRET: "sandbox-callback-secret",
  GITHUB_WEBHOOK_SECRET: "gh-webhook-secret",
  SLACK_SIGNING_SECRET: "slack-webhook-secret",
  LINEAR_WEBHOOK_SECRET: "linear-webhook-secret",
  GITHUB_APP_ID: "123",
  GITHUB_PRIVATE_KEY: "test-private-key",
  TOKEN_ENCRYPTION_KEY: "test-encryption-key-32bytes!!",
};

export type WorkerEnvBinding<T = unknown> = {
  envKey: string;
  value: T;
};

export function createKvBinding(envKey: string): WorkerEnvBinding<FakeKV> {
  return { envKey, value: new FakeKV() };
}

export function seedGithubInstallation(
  db: { githubInstallations: Map<string, Record<string, unknown>> },
  ownerLogin: string,
  installationId = 1,
): void {
  db.githubInstallations.set(ownerLogin, {
    installation_id: installationId,
    owner_login: ownerLogin,
    owner_id: installationId,
    owner_type: "Organization",
    repository_selection: "all",
    permissions_json: JSON.stringify({
      checks: "read",
      contents: "write",
      metadata: "read",
      pull_requests: "write",
      statuses: "read",
    }),
    events_json: JSON.stringify([
      "check_run",
      "issue_comment",
      "pull_request",
      "pull_request_review",
      "pull_request_review_comment",
      "status",
    ]),
    created_at: Date.now(),
    suspended_at: null,
  });
}

export function createWorkerTestEnv<DB>(
  workerModule: WorkerModule,
  options: {
    db: DB;
    bindings?: Record<string, WorkerEnvBinding>;
    envOverrides?: Record<string, unknown>;
    sqlStorage?: boolean;
  },
): {
  env: Record<string, unknown>;
  db: DB;
  sessionNs: DurableNamespace;
  bindings: Record<string, unknown>;
} {
  const env: Record<string, unknown> = {
    DB: options.db,
    ...DEFAULT_WORKER_ENV,
    ...options.envOverrides,
  };

  const bindings: Record<string, unknown> = {};
  for (const [alias, binding] of Object.entries(options.bindings ?? {})) {
    bindings[alias] = binding.value;
    env[binding.envKey] = binding.value;
  }

  const sessionNs = createDurableNamespace(workerModule.SessionDO, env, {
    sqlStorage: options.sqlStorage ?? false,
  });
  env.SESSION = sessionNs;

  return { env, db: options.db, sessionNs, bindings };
}
