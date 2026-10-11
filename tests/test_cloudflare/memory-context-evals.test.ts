import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { handleMemoryContextQueryForSession } from "../../apps/control-plane-worker/src/company-memory/context-query";
import type { MemoryContextSelector } from "../../apps/control-plane-worker/src/company-memory/context-selector";
import type { MemoryVectorIndex } from "../../apps/control-plane-worker/src/company-memory/vector-index";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { createMemoryContextD1 } from "./helpers/memory-context-db";

function insertRepoMemory(
  db: Database.Database,
  params: {
    memoryId: string;
    status?: "active" | "superseded";
    contextHint: string;
    content: string;
    appliesTo?: string[];
  },
): void {
  db.prepare(
    `INSERT INTO repo_memories
     (id, repo_owner, repo_name, memory_id, status, memory_type, action_type, level,
      primitive, confidence, authority, enforcement, context_hint, content,
      applies_to_json, source_pr_url, source_pr_number, source_session_ids_json,
      memory_json, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `row-${params.memoryId}`,
    "trycycloid",
    "cycloid",
    params.memoryId,
    params.status ?? "active",
    "action",
    "procedure",
    "tactical",
    "procedure",
    "high",
    "reviewed",
    "warn",
    params.contextHint,
    params.content,
    JSON.stringify(params.appliesTo ?? []),
    null,
    null,
    "[]",
    "{}",
    1_000,
    1_000,
  );
}

function insertSemanticDocument(
  db: Database.Database,
  params: { id: string; sourceId: string; vectorId: string; text: string },
): void {
  db.prepare(
    `INSERT INTO memory_semantic_documents
     (id, source_kind, source_id, business_id, repo_owner, repo_name, scope_type, scope_id,
      text, content_hash, embedding_model, embedding_dim, vector_namespace, vector_id,
      vector_state, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.id,
    "company_fact",
    params.sourceId,
    "biz-1",
    "trycycloid",
    "cycloid",
    "repo",
    "scope-repo",
    params.text,
    `hash-${params.id}`,
    "text-embedding-3-small",
    1536,
    "biz-1",
    params.vectorId,
    "synced",
    1_000,
  );
}

function insertRepoScope(db: Database.Database): void {
  db.prepare(
    `INSERT INTO memory_scopes
     (id, business_id, scope_type, scope_key, repo_owner, repo_name, metadata_json, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("scope-repo", "biz-1", "repo", "trycycloid/cycloid", "trycycloid", "cycloid", "{}", 1_000, 1_000);
}

function evalSelector(selectIds: string[]): MemoryContextSelector {
  return {
    async select(input) {
      const selected = input.candidates
        .filter((candidate) => selectIds.includes(candidate.id))
        .map((candidate) => ({
          memoryId: candidate.id,
          score: 0.95,
          selectionRationale: "materially changes this exact task",
          expectedEffect: "apply the stored constraint",
          evidence: {
            matchedTaskAnchor: input.denoisedTask.slice(0, 80),
            matchedMemoryAnchor: candidate.content.slice(0, 80),
            retrievalLanes: candidate.lanes,
            sourceUri: candidate.provenance[0]?.excerpt ?? null,
          },
        }));
      return {
        status: selected.length ? "selected" : "empty",
        selected,
        rejected: input.candidates
          .filter((candidate) => !selectIds.includes(candidate.id))
          .map((candidate) => ({
            memoryId: candidate.id,
            rejectReason: "weak_match",
            rationale: "topical overlap without task-changing applicability",
          })),
        emptyReason: selected.length ? null : "no applicable memory",
        selectorConfidence: 0.9,
      };
    },
  };
}

describe("memory context eval regressions", () => {
  let sqlite: Database.Database;
  let d1: D1Database;

  beforeEach(() => {
    ({ sqlite, d1 } = createMemoryContextD1());
  });

  it("replays the Linear-webhook historical downvote as an abstention despite semantic near misses", async () => {
    insertRepoScope(sqlite);
    const slackTokenMemory = "mf_b77d63ceb513cf537f1125e1c133bdbaea9068c46db1e98617496579c913c838";
    const slackCompletionMemory = "mf_5ed511772dcf55102973b7644d09a7814c9e6496514360d5e90e652dc3385c4c";
    insertSemanticDocument(sqlite, {
      id: "semantic-slack-token-routing",
      sourceId: slackTokenMemory,
      vectorId: "vec-slack-token-routing",
      text: "Slack-originated sessions need installed-workspace token routing and concise delivery summaries.",
    });
    insertSemanticDocument(sqlite, {
      id: "semantic-slack-completion-posting",
      sourceId: slackCompletionMemory,
      vectorId: "vec-slack-completion-posting",
      text: "Completion notifications should choose Slack channel and fallback text from session delivery state.",
    });
    const vectorIndex: MemoryVectorIndex = {
      async query() {
        return [
          { vectorId: "vec-slack-token-routing", score: 0.92 },
          { vectorId: "vec-slack-completion-posting", score: 0.89 },
        ];
      },
    };

    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "all",
          intent: "Find why Linear webhook triggers were dropped and fix the Linear webhook path.",
          currentTaskSummary:
            "Investigate dropped Linear webhook triggers; Slack session delivery memories should not be credited.",
          queryVector: [0.1, 0.2],
          maxMemories: 5,
        }),
      }),
      { WORKER_ENV: "production" } as Env,
      d1,
      "e73b8b4a-7b02-455e-a83b-7002a159f21a",
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        callbackContext: null,
      },
      { selector: evalSelector([]), vectorIndex, nowMs: 2_000 },
    );

    const body = (await response.json()) as {
      memories: Array<{ id: string }>;
      retrievalTrace: {
        vectorAvailable: boolean;
        laneCounts: Record<string, number>;
        selector: { rejected: Array<{ memoryId: string; rejectReason: string }> };
      };
    };
    expect(response.status).toBe(200);
    expect(body.memories).toEqual([]);
    expect(body.retrievalTrace.vectorAvailable).toBe(true);
    expect(body.retrievalTrace.laneCounts.vector).toBe(2);
    expect(body.retrievalTrace.selector.rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ memoryId: `company_fact:${slackTokenMemory}`, rejectReason: "weak_match" }),
        expect.objectContaining({ memoryId: `company_fact:${slackCompletionMemory}`, rejectReason: "weak_match" }),
      ]),
    );
    expect(sqlite.prepare("SELECT selected_ids_json AS selectedIdsJson FROM memory_context_queries").get()).toEqual({
      selectedIdsJson: "[]",
    });
  });

  it("keeps a true positive for explicit prompt-queue recall while rejecting same-domain distractors", async () => {
    insertRepoMemory(sqlite, {
      memoryId: "bridge-post-execution-rendering",
      contextHint: "bridge terminal transcript prompt rendering",
      content: "Sandbox bridge post-execution rendering must avoid duplicating final prompt transcript terminal rows.",
      appliesTo: ["apps/sandbox-bridge/**"],
    });
    insertRepoMemory(sqlite, {
      memoryId: "ui-transcript-reducer-idempotency",
      contextHint: "UI terminal transcript prompt reducer",
      content: "UI transcript reducers must be idempotent for duplicate prompt terminal status updates.",
      appliesTo: ["apps/ui/**"],
    });

    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "repo",
          intent: "Modify session prompt queue retry handling.",
          files: ["apps/control-plane-worker/src/session/prompt-queue.ts"],
          maxMemories: 3,
          memories: [
            {
              id: "prompt-queue-terminal-idempotency",
              type: "action",
              content:
                "Prompt queue terminal side effects must be idempotent because duplicate terminal events arrive.",
              context_hint: "prompt queue terminal idempotency",
              confidence: "high",
              enforcement: "warn",
              applies_to: ["apps/control-plane-worker/src/session/prompt-queue.ts"],
              candidate_channels: ["path_match"],
            },
            {
              id: "bridge-post-execution-rendering",
              type: "action",
              content: "Sandbox bridge post-execution rendering must avoid duplicating final transcript rows.",
              context_hint: "bridge transcript rendering",
              confidence: "high",
              enforcement: "warn",
              applies_to: ["apps/sandbox-bridge/**"],
              candidate_channels: ["lexical"],
            },
            {
              id: "ui-transcript-reducer-idempotency",
              type: "action",
              content: "UI transcript reducers must be idempotent for duplicate terminal status updates.",
              context_hint: "UI transcript reducer",
              confidence: "high",
              enforcement: "warn",
              applies_to: ["apps/ui/**"],
              candidate_channels: ["lexical"],
            },
          ],
        }),
      }),
      {} as Env,
      d1,
      "session-explicit-recall-positive",
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        callbackContext: null,
      },
      { selector: evalSelector(["prompt-queue-terminal-idempotency"]), nowMs: 2_000 },
    );

    const body = (await response.json()) as {
      memories: Array<{ id: string; content: string }>;
      retrievalTrace: {
        candidates: Array<{ id: string; lanes: string[] }>;
        selector: { rejected: Array<{ memoryId: string }> };
      };
    };
    expect(response.status).toBe(200);
    expect(body.memories).toMatchObject([
      {
        id: "prompt-queue-terminal-idempotency",
        content: "Prompt queue terminal side effects must be idempotent because duplicate terminal events arrive.",
      },
    ]);
    expect(
      body.retrievalTrace.candidates.find((candidate) => candidate.id === "prompt-queue-terminal-idempotency")?.lanes,
    ).toContain("repo_ranked");
    expect(body.retrievalTrace.selector.rejected.map((entry) => entry.memoryId)).toEqual(
      expect.arrayContaining(["bridge-post-execution-rendering", "ui-transcript-reducer-idempotency"]),
    );
  });

  it("filters superseded repo memories before selector evaluation", async () => {
    insertRepoMemory(sqlite, {
      memoryId: "verification-model-active",
      contextHint: "verification model routing current",
      content: "Verification sessions must use the current verification model constant from model routing.",
      appliesTo: ["apps/control-plane-worker/src/models/**"],
    });
    insertRepoMemory(sqlite, {
      memoryId: "verification-model-superseded",
      status: "superseded",
      contextHint: "verification sessions old gpt-5.4-mini",
      content: "Verification sessions use old gpt-5.4-mini routing.",
      appliesTo: ["apps/control-plane-worker/src/models/**"],
    });

    const response = await handleMemoryContextQueryForSession(
      new Request("https://internal/session/memory/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "repo",
          intent: "Update model routing for verification sessions.",
          files: ["apps/control-plane-worker/src/models/routing.ts"],
          maxMemories: 3,
        }),
      }),
      {} as Env,
      d1,
      "session-superseded-filter",
      {
        businessId: "biz-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        callbackContext: null,
      },
      { selector: evalSelector(["verification-model-active"]), nowMs: 2_000 },
    );

    const body = (await response.json()) as {
      memories: Array<{ id: string }>;
      retrievalTrace: { candidates: Array<{ id: string }> };
    };
    expect(response.status).toBe(200);
    expect(body.memories).toMatchObject([{ id: "verification-model-active" }]);
    expect(body.retrievalTrace.candidates.map((candidate) => candidate.id)).toContain("verification-model-active");
    expect(body.retrievalTrace.candidates.map((candidate) => candidate.id)).not.toContain(
      "verification-model-superseded",
    );
  });
});
