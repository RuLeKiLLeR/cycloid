import type { ExecutionVerification, PrReadinessEvidence } from "../../../../shared/types/sandbox.js";
import { appendPrDedupMarker } from "../github/pr-dedup-marker";
import type { Logger } from "../logger";
import { resolvePublicAppBaseUrl } from "../services/public-url";
import type { Env } from "../types";
import * as doDb from "./do-db.js";
import {
  appendScheduledRunFooter,
  appendSessionLink,
  buildPrBody,
  preserveImplementationSummary,
  preservePrEvidenceSections,
  stripCycloidCoAuthorTrailer,
} from "./pr-body.js";
import type { SessionPrWorkflowExt } from "./pr-github-ops.js";

export const LATEST_PR_BODY_STORAGE_KEY = "pr_body:latest";

const MAX_FAILED_COMMANDS_IN_COMMENT = 5;
const MAX_FAILED_COMMAND_OUTPUT_CHARS = 8_000;

type PrBodyAssemblerHost = {
  readonly state: { storage: DurableObjectStorage };
  readonly env: Env;
  readonly log: Logger;
};

/**
 * Owns PR-body composition for the publish workflow: section assembly,
 * evidence/summary preservation across republish, the dedup marker, and the
 * remembered previous body in DO storage.
 */
export class PrBodyAssembler {
  constructor(
    private readonly sql: SqlStorage,
    private readonly host: PrBodyAssemblerHost,
  ) {}

  async composePrBody(
    ext: SessionPrWorkflowExt | null,
    body: string,
    verification: ExecutionVerification | undefined,
    readiness: PrReadinessEvidence | undefined,
    sessionId: string,
    promptId: string | undefined,
  ): Promise<string> {
    const session = doDb.getSession(this.sql, sessionId);
    const composedBody = appendScheduledRunFooter(
      appendSessionLink(
        buildPrBody(ext, body, verification, readiness),
        sessionId,
        resolvePublicAppBaseUrl(this.host.env),
      ),
      ext,
      session?.createdAt ?? null,
    );
    const previousBody = await this.host.state.storage.get<string>(LATEST_PR_BODY_STORAGE_KEY);
    const prompt = promptId ? doDb.getPrompt(this.sql, promptId) : null;
    const isAutomatedEpochRun = Boolean(prompt?.reviewLoopEpochId?.trim());
    const withPreservedSummary = preserveImplementationSummary(composedBody, previousBody, isAutomatedEpochRun);
    const withPreservedEvidence = stripCycloidCoAuthorTrailer(
      preservePrEvidenceSections(withPreservedSummary, previousBody),
    );
    // ARC-1014: embed the deterministic dedup marker after evidence-section merge
    // so it is present on both create and update writes, making it the recovery
    // anchor for `findOpenPr`.
    return appendPrDedupMarker(withPreservedEvidence, sessionId, promptId);
  }

  async rememberPrBody(sessionId: string, body: string): Promise<void> {
    try {
      await this.host.state.storage.put(LATEST_PR_BODY_STORAGE_KEY, body);
    } catch (err) {
      this.host.log.warn({ sessionId, error: String(err) }, "Failed to remember latest PR body");
    }
  }
}

// ---------------------------------------------------------------------------
// Failed-verification comment rendering (pure)
// ---------------------------------------------------------------------------

export function shouldRenderFailedVerificationComment(
  verification: ExecutionVerification | null | undefined,
  failedCommands: PrReadinessEvidence["commandsRun"],
): boolean {
  return Boolean(
    verification && (failedCommands.length > 0 || collectVerboseVerificationDiagnostics(verification).length > 0),
  );
}

export function buildFailedVerificationComment(
  verification: ExecutionVerification | null | undefined,
  evidence: PrReadinessEvidence | null | undefined,
): string | undefined {
  const failedCommands = (evidence?.commandsRun ?? []).filter(
    (command) => command.source === "post_execution" && command.status === "error" && command.command.trim().length > 0,
  );
  const diagnostics = verification ? collectVerboseVerificationDiagnostics(verification) : [];
  if (!shouldRenderFailedVerificationComment(verification, failedCommands)) return undefined;

  const shownCommands = failedCommands.slice(0, MAX_FAILED_COMMANDS_IN_COMMENT);
  const lines = [
    "<!-- cycloid:failed-verification -->",
    diagnostics.length > 0 && failedCommands.length === 0
      ? "## Verification Diagnostic Details"
      : "## Failed Command Details",
    "",
    verification?.verdict === "CONFIRMED"
      ? "Functional verification was confirmed by other proof; verbose diagnostic details are kept out of the PR body so the review summary stays short."
      : "Cycloid opened this PR for manual review because verification needs human attention.",
  ];

  const explanation = verification?.explanation?.trim();
  if (explanation && !looksLikeVerboseVerificationDetail(explanation)) lines.push("", `Reason: ${explanation}`);

  if (shownCommands.length > 0) {
    lines.push("", "Raw command details are kept out of the PR body so the review summary stays short.");
  }

  shownCommands.forEach((command, index) => {
    const output = boundedCommandOutput(command.failureOutput ?? command.summary ?? "No stderr/output was captured.");
    const result = command.summary?.trim();
    lines.push(
      "",
      `<details${index === 0 ? " open" : ""}>`,
      `<summary><code>${escapeHtml(command.command)}</code> failed</summary>`,
      "",
      ...(command.check ? [`- Check: \`${command.check}\``] : []),
      ...(typeof command.exitCode === "number" ? [`- Exit code: \`${command.exitCode}\``] : []),
      ...(result ? [`- Result: ${escapeHtml(result)}`] : []),
      "",
      "Captured stderr/output:",
      "",
      fencedTextBlock(output),
      "",
      "</details>",
    );
  });

  if (failedCommands.length > shownCommands.length) {
    lines.push("", `Omitted ${failedCommands.length - shownCommands.length} additional failed command(s).`);
  }

  if (diagnostics.length > 0) {
    if (failedCommands.length > 0) lines.push("", "## Verification Diagnostic Details");
    lines.push(
      "",
      "Detailed runtime diagnostics were withheld from the PR comment because they may contain sensitive startup or application log data.",
    );
  }

  return lines.join("\n");
}

export function collectVerboseVerificationDiagnostics(
  verification: ExecutionVerification,
): Array<{ label: string; value: string }> {
  const entries: Array<{ label: string; value: string }> = [];
  const addEntries = (label: string, values: readonly string[] | undefined) => {
    for (const value of values ?? []) {
      const trimmed = value.trim();
      if (trimmed && looksLikeVerboseVerificationDetail(trimmed)) entries.push({ label, value: trimmed });
    }
  };

  addEntries("Caveat", verification.caveats);
  addEntries("Note", verification.notes);
  addEntries("Publish warning", verification.publishWarnReasons);
  if (verification.manualReviewReason?.trim() && looksLikeVerboseVerificationDetail(verification.manualReviewReason)) {
    entries.push({ label: "Manual review reason", value: verification.manualReviewReason.trim() });
  }
  if (verification.explanation?.trim() && looksLikeVerboseVerificationDetail(verification.explanation)) {
    entries.push({ label: "Verification explanation", value: verification.explanation.trim() });
  }

  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.label}:${entry.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function looksLikeVerboseVerificationDetail(text: string): boolean {
  return (
    text.length > 500 ||
    /[\r\n]/.test(text) ||
    /\b(?:Browser logs|Call log|Command failed:|Docker preview command failed|node:internal|Traceback|Captured stderr\/output)\b/i.test(
      text,
    ) ||
    /<launching>|<launched>|\[pid=\d+\]/i.test(text)
  );
}

function boundedCommandOutput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_FAILED_COMMAND_OUTPUT_CHARS) return trimmed;
  const omitted = trimmed.length - MAX_FAILED_COMMAND_OUTPUT_CHARS;
  return `[truncated ${omitted} chars]\n${trimmed.slice(-MAX_FAILED_COMMAND_OUTPUT_CHARS)}`;
}

function fencedTextBlock(value: string): string {
  const longestFence = Math.max(2, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestFence + 1);
  return `${fence}text\n${value}\n${fence}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
