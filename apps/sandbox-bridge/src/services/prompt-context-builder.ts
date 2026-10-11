import type { DiagnosticEntry } from "../../../../shared/types/sandbox.js";
import { normalizePromptActorUserId } from "../../../../shared/utils/prompt-safety.js";
import {
  formatDiagnosticsReminder,
  type MeasuredSystemContextSection,
  measureSystemContextSections,
  type PromptSystemContextPhase,
  type SystemContextCadence,
  type SystemContextSection,
} from "../utils/system-context.js";

/**
 * A per-prompt one-shot system context section assembled before the builder
 * runs: profile index guidance, resolved skill directives, file-attachment
 * directives, and the workspace-dependency-setup notice. These are passed in
 * explicitly; the builder never reads them off bridge instance state.
 */
export type PendingSystemContextSection = {
  name: string;
  content: string;
  cadence: SystemContextCadence;
};

export type BuiltSystemContext = {
  text: string | undefined;
  promptPhase: PromptSystemContextPhase;
  sections: MeasuredSystemContextSection[];
  totalTokenCountEstimate: number;
};

export type RequestingUserIdentityInput = {
  /** Raw `GIT_AUTHOR_NAME` (not yet trimmed). */
  gitAuthorName: string | undefined;
  /** Raw `OWNER_USER_ID`. */
  ownerUserId: string | undefined;
  /** Raw current-prompt actor user ID (`this.currentPromptActorUserId`). */
  promptActorUserId: string | null;
};

export type RequestingUserIdentityResult = {
  section: string | undefined;
  /**
   * Set to the raw actor ID when one was provided but failed normalization, so
   * the caller can emit the existing "Skipping invalid current prompt actor
   * user ID" warning. The builder itself performs no logging or other side
   * effects.
   */
  invalidPromptActorUserId: string | null;
};

export type BuildSystemContextInput = {
  hasSentPromptInCurrentSession: boolean;
  identity: RequestingUserIdentityInput;
  /** Profile guidance, skill directives, file-attachment directives, and workspace-setup notice, in order. */
  perPromptSections: readonly PendingSystemContextSection[];
  /** Diagnostics accumulated since the previous turn (consumed once by the caller). */
  pendingDiagnostics: readonly DiagnosticEntry[];
};

export type BuildSystemContextResult = {
  systemContext: BuiltSystemContext;
  invalidPromptActorUserId: string | null;
};

/**
 * Build the `file_attachment_directives` section body from user-selected paths.
 * The paths are pointers, not content; the agent reads them with its own tools.
 */
export function buildFileAttachmentsSection(files: readonly string[]): string {
  const lines = files.map((f) => `- ${f}`);
  return [
    "<attached_files>",
    "The user has pointed you at these files/directories as relevant context.",
    "Use your Read, Grep, and Glob tools to examine them as needed.",
    "",
    ...lines,
    "</attached_files>",
  ].join("\n");
}

/**
 * Build the requesting-user-identity section. Pure: identity inputs are passed
 * in (not read from `process.env`/instance state) so callers and tests control
 * them directly. Invalid actor IDs are reported via the result instead of being
 * logged here.
 */
export function buildRequestingUserIdentitySection(input: RequestingUserIdentityInput): RequestingUserIdentityResult {
  const authorName = input.gitAuthorName?.trim();
  const ownerUserId = normalizePromptActorUserId(input.ownerUserId);
  const promptActorUserId = normalizePromptActorUserId(input.promptActorUserId);
  const invalidPromptActorUserId = input.promptActorUserId && !promptActorUserId ? input.promptActorUserId : null;

  const hasDistinctPromptActor = !!promptActorUserId && !!ownerUserId && promptActorUserId !== ownerUserId;
  const hasPromptActorWithoutOwner = !!promptActorUserId && !ownerUserId;

  if (!authorName && !hasDistinctPromptActor && !hasPromptActorWithoutOwner) {
    return { section: undefined, invalidPromptActorUserId };
  }

  const lines = ["# Requesting user identity", ""];
  if (authorName) {
    const identityRole =
      hasDistinctPromptActor || hasPromptActorWithoutOwner ? "session owner's identity" : "requesting user's identity";
    lines.push(`Treat "${authorName}" as the ${identityRole} unless the task explicitly indicates otherwise.`);
  }
  if (hasDistinctPromptActor) {
    lines.push(`The current prompt was submitted by Cycloid user ID ${promptActorUserId}, not by the session owner.`);
  } else if (hasPromptActorWithoutOwner) {
    lines.push(
      `The current prompt was submitted by Cycloid user ID ${promptActorUserId}; OWNER_USER_ID is unavailable, so the session owner comparison could not be verified.`,
    );
  }
  return { section: lines.join("\n"), invalidPromptActorUserId };
}

/**
 * Assemble the composite system context from explicit inputs (identity,
 * per-prompt sections, diagnostics) and measure it.
 *
 * Pure: no event emission, no `process.env` reads, no instance state. The
 * caller owns the one-shot drain (clearing `pendingDiagnostics`, not re-passing
 * `perPromptSections`) so a dispatch failure/retry never silently loses
 * diagnostics or per-prompt directives.
 */
export function buildSystemContext(input: BuildSystemContextInput): BuildSystemContextResult {
  const sections: SystemContextSection[] = [];
  const promptPhase: PromptSystemContextPhase = input.hasSentPromptInCurrentSession ? "followup" : "initial";

  const identity = buildRequestingUserIdentitySection(input.identity);
  if (identity.section) {
    sections.push({ name: "requesting_user_identity", content: identity.section, promptPhase, cadence: "conditional" });
  }

  // Per-prompt sections (profile guidance, skills, attached files, workspace-setup notice).
  for (const section of input.perPromptSections) {
    sections.push({ ...section, promptPhase });
  }

  // Diagnostics feedback from the previous turn.
  if (input.pendingDiagnostics.length > 0) {
    const diagSection = formatDiagnosticsReminder([...input.pendingDiagnostics]);
    if (diagSection) {
      sections.push({ name: "diagnostics_reminder", content: diagSection, promptPhase, cadence: "conditional" });
    }
  }

  return {
    systemContext: { promptPhase, ...measureSystemContextSections(sections) },
    invalidPromptActorUserId: identity.invalidPromptActorUserId,
  };
}
