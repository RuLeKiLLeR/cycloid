import { DEFAULT_SESSION_START_MODEL_ID } from "../../../../shared/constants/models.js";
import { wrapUserContent } from "../../../../shared/utils/prompt-safety.js";
import { InitiationMode } from "../enums/initiation-mode.js";
import { SessionEntrypoint } from "../enums/session-entrypoint.js";
import { createLogger } from "../logger";
import { gateGithubSessionStart } from "../services/integration-gating";
import { initializeAndProjectSession } from "../services/session-create";
import { resolveBaseModelForAutomaticRouting } from "../services/session-model-routing";
import { buildSyncRichStatusStatement } from "../session/db";
import { enqueueSessionPrompt, listSessionPrompts } from "../session/state";
import type { Env, InternalAuthContext } from "../types";
import {
  getGithubCheckRule,
  leaseGithubCheckJob,
  listDueGithubCheckJobs,
  updateGithubCheckJob,
} from "./github-check-db";
const log = createLogger({ bindings: { component: "github-check-automation" } });
export async function githubCheckAutomationTick(
  env: Env,
  options: { now?: () => number; limit?: number } = {},
): Promise<void> {
  const now = options.now?.() ?? Date.now();
  for (const job of await listDueGithubCheckJobs(env.DB, now, options.limit ?? 10)) {
    const leaseOwner = await leaseGithubCheckJob(env.DB, job.id, now);
    if (!leaseOwner) continue;
    const rule = await getGithubCheckRule(env.DB, job.businessId, job.ruleId);
    if (!rule || !rule.enabled) {
      await updateGithubCheckJob(env.DB, {
        id: job.id,
        phase: "skipped",
        sessionId: null,
        reason: "rule_disabled",
        now,
        leaseOwner,
      });
      continue;
    }
    const sessionId = job.sessionId ?? job.id;
    try {
      const auth: InternalAuthContext = {
        userId: rule.configuredByUserId,
        businessId: rule.businessId,
        canAccessAllSessions: false,
      };
      if (job.phase === "prompt_enqueued") {
        await updateGithubCheckJob(env.DB, {
          id: job.id,
          phase: "succeeded",
          sessionId,
          reason: null,
          now,
          leaseOwner,
        });
        continue;
      }
      if (job.phase !== "session_projected") {
        const gate = await gateGithubSessionStart(env, {
          userId: rule.configuredByUserId,
          businessId: rule.businessId,
          sessionId: job.id,
          repoOwner: rule.repoOwner,
          repoName: rule.repoName,
        });
        if (!gate.ok) {
          await updateGithubCheckJob(env.DB, {
            id: job.id,
            phase: "failed",
            sessionId: null,
            reason: `repo_gate_${gate.body.reasonCode}`,
            now,
            leaseOwner,
          });
          continue;
        }
        const model = resolveBaseModelForAutomaticRouting(rule.modelId ?? DEFAULT_SESSION_START_MODEL_ID);
        await initializeAndProjectSession(env, {
          sessionId,
          ownerUserId: rule.configuredByUserId,
          sessionKind: "repo",
          repoContext: { repoOwner: rule.repoOwner, repoName: rule.repoName },
          auth,
          installationId: gate.installationId,
          model: model.currentModel,
          reasoningEffort: null,
          projectionSource: "automation.github-check",
          projectionUserId: rule.configuredByUserId,
          initiationMode: InitiationMode.AUTOMATION,
          entrypoint: SessionEntrypoint.GITHUB_CHECK_AUTOMATION,
        });
        if (
          !(await updateGithubCheckJob(env.DB, {
            id: job.id,
            phase: "session_projected",
            sessionId,
            reason: null,
            now,
            leaseOwner,
          }))
        )
          continue;
      }
      const context = wrapUserContent(
        JSON.stringify({ pullRequest: job.prNumber, headSha: job.headSha, checkName: job.checkName }),
        "github_failed_check",
        "GitHub check event",
      );
      const prompt = `${rule.promptTemplate}\n\n${context}`;
      const existingPrompts = await listSessionPrompts(env, sessionId, { auth });
      const alreadyEnqueued =
        existingPrompts.ok &&
        existingPrompts.payload?.prompts.some(
          (item) => item.actorUserId === rule.configuredByUserId && item.prompt === prompt,
        );
      const result = alreadyEnqueued
        ? { ok: true as const }
        : await enqueueSessionPrompt(env, sessionId, prompt, rule.configuredByUserId, { auth });
      if (!result.ok) {
        await buildSyncRichStatusStatement(env.DB, sessionId, "failed").statement.run();
      } else if (
        !(await updateGithubCheckJob(env.DB, {
          id: job.id,
          phase: "prompt_enqueued",
          sessionId,
          reason: null,
          now,
          leaseOwner,
        }))
      ) {
        continue;
      }
      await updateGithubCheckJob(env.DB, {
        id: job.id,
        phase: result.ok ? "succeeded" : "failed",
        sessionId,
        reason: result.ok ? null : `enqueue_${result.status}`,
        now,
        leaseOwner,
      });
    } catch (error) {
      log.error({ jobId: job.id, error: String(error) }, "github_check_automation_dispatch_failed");
      try {
        await buildSyncRichStatusStatement(env.DB, sessionId, "failed").statement.run();
      } catch (cleanupError) {
        log.error(
          { jobId: job.id, sessionId, error: String(cleanupError) },
          "github_check_automation_orphan_cleanup_failed",
        );
      }
      await updateGithubCheckJob(env.DB, {
        id: job.id,
        phase: "failed",
        sessionId,
        reason: "dispatch_failed",
        now,
        leaseOwner,
      });
    }
  }
}
