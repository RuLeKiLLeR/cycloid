import { redact, redactObject, truncate } from "../../../../../shared/observability/redact.js";
import type { BridgeLogger } from "../../logger.js";
import { execRepoGitSync } from "./exec.js";
import type { GitOperationsConfig, RepoSnapshot, TimelineRecorder } from "./types.js";

export function readCurrentGitState(cwd: string, promptLog: BridgeLogger): { branch?: string; commitSha?: string } {
  try {
    const branch = execRepoGitSync(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
    }).trim();
    const commitSha = readHeadSha(cwd);
    return { branch, commitSha };
  } catch (err) {
    promptLog.warn({ error: String(err) }, "Failed to get git info");
    return {};
  }
}

export function readHeadSha(cwd: string): string {
  return execRepoGitSync(["rev-parse", "HEAD"], {
    cwd,
  }).trim();
}

export function captureRepoSnapshot(cwd: string, promptLog: BridgeLogger): RepoSnapshot {
  const { commitSha } = readCurrentGitState(cwd, promptLog);
  let porcelain = "";
  try {
    porcelain = execRepoGitSync(["status", "--porcelain"], {
      cwd,
    }).trim();
  } catch (err) {
    promptLog.warn({ error: String(err) }, "Failed to capture git porcelain");
  }
  return { headSha: commitSha, porcelain };
}

export function didRepoProgress(startSnapshot: RepoSnapshot, endSnapshot: RepoSnapshot): boolean {
  const headChanged =
    startSnapshot.headSha != null && endSnapshot.headSha != null && startSnapshot.headSha !== endSnapshot.headSha;
  return headChanged || startSnapshot.porcelain !== endSnapshot.porcelain;
}

export function createTimelineRecorder(
  config: Pick<GitOperationsConfig, "sandboxId" | "sendEvent">,
  promptLog: BridgeLogger,
  messageId: string,
): TimelineRecorder {
  const entries: TimelineRecorder["entries"] = [];

  return {
    entries,
    record: (eventType, status, summary, metadata) => {
      const timestamp = Date.now();
      const entry = {
        eventType,
        source: "observed" as const,
        observer: "sandbox_bridge" as const,
        status,
        summary: truncate(redact(summary), 240),
        promptId: messageId,
        timestampMs: timestamp,
        ...(metadata ? { metadata: redactObject(metadata) } : {}),
      };
      entries.push(entry);
      try {
        config.sendEvent({
          type: "agent_timeline",
          ...entry,
          messageId,
          sandboxId: config.sandboxId,
          timestamp,
        });
      } catch (err) {
        promptLog.warn({ error: String(err), eventType, status }, "Failed to emit agent_timeline event");
      }
    },
  };
}
