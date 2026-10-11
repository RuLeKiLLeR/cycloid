// Memory analysis orchestrator: triggered by the queue consumer when a human
// reviewer submits feedback on a Cycloid PR. Builds an AnalyzerContext with
// lazy closures, runs the memory analysis, then creates a PR with the results.

import type { MemoryFile } from "../../../../shared/memory/parser.js";
import {
  MEMORY_ROOT_DIR,
  memoryPathForFile,
  parseMemoryFile,
  serializeMemoryFile,
  shouldIgnoreMemoryPath,
} from "../../../../shared/memory/parser.js";
import { deriveReviewLoopSummaryOrRaw } from "../../../../shared/transcript/prompt-display.js";
import { recordSessionCompleteMemoryIngestion } from "../company-memory/service";
import {
  CONVENTION_TARGET_FILES,
  MEMORY_BRANCH_PREFIX,
  MEMORY_JOB_MAX_ATTEMPTS,
  MEMORY_JOB_STALE_THRESHOLD_MS,
} from "../constants/memory.js";
import { CYCLOID_MEMORY_LABEL, CYCLOID_PROVENANCE_LABELS } from "../constants/pr-labels.js";
import { createInstallationToken } from "../github/octokit.js";
import {
  addLabels,
  createPullRequest,
  ensureRepoLabel,
  getDefaultBranch,
  getPrDiff,
  getPrReviewComments,
  listLabels,
  removeLabel,
} from "../github/pr.js";
import type { Logger } from "../logger.js";
import { createLogger } from "../logger.js";
import { postStructuredEventToDd } from "../observability/events-exporter.js";
import { getSessionEventHistory, getSessionState, listSessionPrompts } from "../session/state.js";
import { postInternalAlert } from "../slack/internal-alerts.js";
import { MEMORY_PR_CHANNEL_ID } from "../slack/internal-channels.js";
import type { Env, SessionEvent } from "../types.js";
import { mapBounded } from "../utils.js";
import type {
  AnalyzerContext,
  AnalyzerMemoryReviewFinding,
  ConventionUpdateSuggestion,
  MemorySuggestions,
  PromptSummary,
  ReviewFeedback,
} from "./analyzer.js";
import { analyzeSessionForMemories, MEMORY_CANDIDATE_LANES } from "./analyzer.js";
import {
  claimMemoryAnalysisJob,
  completeMemoryAnalysisJob,
  failMemoryAnalysisJob,
  getMemoryAnalysisJob,
  insertRepoMemoryJudgment,
  listActiveRepoMemoriesForRepo,
  upsertMemoryPrTracking,
  upsertMemorySuggestionTracking,
  upsertRepoMemoryWithJudgment,
} from "./db.js";
import {
  createCommit,
  createOrResetRef,
  createOrUpdateFile,
  createTree,
  deleteRef,
  getCommitTreeSha,
  getFileContent,
  getFileSha,
  getRefSha,
  type GitTreeEntryInput,
  listDirectoryContents,
  updateRef,
} from "./github.js";
import { judgeRepoMemorySuggestion, REPO_MEMORY_JUDGE_MODEL } from "./judge.js";
import { extractMarkdownHeadings, extractSection, insertIntoSection } from "./markdown.js";
import { buildMemoryFileFromSuggestion, countCandidateAuditByLane, isoDate } from "./utils.js";

const MEMORY_DIR = MEMORY_ROOT_DIR;
const MEMORY_CONTENT_FETCH_CONCURRENCY = 10;
const CYCLOID_PROVENANCE_LABEL_SET = new Set<string>(CYCLOID_PROVENANCE_LABELS);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface TriggerMemoryAnalysisParams {
  sessionIds: string[];
  prUrl: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
  installationId: number;
  prTitle?: string | null;
  prBody?: string | null;
  installationToken?: string;
  /** Review feedback — all review comments on the PR at merge time. */
  reviewFeedback: ReviewFeedback;
}

/** Params stored in memory_analysis_jobs.params_json. Created on PR merge. */
export interface MemoryAnalysisJobParams {
  sessionIds: string[];
  prUrl: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
  installationId: number;
  prTitle?: string | null;
  prBody?: string | null;
}

type MemoryAnalysisOutcome =
  | { status: "complete" }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string; retryable: boolean };

type RepoMemorySink = "github_pr" | "d1";

/** Queue message — just the job ID; params live in D1. */
export interface MemoryAnalysisQueueMessage {
  jobId: string;
}

// ---------------------------------------------------------------------------
// Queue consumer handler
// ---------------------------------------------------------------------------

export async function handleMemoryAnalysisQueue(
  batch: MessageBatch<MemoryAnalysisQueueMessage>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await processMemoryAnalysisMessage(msg, env);
    } catch (err) {
      // Per-message isolation: an unexpected throw (e.g. a D1 error before the
      // processor's own guard) must not abort the rest of the batch. Retry just
      // this message; the others still get processed.
      createLogger({ bindings: { component: "memory-queue", jobId: msg.body.jobId } }).error(
        { error: String(err) },
        "Memory analysis message threw; retrying this message",
      );
      msg.retry();
    }
  }
}

async function processMemoryAnalysisMessage(msg: Message<MemoryAnalysisQueueMessage>, env: Env): Promise<void> {
  const { jobId } = msg.body;
  const log = createLogger({ bindings: { component: "memory-queue", jobId } });

  const job = await getMemoryAnalysisJob(env.DB, jobId);
  if (!job) {
    log.warn({}, "Memory analysis job not found");
    msg.ack();
    return;
  }

  const attemptCount = await claimMemoryAnalysisJob(
    env.DB,
    jobId,
    MEMORY_JOB_STALE_THRESHOLD_MS,
    MEMORY_JOB_MAX_ATTEMPTS,
  );
  if (attemptCount === null) {
    log.info({ status: job.status, attempts: job.attempt_count }, "Memory analysis job not claimable");
    msg.ack();
    return;
  }

  // Top-level catch: any uncaught throw → mark failed
  let outcome: MemoryAnalysisOutcome;
  try {
    const params = JSON.parse(job.params_json) as MemoryAnalysisJobParams;

    // Fetch all review comments on the PR — by merge time the full review
    // conversation has happened (reviewer comments + author responses).
    const installationToken = await createInstallationToken(env, params.installationId);
    const allComments = await getPrReviewComments(
      installationToken,
      params.repoOwner,
      params.repoName,
      params.prNumber,
    );
    const reviewComments = allComments.map((c) => ({
      path: c.path,
      line: c.line,
      body: c.body,
      author: c.author,
    }));

    const triggerParams: TriggerMemoryAnalysisParams = {
      ...params,
      installationToken,
      reviewFeedback: {
        reviewBody: null,
        comments: reviewComments,
        reviewAuthor: "",
        reviewState: "merged",
      },
    };

    outcome = await triggerMemoryAnalysis(env, triggerParams, log);
  } catch (err) {
    log.error({ error: String(err) }, "Memory analysis consumer caught unhandled error");
    // Console logs are not shipped to Datadog (logpush is off); direct-post
    // so the [Memory] consumer-errors monitor can fire.
    await postStructuredEventToDd(env, { event: "memory.consumer_error", jobId, error: String(err) });
    outcome = { status: "error", error: String(err), retryable: true };
  }

  // Record outcome — attemptCount guard prevents a reclaimed job from being
  // overwritten by the original (now-stale) holder.
  switch (outcome.status) {
    case "complete":
      await completeMemoryAnalysisJob(env.DB, jobId, "complete", attemptCount);
      msg.ack();
      break;
    case "skipped":
      await completeMemoryAnalysisJob(env.DB, jobId, "skipped", attemptCount);
      msg.ack();
      break;
    case "error":
      try {
        await failMemoryAnalysisJob(env.DB, jobId, outcome.error, attemptCount);
      } catch (dbErr) {
        log.error(
          { error: String(dbErr), originalError: outcome.error },
          "Failed to record memory analysis job failure in D1",
        );
      }
      if (outcome.retryable) msg.retry();
      else msg.ack();
      break;
  }
}

// ---------------------------------------------------------------------------
// Core analysis orchestrator
// ---------------------------------------------------------------------------

export async function triggerMemoryAnalysis(
  env: Env,
  params: TriggerMemoryAnalysisParams,
  log: Logger,
): Promise<MemoryAnalysisOutcome> {
  const apiKey = env.ARCANIST_OPENAI_API_KEY;

  // 1. Find first reachable session (earlier IDs may be stale/deleted)
  let canonicalSessionId: string | null = null;
  for (const sid of params.sessionIds) {
    const s = await getSessionState(env, sid);
    if (s) {
      canonicalSessionId = sid;
      break;
    }
    log.info({ sessionId: sid }, "Memory analysis: session not found, trying next");
  }
  if (!canonicalSessionId) {
    log.warn({ sessionIds: params.sessionIds }, "Memory analysis: no reachable sessions");
    return { status: "skipped", reason: "no_reachable_sessions" };
  }
  const canonicalSession = await getSessionState(env, canonicalSessionId);

  // 2. Get installation token + default branch
  let installationToken: string;
  try {
    installationToken = params.installationToken ?? (await createInstallationToken(env, params.installationId));
  } catch (err) {
    log.error({ error: String(err) }, "Memory analysis: failed to get installation token");
    return { status: "error", error: String(err), retryable: true };
  }

  let defaultBranch: string;
  try {
    defaultBranch = await getDefaultBranch(installationToken, params.repoOwner, params.repoName);
  } catch (err) {
    log.error({ error: String(err) }, "Memory analysis: failed to get default branch");
    return { status: "error", error: String(err), retryable: true };
  }

  // 3. Load existing memories from repo (needed both for the agent and for PR creation)
  let loadedMemories: LoadedMemory[];
  const memorySink = getRepoMemorySink(env);
  try {
    loadedMemories = await loadMemoriesFromRepo(
      installationToken,
      params.repoOwner,
      params.repoName,
      defaultBranch,
      log,
    );
    if (memorySink === "d1") {
      loadedMemories = mergeLoadedMemories(
        loadedMemories,
        await loadMemoriesFromD1(env.DB, params.repoOwner, params.repoName, log),
        log,
      );
    }
  } catch (err) {
    log.error({ error: String(err) }, "Memory analysis: failed to load existing memories");
    return { status: "error", error: String(err), retryable: true };
  }

  // 4. Build AnalyzerContext with lazy closures — agent pulls what it needs
  let cachedInstallationToken = installationToken;
  const refreshToken = async () => cachedInstallationToken;

  const fileContentCache = new Map<string, string | null>();

  const context: AnalyzerContext = {
    getSessionPrompts: async (sessionId: string): Promise<PromptSummary[]> => {
      const result = await listSessionPrompts(env, sessionId);
      if (!result.ok || !result.payload) {
        throw new Error(`Session prompts unavailable for ${sessionId} (status: ${result.status})`);
      }
      return result.payload.prompts.slice(-30).map((p) => ({
        promptId: p.promptId,
        // Review-loop turns contribute their footer-free human summary; every other prompt (incl.
        // ticket/webhook bootstrap prompts whose real text lives in a <user_content> block) is left
        // raw, so the analyzer keeps their content. See deriveReviewLoopSummaryOrRaw.
        prompt: deriveReviewLoopSummaryOrRaw({ prompt: p.prompt, replyToText: p.replyToText }).slice(0, 500),
        status: p.status,
        error: (p.error as string)?.slice(0, 200) ?? null,
        createdAt: p.createdAt ?? "",
        actorUserId: p.actorUserId ?? null,
        agent: p.agent,
      }));
    },

    getSessionEvents: async (sessionId: string, opts): Promise<SessionEvent[]> => {
      const result = await getSessionEventHistory(env, sessionId, opts.promptId, opts.afterSequence);
      if (!result.ok) {
        throw new Error(`Session events unavailable for ${sessionId}`);
      }
      let events = result.events;
      if (opts.types?.length) {
        const typeSet = new Set(opts.types);
        events = events.filter((e) => typeSet.has(e.type));
      }
      return events.slice(0, opts.limit ?? 50);
    },

    getPrDiff: async (): Promise<string> => {
      const token = await refreshToken();
      return getPrDiff(token, params.repoOwner, params.repoName, params.prNumber);
    },

    getFileContent: async (filePath: string): Promise<string | null> => {
      if (fileContentCache.has(filePath)) return fileContentCache.get(filePath)!;
      const token = await refreshToken();
      const content = await getFileContent(token, params.repoOwner, params.repoName, filePath, defaultBranch);
      fileContentCache.set(filePath, content);
      return content;
    },

    getExistingMemories: async () => {
      return loadedMemories.map((lm) => toAnalyzerInput(lm.memory));
    },

    getSessionMemoryUsage: async (sessionIds) => {
      const { getMemoryUsageForSessions } = await import("./db.js");
      return getMemoryUsageForSessions(env.DB, sessionIds);
    },

    getSessionMemoryReviewFindings: async (sessionIds) => {
      const { getEvaluationsBySessions } = await import("../eval/db.js");
      const evaluationsBySession = await getEvaluationsBySessions(env.DB, sessionIds);
      const rows = [...evaluationsBySession.values()].flat();
      return rows.flatMap((row) =>
        extractAnalyzerMemoryReviewFindings(row.evaluator_model, row.memory_review_json ?? null),
      );
    },

    getConventionDocSection: async (filePath: string, sectionHeading?: string): Promise<string | null> => {
      if (!CONVENTION_TARGET_FILES.has(filePath)) return null;
      let content: string | null;
      if (fileContentCache.has(filePath)) {
        content = fileContentCache.get(filePath)!;
      } else {
        const token = await refreshToken();
        content = await getFileContent(token, params.repoOwner, params.repoName, filePath, defaultBranch);
        fileContentCache.set(filePath, content);
      }
      if (!content) return null;
      if (!sectionHeading) {
        // Return headings list
        return extractMarkdownHeadings(content).join("\n");
      }
      return extractSection(content, sectionHeading);
    },

    repoOwner: params.repoOwner,
    repoName: params.repoName,
    sessionIds: params.sessionIds,
    prNumber: params.prNumber,
    prUrl: params.prUrl,
    prTitle: params.prTitle ?? null,
    prBody: params.prBody ?? null,
  };

  // 5. Run the memory analysis
  const result = await analyzeSessionForMemories(apiKey, params.reviewFeedback, context, log);

  // Check for all-tools-failed: no model suggestions and every context fetch errored → transient infra issue.
  const { suggestions } = result;
  const hasMemoryChanges = suggestions.add.length > 0 || suggestions.update.length > 0 || suggestions.remove.length > 0;
  const hasConventionChanges = suggestions.convention_updates.length > 0;
  const candidateAudit = suggestions.candidate_audit ?? [];
  log.info(
    {
      candidateAuditCounts: countCandidateAuditByLane(candidateAudit, MEMORY_CANDIDATE_LANES),
      selectedLanes: candidateAudit.filter((entry) => entry.selected).map((entry) => entry.lane),
    },
    "Memory analysis candidate audit completed",
  );

  if (!hasMemoryChanges && !hasConventionChanges) {
    if (result.analysisError) {
      log.warn({ error: result.analysisError }, "Memory analysis failed — treating as retryable error");
      return { status: "error", error: result.analysisError, retryable: true };
    }
    if (result.toolErrorCount > 0 && result.toolErrorCount === result.toolCallCount) {
      log.warn(
        { toolErrorCount: result.toolErrorCount, toolCallCount: result.toolCallCount },
        "Memory analysis: all tool calls failed — treating as retryable error",
      );
      return { status: "error", error: `all ${result.toolErrorCount} tool calls failed`, retryable: true };
    }
    await recordCompletedSessionIngestion(env, params, canonicalSessionId, canonicalSession?.businessId ?? null, log);
    log.info({ prUrl: params.prUrl }, "Memory analysis: no suggestions");
    return { status: "complete" };
  }

  let suggestionsForPr = suggestions;
  let hasMemoryChangesForPr = hasMemoryChanges;

  if (hasMemoryChanges && memorySink === "d1") {
    try {
      const persisted = await persistRepoMemorySuggestionsToD1({
        env,
        apiKey,
        params,
        suggestions,
        loadedMemories,
        log,
      });
      log.info(
        {
          prUrl: params.prUrl,
          storedCount: persisted.storedCount,
          rejectedCount: persisted.rejectedCount,
          judgedCount: persisted.judgedCount,
        },
        "Memory analysis: repo-memory suggestions judged for D1 sink",
      );
      await upsertMemorySuggestionTracking(env.DB, {
        repoOwner: params.repoOwner,
        repoName: params.repoName,
        sourcePrUrl: params.prUrl,
        sourcePrNumber: params.prNumber,
        sourceSessionId: params.sessionIds[0],
        memoryPrUrl: null,
        memoryPrNumber: null,
        memoriesAdded: persisted.storedAdds,
        memoriesUpdated: persisted.storedUpdates,
        memoriesRemoved: persisted.storedRemovals,
        suggestionsJson: JSON.stringify(suggestions),
      });
    } catch (err) {
      log.error({ error: String(err), prUrl: params.prUrl }, "Memory analysis: D1 memory sink failed");
      return { status: "error", error: String(err), retryable: true };
    }

    suggestionsForPr = { ...suggestions, add: [], update: [], remove: [] };
    hasMemoryChangesForPr = false;

    if (!hasConventionChanges) {
      await recordCompletedSessionIngestion(env, params, canonicalSessionId, canonicalSession?.businessId ?? null, log);
      return { status: "complete" };
    }
  }

  // 7. Create the PR with file changes
  try {
    installationToken = cachedInstallationToken;
    const headSha = await getRefSha(installationToken, params.repoOwner, params.repoName, `heads/${defaultBranch}`);
    const branchName = `${MEMORY_BRANCH_PREFIX}${params.prNumber}`;

    await createOrResetRef(installationToken, params.repoOwner, params.repoName, `refs/heads/${branchName}`, headSha);

    const memoryTreeEntries: GitTreeEntryInput[] = [];

    // Add new memories as files
    for (const suggestion of suggestionsForPr.add) {
      const memFile = buildMemoryFileFromSuggestion({
        id: `mem_${crypto.randomUUID().slice(0, 8)}`,
        suggestion,
        params,
      });
      memoryTreeEntries.push({
        path: memoryPathForFile(memFile),
        mode: "100644",
        type: "blob",
        content: serializeMemoryFile(memFile),
      });
    }

    // Update existing memories (use discovered repo path, not reconstructed filename)
    const loadedById = new Map(loadedMemories.map((lm) => [lm.memory.id, lm]));
    for (const suggestion of suggestionsForPr.update) {
      const loaded = loadedById.get(suggestion.id);
      if (!loaded) continue;
      const updated = buildUpdatedMemoryFile(loaded.memory, suggestion);
      const updatedPath = memoryPathForFile(updated);
      memoryTreeEntries.push({
        path: updatedPath,
        mode: "100644",
        type: "blob",
        content: serializeMemoryFile(updated),
      });
      if (updatedPath !== loaded.repoPath) {
        const currentSha = await getFileSha(
          installationToken,
          params.repoOwner,
          params.repoName,
          loaded.repoPath,
          headSha,
        );
        if (currentSha !== loaded.sha) {
          throw new Error(`Memory file changed before rename delete: ${loaded.repoPath}`);
        }
        memoryTreeEntries.push({
          path: loaded.repoPath,
          mode: "100644",
          type: "blob",
          sha: null,
        });
      }
    }

    // Supersede memories instead of deleting durable memory history.
    for (const suggestion of suggestionsForPr.remove) {
      const loaded = loadedById.get(suggestion.id);
      if (!loaded) continue;
      const superseded: MemoryFile = {
        ...loaded.memory,
        status: "superseded",
        updated_at: isoDate(),
      };
      memoryTreeEntries.push({
        path: loaded.repoPath,
        mode: "100644",
        type: "blob",
        content: serializeMemoryFile(superseded),
      });
    }

    if (memoryTreeEntries.length > 0) {
      await commitMemoryTreeEntries(
        installationToken,
        params.repoOwner,
        params.repoName,
        branchName,
        headSha,
        memoryTreeEntries,
      );
    }

    // Apply convention updates to docs files
    let conventionsApplied = false;
    if (hasConventionChanges) {
      conventionsApplied = await applyConventionUpdates(
        installationToken,
        params.repoOwner,
        params.repoName,
        branchName,
        suggestionsForPr.convention_updates,
        log,
      );
    }

    // If no changes were actually committed, clean up the branch and bail
    if (!hasMemoryChangesForPr && !conventionsApplied) {
      log.info({ prUrl: params.prUrl }, "Memory analysis: all convention updates skipped, no commits to PR");
      await deleteRef(installationToken, params.repoOwner, params.repoName, `heads/${branchName}`).catch((err) => {
        log.warn({ error: String(err), branchName }, "Memory analysis: failed to clean up empty branch");
      });
      return { status: "complete" };
    }

    // Open the PR
    const prTitle = buildPrTitle(params.prNumber, hasMemoryChangesForPr, conventionsApplied);
    const prBody = buildPrBody(suggestionsForPr, params);
    const {
      prUrl: memoryPrUrl,
      prNumber: memoryPrNumber,
      created,
    } = await createPullRequest({
      token: installationToken,
      owner: params.repoOwner,
      repo: params.repoName,
      head: branchName,
      base: defaultBranch,
      title: prTitle,
      body: prBody,
    });

    // Post-PR side effects (non-critical — failures here do NOT fail the job)
    try {
      await applyCycloidLabelToMemoryPr(
        installationToken,
        params.repoOwner,
        params.repoName,
        memoryPrNumber,
        params.prUrl,
        log,
      );

      await upsertMemoryPrTracking(env.DB, {
        repoOwner: params.repoOwner,
        repoName: params.repoName,
        sourcePrUrl: params.prUrl,
        sourcePrNumber: params.prNumber,
        sourceSessionId: params.sessionIds[0],
        memoryPrUrl,
        memoryPrNumber,
        memoriesAdded: suggestionsForPr.add.length,
        memoriesUpdated: suggestionsForPr.update.length,
        memoriesRemoved: suggestionsForPr.remove.length,
        suggestionsJson: JSON.stringify(suggestionsForPr),
      });

      await recordCompletedSessionIngestion(env, params, canonicalSessionId, canonicalSession?.businessId ?? null, log);

      if (created) {
        await notifySlackMemoryPrCreated(env, params, suggestionsForPr, memoryPrUrl, memoryPrNumber, log);

        log.info(
          {
            memoryPrUrl,
            memoryPrNumber,
            addCount: suggestionsForPr.add.length,
            updateCount: suggestionsForPr.update.length,
            removeCount: suggestionsForPr.remove.length,
            conventionUpdateCount: suggestionsForPr.convention_updates.length,
            sourcePr: params.prUrl,
          },
          "Memory PR created",
        );
      } else {
        log.info(
          { memoryPrUrl, memoryPrNumber, sourcePr: params.prUrl },
          "Memory PR already exists; skipped Slack notification",
        );
      }
    } catch (sideEffectErr) {
      log.warn(
        { error: String(sideEffectErr), memoryPrUrl, prUrl: params.prUrl },
        "Post-PR side effects failed (non-critical; PR was already created)",
      );
    }

    return { status: "complete" };
  } catch (err) {
    log.error({ error: String(err), prUrl: params.prUrl }, "Failed to create memory PR");
    return { status: "error", error: String(err), retryable: true };
  }
}

async function commitMemoryTreeEntries(
  token: string,
  owner: string,
  repo: string,
  branchName: string,
  headSha: string,
  tree: readonly GitTreeEntryInput[],
): Promise<void> {
  const baseTree = await getCommitTreeSha(token, owner, repo, headSha);
  const treeSha = await createTree(token, owner, repo, { baseTree, tree });
  const commitSha = await createCommit(token, owner, repo, {
    message: "Update repo memories",
    tree: treeSha,
    parents: [headSha],
  });
  await updateRef(token, owner, repo, `heads/${branchName}`, { sha: commitSha, force: false });
}

function getRepoMemorySink(env: Env): RepoMemorySink {
  return env.MEMORY_REPO_SINK === "d1" ? "d1" : "github_pr";
}

export function isRepoMemoryD1SinkEnabled(env: Env): boolean {
  return getRepoMemorySink(env) === "d1";
}

async function persistRepoMemorySuggestionsToD1({
  env,
  apiKey,
  params,
  suggestions,
  loadedMemories,
  log,
}: {
  env: Env;
  apiKey: string;
  params: TriggerMemoryAnalysisParams;
  suggestions: MemorySuggestions;
  loadedMemories: LoadedMemory[];
  log: Logger;
}): Promise<{
  judgedCount: number;
  storedCount: number;
  rejectedCount: number;
  storedAdds: number;
  storedUpdates: number;
  storedRemovals: number;
}> {
  const loadedById = new Map(loadedMemories.map((lm) => [lm.memory.id, lm]));
  const existingMemories = loadedMemories.map((lm) => ({
    id: lm.memory.id,
    memory_type: lm.memory.memory_type,
    level: lm.memory.level,
    primitive: lm.memory.primitive,
    context_hint: lm.memory.context_hint,
    content: lm.memory.content,
    applies_to: lm.memory.applies_to,
  }));

  let judgedCount = 0;
  let storedCount = 0;
  let rejectedCount = 0;
  let storedAdds = 0;
  let storedUpdates = 0;
  let storedRemovals = 0;

  const judgeAndPersist = async ({
    kind,
    targetMemoryId,
    candidate,
    memory,
  }: {
    kind: "add" | "update" | "remove";
    targetMemoryId: string | null;
    candidate: unknown;
    memory: MemoryFile | null;
  }) => {
    const judgment = await judgeRepoMemorySuggestion({
      apiKey,
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      sourcePrUrl: params.prUrl,
      sourcePrNumber: params.prNumber,
      sourceSessionIds: params.sessionIds,
      log,
      episodeSummary: suggestions.episode_summary ?? null,
      candidateAudit: suggestions.candidate_audit ?? [],
      existingMemories,
      change: { kind, targetMemoryId, candidate, memory },
    });

    judgedCount += 1;
    const judgmentParams = {
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      sourcePrUrl: params.prUrl,
      sourcePrNumber: params.prNumber,
      sourceSessionIds: params.sessionIds,
      suggestionKind: kind,
      targetMemoryId,
      memoryId: memory?.id ?? targetMemoryId,
      verdict: judgment.belowConfidenceFloor ? "reject" : judgment.verdict,
      confidence: judgment.confidence,
      rationale: judgment.belowConfidenceFloor
        ? `store_below_confidence_floor: ${judgment.rationale}`
        : judgment.rationale,
      issues: judgment.issues,
      candidateJson: JSON.stringify(candidate),
      judgeModel: REPO_MEMORY_JUDGE_MODEL,
    } as const;

    if (judgment.verdict === "store" && !judgment.belowConfidenceFloor && memory) {
      await upsertRepoMemoryWithJudgment(env.DB, {
        memory: {
          repoOwner: params.repoOwner,
          repoName: params.repoName,
          memory,
          sourcePrUrl: params.prUrl,
          sourcePrNumber: params.prNumber,
          sourceSessionIds: params.sessionIds,
        },
        judgment: judgmentParams,
      });
      storedCount += 1;
      if (kind === "add") storedAdds += 1;
      else if (kind === "update") storedUpdates += 1;
      else storedRemovals += 1;
    } else {
      rejectedCount += 1;
      await insertRepoMemoryJudgment(env.DB, judgmentParams);
    }
  };

  for (const [index, suggestion] of suggestions.add.entries()) {
    const memory = buildMemoryFileFromSuggestion({
      id: buildD1MemoryId(params, index),
      suggestion,
      params,
    });
    await judgeAndPersist({ kind: "add", targetMemoryId: null, candidate: suggestion, memory });
  }

  for (const suggestion of suggestions.update) {
    const loaded = loadedById.get(suggestion.id);
    if (!loaded) {
      log.warn({ memoryId: suggestion.id, prUrl: params.prUrl }, "D1 memory sink: update target not found");
      continue;
    }
    const memory = buildUpdatedMemoryFile(loaded.memory, suggestion);
    await judgeAndPersist({ kind: "update", targetMemoryId: suggestion.id, candidate: suggestion, memory });
  }

  for (const suggestion of suggestions.remove) {
    const loaded = loadedById.get(suggestion.id);
    if (!loaded) {
      log.warn({ memoryId: suggestion.id, prUrl: params.prUrl }, "D1 memory sink: remove target not found");
      continue;
    }
    const memory: MemoryFile = {
      ...loaded.memory,
      status: "superseded",
      updated_at: isoDate(),
    };
    await judgeAndPersist({ kind: "remove", targetMemoryId: suggestion.id, candidate: suggestion, memory });
  }

  return { judgedCount, storedCount, rejectedCount, storedAdds, storedUpdates, storedRemovals };
}

async function recordCompletedSessionIngestion(
  env: Env,
  params: TriggerMemoryAnalysisParams,
  canonicalSessionId: string,
  businessId: string | null,
  log: Logger,
): Promise<void> {
  if (!businessId) {
    log.warn({ sessionId: canonicalSessionId }, "Skipping session-complete memory ingestion: business_id unavailable");
    return;
  }
  try {
    const promptsResult = await listSessionPrompts(env, canonicalSessionId);
    const promptSummary =
      promptsResult.ok && promptsResult.payload
        ? promptsResult.payload.prompts
            .slice(-5)
            .map(
              (prompt) =>
                `Prompt ${prompt.promptId} (${prompt.status}): ${deriveReviewLoopSummaryOrRaw({ prompt: prompt.prompt, replyToText: prompt.replyToText }).slice(0, 1_000)}`,
            )
            .join("\n\n")
        : "";
    await recordSessionCompleteMemoryIngestion(env, {
      businessId,
      sessionId: canonicalSessionId,
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      prNumber: params.prNumber,
      prUrl: params.prUrl,
      summaryText: [
        `Cycloid session ${canonicalSessionId} completed for ${params.repoOwner}/${params.repoName} PR #${params.prNumber}.`,
        `Source PR: ${params.prUrl}`,
        promptSummary,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
  } catch (err) {
    log.warn({ sessionId: canonicalSessionId, error: String(err) }, "Session-complete memory ingestion failed");
  }
}

async function applyCycloidLabelToMemoryPr(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  sourcePrUrl: string,
  log: Logger,
): Promise<void> {
  try {
    const ensured = await ensureRepoLabel(
      token,
      owner,
      repo,
      CYCLOID_MEMORY_LABEL,
      "5319e7",
      "Created by Cycloid (memory update)",
    );
    if (!ensured.ok) {
      log.warn(
        {
          event: "cycloid_label_unavailable",
          repo: `${owner}/${repo}`,
          prNumber,
          sourcePrUrl,
          reason: ensured.reason,
          status: ensured.status,
        },
        "Could not apply cycloid:memory label to memory PR",
      );
      return;
    }
    const currentLabels = await listLabels(token, owner, repo, prNumber);
    if (!currentLabels.includes(CYCLOID_MEMORY_LABEL)) {
      await addLabels(token, owner, repo, prNumber, [CYCLOID_MEMORY_LABEL]);
    }

    const staleProvenanceLabels = currentLabels.filter(
      (label) => label !== CYCLOID_MEMORY_LABEL && CYCLOID_PROVENANCE_LABEL_SET.has(label),
    );
    await Promise.all(staleProvenanceLabels.map((label) => removeLabel(token, owner, repo, prNumber, label)));
  } catch (error) {
    log.warn(
      {
        event: "cycloid_label_unavailable",
        repo: `${owner}/${repo}`,
        prNumber,
        sourcePrUrl,
        reason: "exception",
        error: String(error),
      },
      "Could not apply cycloid:memory label to memory PR",
    );
  }
}

// ---------------------------------------------------------------------------
// Convention update helpers
// ---------------------------------------------------------------------------

/**
 * Apply convention updates by reading each target doc file, inserting content
 * into the specified section, and writing the modified file back to the branch.
 * Groups updates by target file so each file is written at most once.
 * Skips updates whose section_heading doesn't match a real heading in the file.
 * Returns true if at least one file was actually written.
 */
async function applyConventionUpdates(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  updates: ConventionUpdateSuggestion[],
  log: Logger,
): Promise<boolean> {
  // Group by target file to batch edits
  const byFile = new Map<string, ConventionUpdateSuggestion[]>();
  for (const u of updates) {
    const existing = byFile.get(u.target_file) ?? [];
    existing.push(u);
    byFile.set(u.target_file, existing);
  }

  let anyFileWritten = false;

  for (const [targetFile, fileUpdates] of byFile) {
    let content = await getFileContent(token, owner, repo, targetFile, branch);
    if (!content) {
      log.warn({ targetFile }, "Convention update: target file not found, skipping");
      continue;
    }

    let anyApplied = false;
    for (const update of fileUpdates) {
      const result = insertIntoSection(content, update.section_heading, update.content);
      if (result === null) {
        log.warn(
          { targetFile, sectionHeading: update.section_heading },
          "Convention update: section heading not found in doc, skipping",
        );
        continue;
      }
      content = result;
      anyApplied = true;
    }

    if (!anyApplied) continue;

    const sectionNames = fileUpdates.map((u) => u.section_heading).join(", ");
    await createOrUpdateFile(token, owner, repo, {
      path: targetFile,
      message: `Update conventions (${sectionNames.slice(0, 50)})`,
      content,
      branch,
    });
    anyFileWritten = true;
  }

  return anyFileWritten;
}

// ---------------------------------------------------------------------------
// Memory helpers
// ---------------------------------------------------------------------------

interface LoadedMemory {
  memory: MemoryFile;
  /** Actual repo path (e.g. ".cycloid/memory/engineering/action/procedures/foo.md") */
  repoPath: string;
  /** Git blob SHA for the file (needed for delete operations) */
  sha: string;
}

async function loadMemoriesFromD1(db: D1Database, owner: string, repo: string, log: Logger): Promise<LoadedMemory[]> {
  try {
    const memories = await listActiveRepoMemoriesForRepo(db, owner, repo);
    return memories.map((memory) => ({
      memory,
      repoPath: `d1:${memory.id}`,
      sha: "",
    }));
  } catch (error) {
    log.warn({ owner, repo, error: String(error) }, "Failed to load existing D1 repo memories");
    throw error;
  }
}

function mergeLoadedMemories(repoMemories: LoadedMemory[], d1Memories: LoadedMemory[], log: Logger): LoadedMemory[] {
  const byId = new Map<string, LoadedMemory>();
  for (const memory of repoMemories) {
    byId.set(memory.memory.id, memory);
  }
  for (const memory of d1Memories) {
    if (byId.has(memory.memory.id)) {
      log.warn({ memoryId: memory.memory.id }, "D1 memory duplicates repo memory ID; using D1 memory");
    }
    byId.set(memory.memory.id, memory);
  }
  return [...byId.values()];
}

async function loadMemoriesFromRepo(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  log: Logger,
): Promise<LoadedMemory[]> {
  const mdFiles = await listMemoryMarkdownFiles(token, owner, repo, MEMORY_DIR, ref);

  // Transient GitHub errors reject the whole load (fail closed, matching
  // getFileContent's contract); missing files resolve null and are skipped.
  const contents = await mapBounded(mdFiles, MEMORY_CONTENT_FETCH_CONCURRENCY, (file) =>
    getFileContent(token, owner, repo, file.path, ref),
  );
  const memories: LoadedMemory[] = [];
  const seenIds = new Set<string>();
  for (const [index, file] of mdFiles.entries()) {
    const content = contents[index];
    if (!content) continue;
    const parsed = parseMemoryFile(content);
    if (parsed) {
      if (seenIds.has(parsed.id)) {
        log.warn({ path: file.path, id: parsed.id }, "Duplicate memory ID, skipping");
        continue;
      }
      seenIds.add(parsed.id);
      memories.push({ memory: parsed, repoPath: file.path, sha: file.sha });
    } else {
      log.warn({ path: file.path }, "Failed to parse memory file");
    }
  }
  return memories;
}

async function listMemoryMarkdownFiles(
  token: string,
  owner: string,
  repo: string,
  dirPath: string,
  ref: string,
): Promise<Array<{ name: string; path: string; sha: string; type: "file" | "dir" }>> {
  const entries = await listDirectoryContents(token, owner, repo, dirPath, ref);
  const files: Array<{ name: string; path: string; sha: string; type: "file" | "dir" }> = [];
  for (const entry of entries) {
    if (entry.type === "dir") {
      files.push(...(await listMemoryMarkdownFiles(token, owner, repo, entry.path, ref)));
      continue;
    }
    if (entry.name.endsWith(".md") && !shouldIgnoreMemoryPath(entry.path)) {
      files.push(entry);
    }
  }
  return files;
}

/** Convert MemoryFile to AnalyzerMemoryInput. */
function toAnalyzerInput(m: MemoryFile) {
  return {
    id: m.id,
    content: m.content,
    context_hint: m.context_hint,
    type: m.memory_type,
    referenced_files: JSON.stringify(m.applies_to),
  };
}

function buildUpdatedMemoryFile(existing: MemoryFile, suggestion: MemorySuggestions["update"][number]): MemoryFile {
  return {
    ...existing,
    ...(suggestion.memory_type ? { memory_type: suggestion.memory_type } : {}),
    ...(suggestion.action_type !== undefined ? { action_type: suggestion.action_type } : {}),
    ...(suggestion.level ? { level: suggestion.level } : {}),
    ...(suggestion.primitive ? { primitive: suggestion.primitive } : {}),
    ...(suggestion.engineering_domains?.length ? { engineering_domains: suggestion.engineering_domains } : {}),
    ...(suggestion.subjects ? { subjects: suggestion.subjects } : {}),
    ...(suggestion.symbols ? { symbols: suggestion.symbols } : {}),
    ...(suggestion.tags ? { tags: suggestion.tags } : {}),
    ...(suggestion.confidence ? { confidence: suggestion.confidence } : {}),
    ...(suggestion.authority ? { authority: suggestion.authority } : {}),
    ...(suggestion.enforcement ? { enforcement: suggestion.enforcement } : {}),
    ...(suggestion.triggers !== undefined ? { triggers: suggestion.triggers } : {}),
    ...(suggestion.supersedes ? { supersedes: suggestion.supersedes } : {}),
    ...(suggestion.contradicts ? { contradicts: suggestion.contradicts } : {}),
    content: suggestion.content,
    context_hint: suggestion.context_hint,
    applies_to: suggestion.referenced_files,
    updated_at: isoDate(),
  };
}

function buildD1MemoryId(params: Pick<TriggerMemoryAnalysisParams, "prNumber">, addIndex: number): string {
  return `mem_pr_${params.prNumber}_add_${addIndex + 1}`;
}

function buildPrTitle(prNumber: number, hasMemoryChanges: boolean, hasConventionChanges: boolean): string {
  if (hasMemoryChanges && hasConventionChanges) {
    return `Memory & convention updates from review of PR #${prNumber}`;
  }
  if (hasConventionChanges) {
    return `Convention updates from review of PR #${prNumber}`;
  }
  return `Memory update from review of PR #${prNumber}`;
}

function buildPrBody(
  suggestions: MemorySuggestions,
  params: { prUrl: string; prNumber: number; sessionIds: string[] },
): string {
  const lines = [`## Memory updates from [PR #${params.prNumber}](${params.prUrl})`, ""];

  for (const s of suggestions.add) {
    lines.push(
      `### Add: ${s.context_hint}`,
      "",
      `**Type:** \`${s.type}\``,
      "",
      "**Memory:**",
      "",
      s.content,
      "",
      "**Rationale:**",
      "",
      `> ${s.rationale}`,
      "",
      `**Why this is a memory (not a convention update):** This is a situational pattern that helps the agent in specific contexts, not a permanent rule for all future code.`,
      "",
      s.referenced_files.length > 0
        ? `**Referenced files:** ${s.referenced_files.map((f) => "`" + f + "`").join(", ")}`
        : "",
      "",
      "---",
      "",
    );
  }

  for (const s of suggestions.update) {
    lines.push(
      `### Update: \`${s.id}\``,
      "",
      "**Updated content:**",
      "",
      s.content,
      "",
      "**Rationale:**",
      "",
      `> ${s.rationale}`,
      "",
      "---",
      "",
    );
  }

  for (const s of suggestions.remove) {
    lines.push(`### Remove: \`${s.id}\``, "", "**Rationale:**", "", `> ${s.rationale}`, "", "---", "");
  }

  for (const s of suggestions.convention_updates) {
    lines.push(
      `### Convention update: \`${s.target_file}\` → _${s.section_heading}_`,
      "",
      "**Content:**",
      "",
      s.content,
      "",
      "**Rationale (why this is a permanent convention, not a memory):**",
      "",
      `> ${s.rationale}`,
      "",
      "---",
      "",
    );
  }

  const memoryReview = suggestions.memory_review ?? [];
  if (memoryReview.length > 0) {
    lines.push("### Reviewer memory findings", "");
    for (const finding of memoryReview) {
      const memory = finding.memory_id ? ` \`${finding.memory_id}\`` : "";
      const action = finding.recommended_action ? ` Recommended action: ${finding.recommended_action}` : "";
      lines.push(`- **${finding.finding}**${memory}: ${finding.rationale}${action}`);
    }
    lines.push("", "---", "");
  }

  const candidateAudit = suggestions.candidate_audit ?? [];
  if (candidateAudit.length > 0) {
    lines.push("### Candidate audit", "");
    for (const candidate of candidateAudit) {
      const status = candidate.selected ? "selected" : `rejected: ${candidate.rejection_reason ?? "not selected"}`;
      lines.push(`- **${candidate.lane}** (${status}): ${candidate.lesson}`);
      if (candidate.evidence) lines.push(`  Evidence: ${candidate.evidence}`);
    }
    lines.push("", "---", "");
  }

  lines.push(
    `Sessions: ${params.sessionIds.map((id) => "`" + id + "`").join(", ")}`,
    "",
    "Merge to apply. Close to discard.",
  );

  return lines.join("\n");
}

function extractAnalyzerMemoryReviewFindings(
  evaluatorModel: string,
  rawJson: string | null,
): AnalyzerMemoryReviewFinding[] {
  if (!rawJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  return [
    ...extractAnalyzerMemoryReviewEntries(evaluatorModel, "missed", record.missed),
    ...extractAnalyzerMemoryReviewEntries(evaluatorModel, "incorrect", record.incorrect),
    ...extractAnalyzerMemoryReviewEntries(evaluatorModel, "helpful", record.helpful),
  ];
}

function extractAnalyzerMemoryReviewEntries(
  evaluatorModel: string,
  finding: "missed" | "incorrect" | "helpful",
  value: unknown,
): AnalyzerMemoryReviewFinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const rawId = record.memoryId ?? record.memory_id ?? record.id;
    const memoryId = typeof rawId === "string" && rawId.trim() ? rawId.trim() : null;
    const rationale =
      typeof record.rationale === "string" && record.rationale.trim()
        ? record.rationale.trim()
        : typeof record.reason === "string" && record.reason.trim()
          ? record.reason.trim()
          : "";
    if (!rationale) return [];
    const expectedEffect =
      typeof record.expectedEffect === "string" && record.expectedEffect.trim() ? record.expectedEffect.trim() : null;
    const observedEffect =
      typeof record.observedEffect === "string" && record.observedEffect.trim() ? record.observedEffect.trim() : null;
    return [{ evaluatorModel, finding, memoryId, rationale, expectedEffect, observedEffect }];
  });
}

async function notifySlackMemoryPrCreated(
  env: Env,
  params: TriggerMemoryAnalysisParams,
  suggestions: MemorySuggestions,
  memoryPrUrl: string,
  memoryPrNumber: number,
  log: Logger,
): Promise<void> {
  // Only notify for the main Cycloid repo -- other repos' memory PRs are noise
  if (params.repoOwner !== "trycycloid" || params.repoName !== "cycloid") {
    log.info(
      { repo: `${params.repoOwner}/${params.repoName}`, sourcePrUrl: params.prUrl },
      "Memory PR Slack notification skipped: not trycycloid/cycloid",
    );
    return;
  }

  const token = env.SLACK_BOT_TOKEN;
  const channel = MEMORY_PR_CHANNEL_ID;
  if (!token) {
    log.info(
      { hasSlackToken: !!token, sourcePrUrl: params.prUrl },
      "Memory PR Slack notification skipped: missing config",
    );
    return;
  }

  const summary: string[] = [];
  if (suggestions.add.length > 0) summary.push(`${suggestions.add.length} added`);
  if (suggestions.update.length > 0) summary.push(`${suggestions.update.length} updated`);
  if (suggestions.remove.length > 0) summary.push(`${suggestions.remove.length} removed`);
  if (suggestions.convention_updates.length > 0)
    summary.push(`${suggestions.convention_updates.length} convention updates`);

  const lines = [
    `Memory PR created for \`${params.repoOwner}/${params.repoName}\` <@U0AHT782S65>`,
    `<${memoryPrUrl}|PR #${memoryPrNumber}> from <${params.prUrl}|source PR #${params.prNumber}>`,
  ];
  if (summary.length > 0) {
    lines.push(`Changes: ${summary.join(", ")}`);
  }

  // postInternalAlert swallows throws (returns null) and logs generic metadata;
  // keep the domain-specific success/failure logs here, gated on result?.ok.
  const result = await postInternalAlert(env, channel, lines.join("\n"));
  if (result?.ok) {
    log.info({ channel, sourcePrUrl: params.prUrl, memoryPrUrl }, "Memory PR Slack notification sent");
  } else {
    log.error(
      { channel, sourcePrUrl: params.prUrl, memoryPrUrl, slackError: result?.error ?? null },
      "Memory PR Slack notification failed",
    );
  }
}
