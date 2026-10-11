#!/usr/bin/env tsx

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const CONTROL_PLANE_DIR = "apps/control-plane-worker";
const DEFAULT_TIMEOUT_MS = 7 * 60_000;
const POLL_MS = 15_000;
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIM = 1536;

type D1Result<T> = Array<{ results?: T[]; success?: boolean }>;

type SmokeStatus = {
  id: string;
  vector_state: string;
  sync_attempts: number;
  last_sync_at_ms: number | null;
  last_error: string | null;
  work_status: string | null;
  completed_at_ms: number | null;
  work_error: string | null;
};

function main(): void {
  const env = readArg("--env") ?? "qa";
  const timeoutMs = Number(readArg("--timeout-ms") ?? DEFAULT_TIMEOUT_MS);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const businessId = `codex-smoke-worker-business-${suffix}`;
  const scopeId = `codex-smoke-scope-${suffix}`;
  const docId = `codex-smoke-semantic-doc-${suffix}`;
  const workId = `codex-smoke-vector-work-${suffix}`;
  const vectorId = `codex-smoke-worker-vector-${suffix}`;
  const sourceId = `codex-smoke-repo-memory-${suffix}`;
  const nowMs = Date.now();

  let seeded = false;
  try {
    runWrangler([
      "d1",
      "execute",
      "DB",
      "--env",
      env,
      "--remote",
      "--json",
      "--command",
      seedSql({ nowMs, businessId, scopeId, docId, workId, vectorId, sourceId }),
    ]);
    seeded = true;

    const deadline = Date.now() + timeoutMs;
    let latest: SmokeStatus | null = null;
    while (Date.now() < deadline) {
      latest = readStatus(env, docId, workId);
      console.log(
        JSON.stringify({
          vectorState: latest?.vector_state ?? null,
          syncAttempts: latest?.sync_attempts ?? null,
          lastError: latest?.last_error ?? null,
          workStatus: latest?.work_status ?? null,
        }),
      );
      if (latest?.vector_state === "synced") break;
      if (latest?.vector_state === "failed") {
        throw new Error(formatSyncFailure(latest.last_error));
      }
      sleep(POLL_MS);
    }

    if (latest?.vector_state !== "synced") {
      throw new Error(`vector_sync_timeout:${JSON.stringify(latest)}`);
    }

    const queryOutput = runWrangler([
      "vectorize",
      "query",
      `cycloid-memory-context-${env}`,
      "--vector-id",
      vectorId,
      "--top-k",
      "3",
      "--namespace",
      businessId,
      "--return-metadata",
      "indexed",
      "--filter",
      JSON.stringify({
        tenant_key: metadataKey(businessId),
        repo_key: metadataKey("trycycloid/cycloid"),
        scope_key: metadataKey(scopeId),
        source_kind: "repo_memory",
        active: true,
      }),
    ]);
    if (!queryOutput.includes(vectorId)) {
      throw new Error(`vector_query_missing_match:${queryOutput}`);
    }

    console.log(
      JSON.stringify({
        ok: true,
        env,
        docId,
        workId,
        vectorId,
        lastSyncAtMs: latest.last_sync_at_ms,
      }),
      null,
      2,
    );
  } finally {
    if (seeded) {
      runWranglerAllowFailure(["vectorize", "delete-vectors", `cycloid-memory-context-${env}`, "--ids", vectorId]);
      runWranglerAllowFailure([
        "d1",
        "execute",
        "DB",
        "--env",
        env,
        "--remote",
        "--json",
        "--command",
        `DELETE FROM memory_work_items WHERE id = '${escapeSql(workId)}'; DELETE FROM memory_semantic_documents WHERE id = '${escapeSql(docId)}';`,
      ]);
    }
  }
}

function seedSql(input: {
  nowMs: number;
  businessId: string;
  scopeId: string;
  docId: string;
  workId: string;
  vectorId: string;
  sourceId: string;
}): string {
  const text = `Codex QA Vectorize worker smoke memory context phrase ${input.docId}.`;
  return `
INSERT INTO memory_semantic_documents (
  id, source_kind, source_id, business_id, repo_owner, repo_name, scope_type, scope_id,
  text, content_hash, embedding_model, embedding_dim, vector_namespace, vector_id,
  vector_state, sync_attempts, last_sync_at_ms, last_error, updated_at_ms, deleted_at_ms
) VALUES (
  '${escapeSql(input.docId)}', 'repo_memory', '${escapeSql(input.sourceId)}', '${escapeSql(input.businessId)}',
  'trycycloid', 'cycloid', 'repo', '${escapeSql(input.scopeId)}',
  '${escapeSql(text)}', '${sha256(text)}', '${EMBEDDING_MODEL}', ${EMBEDDING_DIM},
  '${escapeSql(input.businessId)}', '${escapeSql(input.vectorId)}',
  'pending', 0, NULL, NULL, ${input.nowMs}, NULL
);
INSERT INTO memory_work_items (
  id, business_id, work_type, target_kind, target_id, status, priority, attempts,
  available_at_ms, locked_until_ms, last_error, payload_json, created_at_ms, updated_at_ms, completed_at_ms
) VALUES (
  '${escapeSql(input.workId)}', '${escapeSql(input.businessId)}', 'vector_sync', 'semantic_document',
  '${escapeSql(input.docId)}', 'pending', 100, 0, ${input.nowMs}, NULL, NULL, '{}', ${input.nowMs}, ${input.nowMs}, NULL
);`;
}

function readStatus(env: string, docId: string, workId: string): SmokeStatus | null {
  const output = runWrangler([
    "d1",
    "execute",
    "DB",
    "--env",
    env,
    "--remote",
    "--json",
    "--command",
    `SELECT d.id, d.vector_state, d.sync_attempts, d.last_sync_at_ms, d.last_error, w.status AS work_status, w.completed_at_ms, w.last_error AS work_error
     FROM memory_semantic_documents d
     LEFT JOIN memory_work_items w ON w.id = '${escapeSql(workId)}'
     WHERE d.id = '${escapeSql(docId)}';`,
  ]);
  const parsed = JSON.parse(output) as D1Result<SmokeStatus>;
  return parsed[0]?.results?.[0] ?? null;
}

function runWrangler(args: string[]): string {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: CONTROL_PLANE_DIR,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`wrangler_failed:${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function formatSyncFailure(lastError: string | null): string {
  if (lastError?.includes("openai_embedding_failed:403:model_not_found")) {
    return [
      `vector_sync_failed:${lastError}`,
      "QA worker reached the real embedding provider, but the QA OpenAI project does not have access to text-embedding-3-small.",
      "Rotate /cycloid/qa/ARCANIST_OPENAI_API_KEY to a QA-scoped key whose project can use text-embedding-3-small, then rerun this smoke.",
    ].join("\n");
  }
  if (lastError?.startsWith("openai_embedding_failed:403")) {
    return [
      `vector_sync_failed:${lastError}`,
      "QA worker reached the real embedding provider, but its ARCANIST_OPENAI_API_KEY was rejected by OpenAI.",
      "Run the normal deploy-control-plane-qa workflow to sync /cycloid/qa secrets from SSM, or rotate the QA-scoped key in SSM before rerunning this smoke.",
    ].join("\n");
  }
  return `vector_sync_failed:${lastError ?? "unknown"}`;
}

function runWranglerAllowFailure(args: string[]): void {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: CONTROL_PLANE_DIR,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.warn(`cleanup_failed:${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
}

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function metadataKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

main();
