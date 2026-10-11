// QA runtime memory capture: extracts self-reported "how to run this app"
// learnings from QA Tester launcher/operator phase notes, judges each with the
// existing repo-memory judge, and sinks accepted learnings into repo_memories
// tagged QA_RUNTIME_MEMORY_TAG. Best-effort by contract: malformed or missing
// blocks are silent no-ops, and failures must never affect the QA session.

import { QA_RUNTIME_MEMORY_TAG } from "../../../../shared/constants/qa-runtime-memory.js";
import { firstGithubPullRequestNumber, type MemoryFile } from "../../../../shared/memory/parser.js";
import {
  isQaRuntimeMemory,
  parseQaRuntimeLearnings,
  type QaRuntimeLearning,
} from "../../../../shared/verification/qa-runtime-learnings.js";
import type { Logger } from "../logger.js";
import type { Env } from "../types.js";
import {
  insertRepoMemoryJudgment,
  type InsertRepoMemoryJudgmentParams,
  listActiveRepoMemoriesForRepo,
  upsertRepoMemoryWithJudgment,
} from "./db.js";
import { judgeRepoMemorySuggestion, REPO_MEMORY_JUDGE_MODEL } from "./judge.js";
import { isRepoMemoryD1SinkEnabled } from "./service.js";
import { buildMemoryFileFromSuggestion, isoDate } from "./utils.js";

export interface CaptureQaRuntimeLearningsParams {
  repoOwner: string;
  repoName: string;
  targetPrUrl: string;
  qaSessionId: string;
  promptId: string;
  phase: string;
  noteOutput: string;
  log: Logger;
}

export interface CaptureQaRuntimeLearningsResult {
  parsedCount: number;
  storedCount: number;
  rejectedCount: number;
  supersededCount: number;
}

const NOOP_RESULT: CaptureQaRuntimeLearningsResult = {
  parsedCount: 0,
  storedCount: 0,
  rejectedCount: 0,
  supersededCount: 0,
};

export async function captureQaRuntimeLearningsFromPhaseNote(
  env: Env,
  params: CaptureQaRuntimeLearningsParams,
): Promise<CaptureQaRuntimeLearningsResult> {
  const { log } = params;
  if (!env.DB || !isRepoMemoryD1SinkEnabled(env)) return NOOP_RESULT;
  const apiKey = env.ARCANIST_OPENAI_API_KEY;
  if (!apiKey) {
    log.warn({ sessionId: params.qaSessionId }, "QA runtime memory capture skipped: no platform LLM key");
    return NOOP_RESULT;
  }
  const prNumber = firstGithubPullRequestNumber([params.targetPrUrl]);
  if (!prNumber) {
    log.warn(
      { sessionId: params.qaSessionId, targetPrUrl: params.targetPrUrl },
      "QA runtime memory capture skipped: unparseable target PR url",
    );
    return NOOP_RESULT;
  }
  const learnings = parseQaRuntimeLearnings(params.noteOutput);
  if (!learnings?.length) return NOOP_RESULT;

  const existingMemoryFiles = await listActiveRepoMemoriesForRepo(env.DB, params.repoOwner, params.repoName);
  const existingMemories = existingMemoryFiles.map((memory) => ({
    id: memory.id,
    memory_type: memory.memory_type,
    level: memory.level,
    primitive: memory.primitive,
    context_hint: memory.context_hint,
    content: memory.content,
    applies_to: memory.applies_to,
  }));
  const existingById = new Map(existingMemoryFiles.map((memory) => [memory.id, memory]));

  let storedCount = 0;
  let rejectedCount = 0;
  let supersededCount = 0;

  for (const [index, learning] of learnings.entries()) {
    const memory = buildQaRuntimeMemoryFile({ learning, index, params, prNumber });
    const judgment = await judgeRepoMemorySuggestion({
      apiKey,
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      sourcePrUrl: params.targetPrUrl,
      sourcePrNumber: prNumber,
      sourceSessionIds: [params.qaSessionId],
      log,
      episodeSummary: null,
      candidateAudit: [],
      existingMemories,
      change: { kind: "add", targetMemoryId: null, candidate: learning, memory },
    });
    const judgmentParams: InsertRepoMemoryJudgmentParams = {
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      sourcePrUrl: params.targetPrUrl,
      sourcePrNumber: prNumber,
      sourceSessionIds: [params.qaSessionId],
      suggestionKind: "add",
      targetMemoryId: null,
      memoryId: memory.id,
      verdict: judgment.belowConfidenceFloor ? "reject" : judgment.verdict,
      confidence: judgment.confidence,
      rationale: judgment.belowConfidenceFloor
        ? `store_below_confidence_floor: ${judgment.rationale}`
        : judgment.rationale,
      issues: judgment.issues,
      candidateJson: JSON.stringify(learning),
      judgeModel: REPO_MEMORY_JUDGE_MODEL,
    };

    if (judgment.verdict === "store" && !judgment.belowConfidenceFloor) {
      await upsertRepoMemoryWithJudgment(env.DB, {
        memory: {
          repoOwner: params.repoOwner,
          repoName: params.repoName,
          memory,
          sourcePrUrl: params.targetPrUrl,
          sourcePrNumber: prNumber,
          sourceSessionIds: [params.qaSessionId],
        },
        judgment: judgmentParams,
      });
      storedCount += 1;
      supersededCount += await applyQaRuntimeSupersedes({
        env,
        params,
        prNumber,
        supersedesMemoryIds: learning.supersedesMemoryIds,
        existingById,
      });
    } else {
      rejectedCount += 1;
      await insertRepoMemoryJudgment(env.DB, judgmentParams);
    }
  }

  log.info(
    {
      event: "qa_runtime_memory_capture",
      sessionId: params.qaSessionId,
      promptId: params.promptId,
      phase: params.phase,
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      parsedCount: learnings.length,
      storedCount,
      rejectedCount,
      supersededCount,
    },
    "QA runtime memory capture completed",
  );
  return { parsedCount: learnings.length, storedCount, rejectedCount, supersededCount };
}

function buildQaRuntimeMemoryFile({
  learning,
  index,
  params,
  prNumber,
}: {
  learning: QaRuntimeLearning;
  index: number;
  params: CaptureQaRuntimeLearningsParams;
  prNumber: number;
}): MemoryFile {
  const content = learning.evidence ? `${learning.detail}\n\nEvidence: ${learning.evidence}` : learning.detail;
  return buildMemoryFileFromSuggestion({
    id: buildQaRuntimeMemoryId(prNumber, params.promptId, params.phase, index),
    suggestion: {
      type: learning.kind,
      content,
      context_hint: `QA runtime: ${learning.claim}`,
      referenced_files: [],
      engineering_domains: ["runtime_behavior"],
      tags: [QA_RUNTIME_MEMORY_TAG, learning.kind],
      confidence: "medium",
      authority: "inferred",
      enforcement: "none",
      supersedes: learning.supersedesMemoryIds,
    },
    params: { prUrl: params.targetPrUrl, sessionIds: [params.qaSessionId] },
  });
}

// All verification phases run under one prompt id, so the phase slug is the
// discriminator that keeps launcher and operator learnings from colliding.
function buildQaRuntimeMemoryId(prNumber: number, promptId: string, phase: string, index: number): string {
  const phaseSlug = phase.replace(/^verification-/, "");
  return `mem_qa_pr_${prNumber}_${promptId.slice(0, 8)}_${phaseSlug}_${index + 1}`;
}

/**
 * Mark cited memories superseded. Restricted to memories that carry the QA
 * runtime tag: QA runs may never retire analyzer- or human-authored memories.
 */
async function applyQaRuntimeSupersedes({
  env,
  params,
  prNumber,
  supersedesMemoryIds,
  existingById,
}: {
  env: Env;
  params: CaptureQaRuntimeLearningsParams;
  prNumber: number;
  supersedesMemoryIds: string[];
  existingById: Map<string, MemoryFile>;
}): Promise<number> {
  if (!env.DB) return 0;
  let supersededCount = 0;
  for (const memoryId of supersedesMemoryIds) {
    const target = existingById.get(memoryId);
    if (!target || !isQaRuntimeMemory(target)) continue;
    const superseded: MemoryFile = { ...target, status: "superseded", updated_at: isoDate() };
    await upsertRepoMemoryWithJudgment(env.DB, {
      memory: {
        repoOwner: params.repoOwner,
        repoName: params.repoName,
        memory: superseded,
        sourcePrUrl: params.targetPrUrl,
        sourcePrNumber: prNumber,
        sourceSessionIds: [params.qaSessionId],
      },
      judgment: {
        repoOwner: params.repoOwner,
        repoName: params.repoName,
        sourcePrUrl: params.targetPrUrl,
        sourcePrNumber: prNumber,
        sourceSessionIds: [params.qaSessionId],
        suggestionKind: "remove",
        targetMemoryId: memoryId,
        memoryId,
        verdict: "store",
        confidence: 1,
        rationale: "Superseded by QA run evidence via supersedesMemoryIds self-report.",
        issues: [],
        candidateJson: JSON.stringify({ supersededBy: params.qaSessionId, promptId: params.promptId }),
        judgeModel: REPO_MEMORY_JUDGE_MODEL,
      },
    });
    supersededCount += 1;
  }
  return supersededCount;
}
