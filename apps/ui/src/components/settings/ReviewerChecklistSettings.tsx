import { useId, useRef, useState } from "react";

import {
  MERGE_CONFLICT_RESOLUTION_DEFAULT_ENABLED,
  PR_REVIEW_BOT_LABELS,
  PR_REVIEW_BOT_OPTIONS,
  type PrReviewExpectedBot,
  type PrReviewKnownBotId,
} from "../../../../../shared/constants/pr-review-bots";
import { fetchPrReviewBotSettings, listPrReviewBotSettings, updatePrReviewBotSettings } from "../../api/settings";
import { useSyncEffect } from "../../hooks/useEffects";
import { CheckIcon, ChevronDownIcon, CloseIcon, PlusIcon } from "../icons";
import { useLayoutContext } from "../Layout";
import { Toggle } from "../Toggle";
import { Button, IconButton, Input, Select } from "../ui";
import { parseRepoFullName } from "./workspaceSettingsShared";

/**
 * Per-repo reviewer checklist: which reviewers Cycloid responds to before it
 * batches a PR response, plus merge-conflict handling.
 *
 * Standalone mode (no `repoFullName`) renders its own repo picker and defaults
 * to the user's default repo. When `repoFullName` is provided the internal
 * picker is hidden and the checklist follows that repo — used by the
 * Repositories page whose page-level picker drives every section.
 */
export function ReviewerChecklistSettings({ repoFullName }: { repoFullName?: string } = {}) {
  const { repos, reposLoaded, settings } = useLayoutContext();
  const isControlled = repoFullName !== undefined;
  const [reviewBotRepo, setReviewBotRepo] = useState("");
  // Effective repo the checklist reads/saves against: the controlling prop when
  // provided, otherwise the internal picker's selection.
  const activeRepo = repoFullName ?? reviewBotRepo;
  const [reviewBotSettings, setReviewBotSettings] = useState<PrReviewExpectedBot[]>([]);
  // Snapshot of what the backend currently has stored for the selected repo. The
  // editable `reviewBotSettings` is diffed against this so the UI can show the
  // true server-side state ("what Cycloid responds to") vs. unsaved local edits.
  const [savedReviewBotSettings, setSavedReviewBotSettings] = useState<PrReviewExpectedBot[]>([]);
  const [mergeConflictResolutionEnabled, setMergeConflictResolutionEnabled] = useState(
    MERGE_CONFLICT_RESOLUTION_DEFAULT_ENABLED,
  );
  const [savedMergeConflictResolutionEnabled, setSavedMergeConflictResolutionEnabled] = useState(
    MERGE_CONFLICT_RESOLUTION_DEFAULT_ENABLED,
  );
  const [reviewBotLoading, setReviewBotLoading] = useState(false);
  const [reviewBotSaving, setReviewBotSaving] = useState(false);
  const [reviewBotError, setReviewBotError] = useState<string | null>(null);
  const [customBotLogin, setCustomBotLogin] = useState("");
  const [customInputOpen, setCustomInputOpen] = useState(false);
  const customBotInputRef = useRef<HTMLInputElement>(null);
  const [customizedReviewRepos, setCustomizedReviewRepos] = useState<Set<string>>(() => new Set());
  // Drives the collapsed checklist summary so it can distinguish "still loading"
  // from "loaded, no customizations" from "the list fetch failed".
  const [customizedReposStatus, setCustomizedReposStatus] = useState<"loading" | "loaded" | "failed">("loading");
  const reviewBotRepoSelectId = useId();
  const customBotInputId = useId();

  useSyncEffect(() => {
    // Controlled mode: the parent owns repo selection, so skip the internal default.
    if (isControlled) return;
    if (!reposLoaded || repos.length === 0) return;
    if (reviewBotRepo && repos.some((repo) => repo.fullName === reviewBotRepo)) return;
    const preferred =
      settings?.defaultRepo && repos.some((repo) => repo.fullName === settings.defaultRepo)
        ? settings.defaultRepo
        : repos[0]!.fullName;
    setReviewBotRepo(preferred);
  }, [isControlled, repos, reposLoaded, reviewBotRepo, settings?.defaultRepo]);

  useSyncEffect(() => {
    let cancelled = false;
    listPrReviewBotSettings()
      .then((payload) => {
        if (cancelled) return;
        setCustomizedReviewRepos(
          new Set(payload.repositories.map((repo) => `${repo.repoOwner}/${repo.repoName}`.toLowerCase())),
        );
        setCustomizedReposStatus("loaded");
      })
      .catch(() => {
        if (cancelled) return;
        setReviewBotError("Failed to load repo customizations.");
        setCustomizedReposStatus("failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useSyncEffect(() => {
    if (!activeRepo) {
      setReviewBotSettings([]);
      setSavedReviewBotSettings([]);
      setMergeConflictResolutionEnabled(MERGE_CONFLICT_RESOLUTION_DEFAULT_ENABLED);
      setSavedMergeConflictResolutionEnabled(MERGE_CONFLICT_RESOLUTION_DEFAULT_ENABLED);
      return;
    }
    const parsed = parseRepoFullName(activeRepo);
    if (!parsed) {
      setReviewBotSettings([]);
      setSavedReviewBotSettings([]);
      setMergeConflictResolutionEnabled(MERGE_CONFLICT_RESOLUTION_DEFAULT_ENABLED);
      setSavedMergeConflictResolutionEnabled(MERGE_CONFLICT_RESOLUTION_DEFAULT_ENABLED);
      setReviewBotError("Selected repository is invalid.");
      return;
    }
    let cancelled = false;
    setReviewBotLoading(true);
    setReviewBotError(null);
    fetchPrReviewBotSettings(parsed.repoOwner, parsed.repoName)
      .then((payload) => {
        if (cancelled) return;
        setReviewBotSettings(payload.expectedBots);
        setSavedReviewBotSettings(payload.expectedBots);
        setMergeConflictResolutionEnabled(
          payload.mergeConflictResolutionEnabled ?? MERGE_CONFLICT_RESOLUTION_DEFAULT_ENABLED,
        );
        setSavedMergeConflictResolutionEnabled(
          payload.mergeConflictResolutionEnabled ?? MERGE_CONFLICT_RESOLUTION_DEFAULT_ENABLED,
        );
      })
      .catch(() => {
        if (cancelled) return;
        // Clear stale state so the failed repo doesn't keep showing the
        // previously-loaded repo's saved bots (which could be saved onto it).
        setReviewBotSettings([]);
        setSavedReviewBotSettings([]);
        setMergeConflictResolutionEnabled(MERGE_CONFLICT_RESOLUTION_DEFAULT_ENABLED);
        setSavedMergeConflictResolutionEnabled(MERGE_CONFLICT_RESOLUTION_DEFAULT_ENABLED);
        setReviewBotError("Failed to load checklist.");
      })
      .finally(() => {
        if (!cancelled) setReviewBotLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRepo]);

  // Focus the custom-login field when it's revealed via the "Custom…" chip.
  useSyncEffect(() => {
    if (customInputOpen) customBotInputRef.current?.focus();
  }, [customInputOpen]);

  // Collapsed-checklist summary: distinguish loading / failed / none / count so
  // the disclosure header tells the user the state without expanding it.
  // `customizedReviewRepos` is the business-wide set of saved per-repo PR
  // customizations; count only the repos the current user can actually see so
  // the numerator can't exceed
  // `repos.length` (e.g. an admin customized repos this member can't view).
  const visibleRepoKeys = new Set(repos.map((repo) => repo.fullName.toLowerCase()));
  const customizedReviewCount = [...customizedReviewRepos].filter((key) => visibleRepoKeys.has(key)).length;
  // Controlled mode (the Repositories page): the page-level picker scopes this
  // box to one repo, so the summary reports that repo's state — a business-wide
  // "N of M repos customized" readout would mismatch the header above it.
  const controlledSummary = !activeRepo ? (
    "Choose a repository first"
  ) : reviewBotLoading ? (
    "Loading…"
  ) : savedReviewBotSettings.length > 0 ? (
    <>
      <span className="numeral">{savedReviewBotSettings.length}</span>{" "}
      {savedReviewBotSettings.length === 1 ? "reviewer" : "reviewers"} selected for this repository
    </>
  ) : (
    "No reviewers selected for this repository"
  );
  const standaloneSummary =
    !reposLoaded || customizedReposStatus === "loading" ? (
      "Loading…"
    ) : customizedReposStatus === "failed" ? (
      "Couldn't load repo customizations"
    ) : customizedReviewCount === 0 ? (
      "No repo-specific PR settings yet"
    ) : (
      <>
        <span className="numeral">{customizedReviewCount}</span> of <span className="numeral">{repos.length}</span>{" "}
        {repos.length === 1 ? "repo" : "repos"} customized
      </>
    );
  const reviewChecklistSummary = isControlled ? controlledSummary : standaloneSummary;

  const selectedKnownBotIds = new Set(
    reviewBotSettings
      .filter((bot): bot is { type: "known"; id: PrReviewKnownBotId } => bot.type === "known")
      .map((bot) => bot.id),
  );
  const unselectedKnownBots = PR_REVIEW_BOT_OPTIONS.filter((bot) => !selectedKnownBotIds.has(bot.id));
  // Backend truth vs. local edits, so the panel can show exactly what Cycloid
  // currently responds to and whether there are unsaved changes.
  const reviewBotsDirty =
    !sameBotSets(reviewBotSettings, savedReviewBotSettings) ||
    mergeConflictResolutionEnabled !== savedMergeConflictResolutionEnabled;
  const savedBotCount = savedReviewBotSettings.length;
  // A repo counts as customized if it has saved bots OR non-default merge-conflict handling,
  // matching the repo dropdown's "· customized" marker.
  const customizedOnServer =
    savedBotCount > 0 || savedMergeConflictResolutionEnabled !== MERGE_CONFLICT_RESOLUTION_DEFAULT_ENABLED;

  function setKnownReviewBot(id: PrReviewKnownBotId, checked: boolean) {
    setReviewBotError(null);
    setReviewBotSettings((previous) => {
      const without = previous.filter((bot) => bot.type !== "known" || bot.id !== id);
      return checked ? [...without, { type: "known", id }] : without;
    });
  }

  function addCustomReviewBot() {
    const inputValue =
      typeof document !== "undefined"
        ? ((document.getElementById(customBotInputId) as HTMLInputElement | null)?.value ?? "")
        : "";
    const login = (customBotLogin || inputValue).trim().toLowerCase();
    if (!login) return;
    setReviewBotError(null);
    setReviewBotSettings((previous) => {
      if (previous.some((bot) => bot.type === "custom" && bot.login === login)) return previous;
      return [...previous, { type: "custom", login }];
    });
    setCustomBotLogin("");
  }

  function removeCustomReviewBot(login: string) {
    setReviewBotSettings((previous) => previous.filter((bot) => bot.type !== "custom" || bot.login !== login));
  }

  function discardReviewBotChanges() {
    setReviewBotError(null);
    setCustomBotLogin("");
    setCustomInputOpen(false);
    setReviewBotSettings(savedReviewBotSettings);
    setMergeConflictResolutionEnabled(savedMergeConflictResolutionEnabled);
  }

  async function saveReviewBotChecklist() {
    const parsed = parseRepoFullName(activeRepo);
    if (!parsed) {
      setReviewBotError("Selected repository is invalid.");
      return;
    }
    setReviewBotSaving(true);
    setReviewBotError(null);
    try {
      const updated = await updatePrReviewBotSettings(parsed.repoOwner, parsed.repoName, {
        expectedBots: reviewBotSettings,
        mergeConflictResolutionEnabled,
      });
      setReviewBotSettings(updated.expectedBots);
      setSavedReviewBotSettings(updated.expectedBots);
      setMergeConflictResolutionEnabled(
        updated.mergeConflictResolutionEnabled ?? MERGE_CONFLICT_RESOLUTION_DEFAULT_ENABLED,
      );
      setSavedMergeConflictResolutionEnabled(
        updated.mergeConflictResolutionEnabled ?? MERGE_CONFLICT_RESOLUTION_DEFAULT_ENABLED,
      );
      setCustomizedReviewRepos((previous) => {
        const next = new Set(previous);
        const key = activeRepo.toLowerCase();
        const nonDefault =
          updated.expectedBots.length > 0 ||
          updated.mergeConflictResolutionEnabled !== MERGE_CONFLICT_RESOLUTION_DEFAULT_ENABLED;
        if (nonDefault) next.add(key);
        else next.delete(key);
        return next;
      });
    } catch (error) {
      setReviewBotError(error instanceof Error ? error.message : "Failed to save checklist.");
    } finally {
      setReviewBotSaving(false);
    }
  }

  return (
    <details className="group mt-4 overflow-hidden border border-border bg-surface-1">
      <summary className="flex cursor-pointer list-none flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-transparent px-4 py-3.5 group-open:border-border [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <p className="eyebrow">Reviewers Cycloid responds to</p>
          <p className="mt-1.5 max-w-[52ch] text-base leading-relaxed text-text-secondary">
            <span className="group-open:hidden">{reviewChecklistSummary}</span>
            <span className="hidden group-open:inline">
              {isControlled
                ? "Pick the reviewers Cycloid responds to on this repository before it batches a response."
                : "Pick the reviewers Cycloid responds to on each repo before it batches a response."}
            </span>
          </p>
          {/* Keep load errors visible while collapsed; the expanded body
                shows the same error in its footer, so hide this when open. */}
          {reviewBotError ? (
            <p role="alert" className="mt-1.5 text-sm text-error group-open:hidden">
              {reviewBotError}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {reviewBotLoading ? (
            <span className="shrink-0 text-sm text-text-muted">Loading…</span>
          ) : reviewBotsDirty ? (
            <span className="shrink-0 text-sm text-text-primary">Unsaved changes</span>
          ) : customizedOnServer ? (
            <span className="shrink-0 text-sm text-text-muted">Saved</span>
          ) : null}
          <ChevronDownIcon className="h-3 w-3 text-text-muted transition-transform group-open:rotate-180" />
        </div>
      </summary>

      <div className="space-y-5 px-4 py-4">
        <div>
          {!isControlled ? (
            <>
              <label htmlFor={reviewBotRepoSelectId} className="eyebrow mb-1.5 block">
                Repository
              </label>
              <Select
                id={reviewBotRepoSelectId}
                value={reviewBotRepo}
                disabled={!reposLoaded || repos.length === 0}
                onChange={(event) => setReviewBotRepo(event.target.value)}
              >
                {repos.length === 0 ? <option value="">No repositories</option> : null}
                {repos.map((repo) => {
                  const customized = customizedReviewRepos.has(repo.fullName.toLowerCase());
                  return (
                    <option key={repo.fullName} value={repo.fullName}>
                      {repo.fullName}
                      {customized ? " · customized" : ""}
                    </option>
                  );
                })}
              </Select>
            </>
          ) : null}
        </div>

        <div>
          <p className="eyebrow mb-2">Add bots</p>
          <div className="flex max-h-[176px] flex-wrap gap-2 overflow-y-auto">
            {unselectedKnownBots.map((bot) => (
              <Button
                key={bot.id}
                type="button"
                onClick={() => setKnownReviewBot(bot.id, true)}
                disabled={reviewBotLoading}
                size="sm"
                variant="secondary"
              >
                <PlusIcon className="h-3.5 w-3.5 text-text-muted" />
                {bot.label}
              </Button>
            ))}
            {!customInputOpen ? (
              <Button
                type="button"
                onClick={() => setCustomInputOpen(true)}
                disabled={reviewBotLoading}
                size="sm"
                variant="secondary"
                className="border-dashed text-text-muted hover:text-text-primary"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                Custom…
              </Button>
            ) : null}
          </div>
          {customInputOpen ? (
            <div className="mt-2 flex items-center gap-2">
              <label htmlFor={customBotInputId} className="sr-only">
                Custom bot login
              </label>
              <Input
                ref={customBotInputRef}
                id={customBotInputId}
                aria-label="Custom bot login"
                value={customBotLogin}
                onChange={(event) => setCustomBotLogin(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addCustomReviewBot();
                  } else if (event.key === "Escape") {
                    setCustomBotLogin("");
                    setCustomInputOpen(false);
                  }
                }}
                disabled={reviewBotLoading}
                controlSize="sm"
                className="min-w-0 flex-1"
                placeholder="github-bot-login"
              />
              <Button
                type="button"
                onClick={addCustomReviewBot}
                disabled={!customBotLogin.trim() || reviewBotLoading}
                size="sm"
                variant="secondary"
              >
                Add
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setCustomBotLogin("");
                  setCustomInputOpen(false);
                }}
                size="sm"
                variant="ghost"
                className="px-2 text-base"
              >
                Cancel
              </Button>
            </div>
          ) : null}
        </div>

        <div>
          <p className="eyebrow mb-2">Selected{reviewBotSettings.length > 0 ? ` · ${reviewBotSettings.length}` : ""}</p>
          {reviewBotSettings.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {reviewBotSettings.map((bot) => {
                const isKnown = bot.type === "known";
                const label = isKnown ? PR_REVIEW_BOT_LABELS[bot.id] : bot.login;
                return (
                  <span
                    key={isKnown ? `known:${bot.id}` : `custom:${bot.login}`}
                    className="inline-flex items-center gap-1 border border-border bg-surface-2 py-0.5 pl-2.5 pr-0.5 text-xs text-text-primary"
                  >
                    <span className={isKnown ? "" : "font-mono-tabular"}>{label}</span>
                    <IconButton
                      label={`Remove ${label}`}
                      size="sm"
                      onClick={() => (isKnown ? setKnownReviewBot(bot.id, false) : removeCustomReviewBot(bot.login))}
                      disabled={reviewBotLoading}
                    >
                      <CloseIcon />
                    </IconButton>
                  </span>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-text-muted">No bots selected yet.</p>
          )}
        </div>

        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="min-w-0">
              <p className="text-base font-medium text-text-primary">Resolve merge conflicts</p>
              <p className="mt-0.5 max-w-[52ch] text-sm leading-relaxed text-text-secondary">
                When GitHub reports textual conflicts, Cycloid opens a review-loop turn to update the branch and resolve
                them.
              </p>
            </div>
            <Toggle
              checked={mergeConflictResolutionEnabled}
              onChange={() => setMergeConflictResolutionEnabled((enabled) => !enabled)}
              disabled={reviewBotLoading || reviewBotSaving}
              label="Resolve merge conflicts"
              showLabel={false}
            />
          </div>
        </div>

        {reviewBotsDirty || customizedOnServer || reviewBotError ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            {reviewBotsDirty ? (
              <>
                <Button
                  type="button"
                  variant="primary"
                  onClick={saveReviewBotChecklist}
                  disabled={!activeRepo || reviewBotSaving || reviewBotLoading}
                >
                  {reviewBotSaving ? "Saving…" : "Save changes"}
                </Button>
                {!reviewBotSaving ? (
                  <Button type="button" variant="ghost" onClick={discardReviewBotChanges} disabled={reviewBotLoading}>
                    Discard
                  </Button>
                ) : null}
              </>
            ) : customizedOnServer ? (
              <p className="inline-flex items-center gap-2 text-sm text-text-muted">
                <CheckIcon className="h-3.5 w-3.5 text-success" />
                Saved
              </p>
            ) : null}
            {reviewBotError ? (
              <p role="alert" className="text-sm text-error">
                {reviewBotError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function reviewBotKey(bot: PrReviewExpectedBot): string {
  return bot.type === "known" ? `known:${bot.id}` : `custom:${bot.login}`;
}

// Order-independent set equality for two expected-bot lists.
function sameBotSets(a: PrReviewExpectedBot[], b: PrReviewExpectedBot[]): boolean {
  if (a.length !== b.length) return false;
  const keysB = new Set(b.map(reviewBotKey));
  return a.every((bot) => keysB.has(reviewBotKey(bot)));
}
