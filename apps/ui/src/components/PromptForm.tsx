import type React from "react";
import { forwardRef, useCallback, useId, useImperativeHandle, useMemo, useRef, useState } from "react";

import { extractGithubPullRequestUrls, normalizeGithubPullRequestUrl } from "../../../../shared/agent/verify-directive";
import { ALLOWED_IMAGE_MEDIA_TYPES, UPLOADED_FILE_EXTENSIONS } from "../../../../shared/constants/uploads";
import { parseLeadingSkillCommands } from "../../../../shared/skills/index";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { useSyncEffect } from "../hooks/useEffects";
import { buildSubmitPayload, parseAtTokens } from "../utils/prompt-form";
import { ChatPromptFormView, DefaultPromptFormView } from "./prompt-form/PromptFormViews";
import type { PromptFormProps } from "./prompt-form/types";
import { usePromptAttachments } from "./prompt-form/usePromptAttachments";
import { usePromptAutocomplete } from "./prompt-form/usePromptAutocomplete";
import { usePromptComposerState } from "./prompt-form/usePromptComposerState";
import { usePromptWarmup } from "./prompt-form/usePromptWarmup";
import { isSubmitKeydown } from "./prompt-form/utils";

export type { PromptFormProps };

export type PromptFormHandle = {
  submitPrompt: (prompt: string) => Promise<void>;
};

// Max auto-grow height for the prompt textarea (px) before it starts scrolling.
const TEXTAREA_MAX_HEIGHT_PX = 192;

export const PromptForm = forwardRef<PromptFormHandle, PromptFormProps>(function PromptForm(
  {
    lifecycle,
    onSubmit,
    onWarm,
    loadFiles,
    loadSkills,
    disabled: externalDisabled,
    placeholder: customPlaceholder,
    reasoningEfforts,
    defaultReasoningEffort,
    submitDisabledReason,
    busyLabel,
    initialValue,
    variant = "default",
    leadingChips,
    leadingActions,
    matchChatPadding = false,
    planModeAvailable = false,
    planMode,
    onTogglePlanMode,
    takeoverRepoUrl,
  },
  ref,
) {
  const sendTooltipId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Synchronous double-submit guard. `isSubmitting` state is async, so the
  // closure can still read `false` for a second submit fired during the
  // pre-submit cache awaits; the ref flips immediately.
  const submitInFlightRef = useRef(false);
  const { warmWithReasoningEffort, resetWarmup } = usePromptWarmup({ phase: lifecycle.phase, onWarm });

  const composer = usePromptComposerState({
    lifecycle,
    externalDisabled,
    customPlaceholder,
    reasoningEfforts,
    defaultReasoningEffort,
    submitDisabledReason,
    isSubmitting,
    busyLabel,
    warmWithReasoningEffort,
    resetWarmup,
    initialValue,
    planMode,
  });
  const detectedTakeoverPrUrl = useMemo(() => {
    if (!takeoverRepoUrl) return null;
    let repoPath: string;
    try {
      repoPath = new URL(takeoverRepoUrl).pathname.replace(/\/+$/, "").toLowerCase();
    } catch {
      return null;
    }
    return (
      extractGithubPullRequestUrls(composer.value)
        .map((url) => normalizeGithubPullRequestUrl(url))
        .find((url): url is string =>
          Boolean(url && new URL(url).pathname.toLowerCase().startsWith(`${repoPath}/pull/`)),
        ) ?? null
    );
  }, [composer.value, takeoverRepoUrl]);
  const [confirmedTakeoverPrUrl, setConfirmedTakeoverPrUrl] = useState<string | null>(null);
  const takeoverPrUrl = confirmedTakeoverPrUrl === detectedTakeoverPrUrl ? confirmedTakeoverPrUrl : null;
  const takeoverPrNumber = (takeoverPrUrl ?? detectedTakeoverPrUrl)?.split("/").pop();
  const takeoverChip = detectedTakeoverPrUrl ? (
    <button
      type="button"
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs transition-colors ${
        takeoverPrUrl
          ? "border-accent bg-accent-soft text-accent"
          : "border-border bg-surface-2 text-text-muted hover:border-accent hover:text-accent"
      }`}
      onClick={() => setConfirmedTakeoverPrUrl(takeoverPrUrl ? null : detectedTakeoverPrUrl)}
      aria-pressed={Boolean(takeoverPrUrl)}
    >
      {takeoverPrUrl ? `Taking over PR #${takeoverPrNumber}` : `Take over PR #${takeoverPrNumber}`}
    </button>
  ) : null;

  const attachmentValidationPromptText = (() => {
    const rawTrimmed = composer.value.trim();
    if (!rawTrimmed) return "";
    const skillParse = parseLeadingSkillCommands(rawTrimmed);
    return skillParse.skills.length > 0 ? rawTrimmed : skillParse.prompt.trim();
  })();

  const attachments = usePromptAttachments({ promptText: attachmentValidationPromptText });
  const autocomplete = usePromptAutocomplete({
    value: composer.value,
    setValue: composer.setValue,
    reasoningEffort: composer.reasoningEffort,
    loadFiles,
    loadSkills,
    textareaRef,
    highlightRef,
    onNonEmptyInput: () => warmWithReasoningEffort(composer.reasoningEffort),
  });

  useSyncEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    if (variant === "chat") {
      const supportsFieldSizing =
        typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");
      if (supportsFieldSizing) return;
    }
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
    element.style.overflowY = element.scrollHeight > TEXTAREA_MAX_HEIGHT_PX ? "auto" : "hidden";
  }, [composer.value, variant]);

  const runSubmit = useCallback(
    async (
      buildPayload: () =>
        Parameters<PromptFormProps["onSubmit"]>[0] | null | Promise<Parameters<PromptFormProps["onSubmit"]>[0] | null>,
      resetAfterSubmit: boolean,
    ) => {
      if (submitInFlightRef.current || isSubmitting) return;
      // Claim the in-flight slot before any await so a concurrent submit fired
      // while the skill/file caches resolve can't reach onSubmit twice.
      submitInFlightRef.current = true;
      setIsSubmitting(true);
      try {
        const payload = await buildPayload();
        if (!payload) return;
        await onSubmit(payload);
        if (resetAfterSubmit) {
          composer.resetComposerAfterSubmit();
          attachments.resetAttachmentsAfterSubmit();
          autocomplete.closeAutocomplete();
        }
        setSubmitError(null);
      } catch (err) {
        setSubmitError(stringifyError(err));
      } finally {
        submitInFlightRef.current = false;
        setIsSubmitting(false);
      }
    },
    [attachments, autocomplete, composer, isSubmitting, onSubmit],
  );

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!composer.value.trim() || submitDisabledReason || busyLabel) return;
      setSubmitError(null);

      if (autocomplete.showAutocomplete || autocomplete.showSkillAutocomplete) {
        autocomplete.closeAutocomplete();
        return;
      }

      await runSubmit(async () => {
        let skillCache = autocomplete.skillsCache;
        const rawTrimmed = composer.value.trim();
        if (skillCache === null && rawTrimmed.startsWith("/") && loadSkills) {
          try {
            skillCache = await autocomplete.ensureSkillCache();
          } catch {
            // Fall through to server-side validation so the submit still attempts.
          }
        }

        const skillParse = parseLeadingSkillCommands(rawTrimmed);
        if (skillParse.skills.length > 0 && skillCache) {
          const validNames = new Set(skillCache.map((skill) => skill.name));
          const unknown = skillParse.skills.find((skill) => !validNames.has(skill));
          if (unknown) {
            setSubmitError(`Unknown skill: ${unknown}`);
            return null;
          }
        }

        let fileCache = autocomplete.filesCache;
        if (fileCache === null && composer.value.includes("@") && loadFiles) {
          try {
            fileCache = await autocomplete.ensureFileCache();
          } catch {
            // Submit without resolved @-attachments; server validates too.
          }
        }

        const promptText = skillParse.skills.length > 0 ? rawTrimmed : skillParse.prompt.trim();
        const attachedFiles = parseAtTokens(promptText, fileCache);
        const payload = {
          ...buildSubmitPayload({
            prompt: promptText,
            skills: skillParse.skills,
            attachedFiles,
            uploadedFiles: attachments.uploadedFiles,
            uploadedImages: attachments.uploadedImages,
            reasoningEffort: composer.reasoningEffort,
            // Only send an explicit plan-mode value when the chip is available;
            // otherwise leave it to the control-plane user-setting default.
            planMode: planModeAvailable ? composer.planMode : undefined,
          }),
          ...(takeoverPrUrl ? { takeoverPrUrl } : {}),
        };

        return payload;
      }, true);
    },
    [
      attachments,
      autocomplete,
      busyLabel,
      composer,
      loadFiles,
      loadSkills,
      planModeAvailable,
      runSubmit,
      submitDisabledReason,
      takeoverPrUrl,
    ],
  );

  const submitPrompt = useCallback(
    async (prompt: string) => {
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt || composer.disabled || submitDisabledReason || busyLabel) return;
      setSubmitError(null);
      await runSubmit(
        () => ({
          prompt: trimmedPrompt,
          ...(composer.reasoningEffort ? { reasoningEffort: composer.reasoningEffort } : {}),
          ...(planModeAvailable ? { planMode: composer.planMode } : {}),
        }),
        false,
      );
    },
    [
      busyLabel,
      composer.disabled,
      composer.planMode,
      composer.reasoningEffort,
      planModeAvailable,
      runSubmit,
      submitDisabledReason,
    ],
  );

  useImperativeHandle(ref, () => ({ submitPrompt }), [submitPrompt]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Autocomplete (skills/files) claims Enter/Tab/arrows first when open, so a
      // selection keystroke picks a suggestion instead of sending.
      if (autocomplete.handleAutocompleteKeyDown(event)) return;
      if (!isSubmitKeydown(event)) return;
      // Prevent the newline the textarea would otherwise insert for this Enter.
      event.preventDefault();
      if (!composer.disabled && !submitDisabledReason && composer.value.trim()) {
        void handleSubmit(event as unknown as React.FormEvent);
      }
    },
    [autocomplete, composer.disabled, composer.value, handleSubmit, submitDisabledReason],
  );

  const viewProps = {
    lifecycle,
    disabled: composer.disabled,
    isDragOver: attachments.isDragOver,
    attachedFiles: autocomplete.attachedFiles,
    uploadedFiles: attachments.uploadedFiles,
    uploadedImages: attachments.uploadedImages,
    uploadError: attachments.uploadError,
    submitError,
    textareaRef,
    fileInputRef: attachments.fileInputRef,
    highlightRef,
    value: composer.value,
    placeholder: composer.placeholder,
    highlightedHtml: autocomplete.highlightedHtml,
    acceptExtensions: [...UPLOADED_FILE_EXTENSIONS, ...ALLOWED_IMAGE_MEDIA_TYPES].join(","),
    sendDisabled: composer.sendDisabled,
    sendDisabledTooltip: composer.sendDisabledTooltip,
    sendLabel: composer.sendLabel,
    sendTooltipId,
    isSubmitting,
    leadingChips: takeoverChip ? (
      <>
        {takeoverChip}
        {leadingChips}
      </>
    ) : (
      leadingChips
    ),
    leadingActions,
    matchChatPadding,
    reasoningEfforts,
    reasoningEffort: composer.reasoningEffort,
    defaultReasoningEffort,
    reasoningLabel: composer.reasoningLabel,
    planModeAvailable,
    planMode: composer.planMode,
    onTogglePlanMode,
    autocomplete: autocomplete.viewModel,
    onSubmit: handleSubmit,
    onChange: autocomplete.handleChange,
    onKeyDown: handleKeyDown,
    onSelect: autocomplete.handleSelect,
    onScroll: autocomplete.syncScroll,
    onPaste: attachments.handlePaste,
    onDragOver: attachments.handleDragOver,
    onDragLeave: attachments.handleDragLeave,
    onDrop: attachments.handleDrop,
    onProcessFiles: (files: FileList | File[]) => {
      void attachments.processSelection(files);
    },
    onRemoveAttachedFile: autocomplete.removeAttachedFile,
    onRemoveUploadedFile: attachments.removeUploadedFile,
    onRemoveUploadedImage: attachments.removeUploadedImage,
    onCycleReasoningEffort: composer.cycleReasoningEffort,
  };

  return variant === "chat" ? <ChatPromptFormView {...viewProps} /> : <DefaultPromptFormView {...viewProps} />;
});
