import type { Logger } from "../logger";
import * as doDb from "./do-db.js";
import type { GithubPrOperations, ResolvedPrUpdateContext } from "./pr-github-ops.js";
import { decidePrTitleReconcileAction, validateProposedPrTitle } from "./pr-title.js";

/**
 * Result of an agent-proposed PR title application (`applyProposedPrTitle`).
 *
 * `queued`: no PR exists yet, so the title was persisted as the desired session
 * title for `resolvePrTitle` to apply at PR creation (the PR is born compliant)
 * rather than rejected.
 */
export type ApplyProposedPrTitleResult =
  | { ok: true; outcome: "applied" | "noop" | "queued" }
  | { ok: false; outcome: "skipped_manual_rename" | "invalid" | "error"; error: string };

/**
 * Owns PR title reconciliation: the publish-path "human rename wins" baseline
 * logic and the agent-initiated `update_pr_title` application path.
 */
export class PrTitleReconciler {
  constructor(
    private readonly sql: SqlStorage,
    private readonly log: Logger,
    private readonly github: GithubPrOperations,
    // ARC-1330 D-50A — the post-title-change `onPrMetadataChanged` hook was removed with the managed
    // verification comment (its sole consumer).
  ) {}

  async applyResolvedTitle(
    sessionId: string,
    context: ResolvedPrUpdateContext,
    prNumber: number,
    resolvedTitle: string,
    lastApplied: string | null,
    opts: { created: boolean },
  ): Promise<void> {
    if (opts.created) {
      // Born compliant: record the baseline so future republishes can detect a
      // human rename without an unnecessary live-title read.
      doDb.updateSessionFields(this.sql, sessionId, { prTitleLastApplied: resolvedTitle });
      return;
    }

    await this.reconcilePrTitle(sessionId, context, prNumber, resolvedTitle, lastApplied);
  }

  async applyDeferredGeneratedTitle(
    sessionId: string,
    context: ResolvedPrUpdateContext,
    prNumber: number,
    deterministicTitle: string,
    generatedTitle: string,
  ): Promise<void> {
    doDb.updateSessionFields(this.sql, sessionId, { prTitleLastApplied: deterministicTitle });
    await this.reconcilePrTitle(sessionId, context, prNumber, generatedTitle, deterministicTitle, {
      persistResolvedAsCanonical: true,
    });
  }

  /**
   * Publish-time reconciliation ("human rename wins"). There is an inherent
   * read-then-write window; a human rename landing inside that window can still
   * be overwritten (documented limitation, no GitHub conditional-update API).
   * The PATCH-then-persist pair is not atomic: if the DO crashes after the PATCH
   * but before persisting the baseline, the next publish sees
   * `liveTitle === resolvedTitle` and re-adopts the baseline (see
   * `decidePrTitleReconcileAction`), so the stale baseline self-heals instead of
   * freezing all future title updates as a phantom "human rename".
   */
  private async reconcilePrTitle(
    sessionId: string,
    context: ResolvedPrUpdateContext,
    prNumber: number,
    resolvedTitle: string,
    lastApplied: string | null,
    opts: { persistResolvedAsCanonical?: boolean } = {},
  ): Promise<void> {
    try {
      const liveTitle = await this.github.getPrTitle(context);
      const action = decidePrTitleReconcileAction(liveTitle, lastApplied, resolvedTitle);

      switch (action.kind) {
        case "adopt_baseline":
          // Legacy/untracked PR: adopt the current live title as the baseline
          // and leave the title unchanged this publish.
          if (opts.persistResolvedAsCanonical && action.baseline === resolvedTitle) {
            this.persistAppliedPrTitle(sessionId, resolvedTitle);
          } else {
            doDb.updateSessionFields(this.sql, sessionId, { prTitleLastApplied: action.baseline });
          }
          return;
        case "skip_manual_rename":
          this.log.info(
            {
              event: "pr_title_update_skipped_manual_rename",
              reason: "live_title_diverged_from_last_applied",
              sessionId,
              prNumber,
            },
            "Skipping PR title update: PR was renamed outside Cycloid",
          );
          return;
        case "apply":
          await this.github.updatePrTitle(context, action.title);
          if (opts.persistResolvedAsCanonical) {
            this.persistAppliedPrTitle(sessionId, action.title);
          } else {
            doDb.updateSessionFields(this.sql, sessionId, { prTitleLastApplied: action.title });
          }
          this.log.info(
            { event: "pr_title_updated", reason: "republish_title_changed", sessionId, prNumber },
            "Updated PR title on republish",
          );
          return;
        case "noop":
          if (opts.persistResolvedAsCanonical) {
            this.persistAppliedPrTitle(sessionId, resolvedTitle);
          }
          return;
      }
    } catch (error) {
      this.log.warn(
        { event: "pr_title_reconcile_failed", sessionId, prNumber, error: String(error) },
        "PR title reconcile failed; leaving PR title unchanged",
      );
    }
  }

  /**
   * Apply an agent-proposed PR title (via the `update_pr_title` dynamic tool).
   *
   * Unlike the publish-path `reconcilePrTitle`, this path is agent-initiated and
   * synchronous, so it must surface GitHub read/PATCH failures as an explicit
   * `error` outcome instead of swallowing them — the agent needs to learn the
   * title was not applied.
   *
   * It reuses the shared `decidePrTitleReconcileAction` ("human rename wins")
   * for tracked PRs, with one deliberate difference: a null baseline
   * (legacy/untracked PR) APPLIES the proposed title rather than adopting the
   * live title. Session ownership is already proven by sandbox auth and the
   * agent only proposes a title in response to a failing title check, so the
   * current title is known-bad and should be replaced.
   *
   * On apply (and on a "already compliant" no-op) it persists BOTH the reconcile
   * baseline and the canonical desired title (`ext.title`, which `resolvePrTitle`
   * reads). Without updating the desired title, the next `publishSessionResult`
   * would recompute the original title and overwrite the agent's compliant one,
   * re-breaking the title check on the next push.
   */
  async applyProposedPrTitle(sessionId: string, rawTitle: unknown): Promise<ApplyProposedPrTitleResult> {
    const validation = validateProposedPrTitle(rawTitle);
    if (!validation.ok) {
      return { ok: false, outcome: "invalid", error: validation.error };
    }
    const proposedTitle = validation.title;

    const ext = doDb.getSessionExtended(this.sql, sessionId);
    if (!ext) {
      // No session row to persist against — `updateSession` would be a silent
      // no-op, so surface an explicit error instead of a false `queued` success.
      return { ok: false, outcome: "error", error: "Session not found." };
    }
    if (!ext.prNumber) {
      // No PR exists yet — typically the agent proposes a title during the first
      // turn, before the post-execution publish opens the PR. Persist it as the
      // canonical desired title (read by `resolvePrTitle`) so the PR opens with
      // it, instead of discarding the proposal and forcing a later title-check
      // failure + review-loop round-trip. Do NOT set `prTitleLastApplied`: that
      // baseline tracks the live GitHub title and is established at PR creation.
      doDb.updateSession(this.sql, sessionId, { title: proposedTitle });
      this.log.info(
        { event: "pr_title_queued_pending_pr", source: "agent_tool", sessionId },
        "Queued agent-proposed PR title as desired title (no PR open yet)",
      );
      return { ok: true, outcome: "queued" };
    }

    const context = await this.github.resolvePrUpdateContext(sessionId);
    if (!context) {
      this.log.warn(
        { event: "pr_title_update_context_unavailable", sessionId, prNumber: ext.prNumber },
        "Cannot apply agent-proposed PR title: PR update context unavailable",
      );
      return { ok: false, outcome: "error", error: "Pull request context is unavailable." };
    }

    const lastApplied = ext.prTitleLastApplied ?? null;

    let action: ReturnType<typeof decidePrTitleReconcileAction>;
    if (lastApplied === null) {
      // Null-baseline (legacy/untracked) PR: apply unconditionally. The current
      // title is known-bad and the live value is not needed for the decision, so
      // skip the GitHub read — it would only add a round-trip and a spurious 502
      // when the read transiently fails but the PATCH would have succeeded.
      action = { kind: "apply", title: proposedTitle };
    } else {
      let liveTitle: string;
      try {
        liveTitle = await this.github.getPrTitle(context);
      } catch (error) {
        this.log.warn(
          { event: "pr_title_update_read_failed", sessionId, prNumber: context.prNumber, error: String(error) },
          "Failed to read live PR title for agent-proposed update",
        );
        return { ok: false, outcome: "error", error: "Failed to read the current PR title from GitHub." };
      }
      action = decidePrTitleReconcileAction(liveTitle, lastApplied, proposedTitle);
    }

    switch (action.kind) {
      case "skip_manual_rename":
        this.log.info(
          {
            event: "pr_title_update_skipped_manual_rename",
            source: "agent_tool",
            sessionId,
            prNumber: context.prNumber,
          },
          "Skipping agent-proposed PR title: PR was renamed outside Cycloid",
        );
        return {
          ok: false,
          outcome: "skipped_manual_rename",
          error: "The PR was renamed by a human; Cycloid will not override it.",
        };
      case "noop":
      case "adopt_baseline":
        // Live title already equals the proposed title. Persist the baseline and
        // desired title so a later republish stays a no-op, and report success.
        this.persistAppliedPrTitle(sessionId, proposedTitle);
        return { ok: true, outcome: "noop" };
      case "apply":
        try {
          await this.github.updatePrTitle(context, action.title);
        } catch (error) {
          this.log.warn(
            { event: "pr_title_update_patch_failed", sessionId, prNumber: context.prNumber, error: String(error) },
            "Failed to apply agent-proposed PR title to GitHub",
          );
          return { ok: false, outcome: "error", error: "Failed to update the PR title on GitHub." };
        }
        this.persistAppliedPrTitle(sessionId, action.title);
        this.log.info(
          { event: "pr_title_updated", source: "agent_tool", sessionId, prNumber: context.prNumber },
          "Applied agent-proposed PR title",
        );
        return { ok: true, outcome: "applied" };
    }
  }

  /**
   * Persist an applied PR title as BOTH the reconcile baseline
   * (`pr_title_last_applied`) and the canonical desired title (`title`, read by
   * `resolvePrTitle`). Updating only the baseline would let the next publish
   * regenerate and overwrite the agent's title.
   */
  private persistAppliedPrTitle(sessionId: string, title: string): void {
    // `pr_title_last_applied` lives in session_extended; the canonical session
    // title (read by `resolvePrTitle`) lives in the session table.
    doDb.updateSessionFields(this.sql, sessionId, { prTitleLastApplied: title });
    doDb.updateSession(this.sql, sessionId, { title });
  }
}
