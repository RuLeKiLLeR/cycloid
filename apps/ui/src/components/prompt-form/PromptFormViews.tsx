import type React from "react";

import { MAX_UPLOADED_FILES, MAX_UPLOADED_IMAGES } from "../../../../../shared/constants/uploads";
import type { SkillMetadata } from "../../../../../shared/skills/index";
import type { UploadedFile, UploadedImage } from "../../../../../shared/types/sandbox";
import { CheckIcon, ChevronDownIcon, CloseIcon, PaperclipIcon, SpinnerIcon } from "../icons";
import { selectChipTriggerBase } from "../SearchableSelectChip";
import { baseClasses, buttonClasses, cx, IconButton, variantClasses } from "../ui";
import type { PromptAutocompleteViewModel, PromptFormVariant, PromptFormViewProps } from "./types";

function ClockIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

function UploadedFileIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function UploadedImageIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  );
}

function PromptFormError({ id, error, variant }: { id: string; error: string | null; variant: PromptFormVariant }) {
  if (!error) return null;
  return (
    <div
      id={id}
      role="alert"
      className={
        variant === "chat"
          ? "editorial-fade mb-1.5 text-center text-base text-error"
          : "editorial-fade mt-1.5 text-base text-error"
      }
    >
      {error}
    </div>
  );
}

function AttachmentChips({
  attachedFiles,
  uploadedFiles,
  uploadedImages,
  variant,
  onRemoveAttachedFile,
  onRemoveUploadedFile,
  onRemoveUploadedImage,
}: {
  attachedFiles: string[];
  uploadedFiles: UploadedFile[];
  uploadedImages: UploadedImage[];
  variant: PromptFormVariant;
  onRemoveAttachedFile: (path: string) => void;
  onRemoveUploadedFile: (name: string) => void;
  onRemoveUploadedImage: (name: string) => void;
}) {
  if (attachedFiles.length === 0 && uploadedFiles.length === 0 && uploadedImages.length === 0) return null;

  // The 16px-worst-case remove targets ride IconButton: 28px square with the
  // .hit-area-40 pointer pad. Icon shrinks to 12px to sit inside the chip.
  const removeIconClass = "-my-1 [&_svg]:size-3";

  // File names are UI chrome (attachment labels), so they ride the reading
  // family via .font-mono-tabular (now Geist + tabular figures) — sentence case,
  // no instrument register.
  const attached = attachedFiles.map((file) => (
    <span
      key={`attached-${file}`}
      className="inline-flex items-center gap-1 bg-accent-soft px-1.5 py-0.5 text-sm font-mono-tabular text-accent"
    >
      {file}
      <IconButton
        label={`Remove attached file ${file}`}
        className={removeIconClass}
        onClick={() => onRemoveAttachedFile(file)}
      >
        <CloseIcon />
      </IconButton>
    </span>
  ));

  const uploads = uploadedFiles.map((file) => (
    <span
      key={`uploaded-${file.name}`}
      className="inline-flex items-center gap-1 bg-accent-soft px-1.5 py-0.5 text-xs font-mono-tabular text-accent"
    >
      {variant === "default" && <UploadedFileIcon />}
      {file.name}
      <IconButton
        label={`Remove uploaded file ${file.name}`}
        className={removeIconClass}
        onClick={() => onRemoveUploadedFile(file.name)}
      >
        <CloseIcon />
      </IconButton>
    </span>
  ));

  const images = uploadedImages.map((image) => (
    <span
      key={`image-${image.name}`}
      className="inline-flex items-center gap-1 bg-warning-soft px-1.5 py-0.5 text-xs font-mono-tabular text-warning"
    >
      {variant === "default" && <UploadedImageIcon />}
      {image.name}
      <IconButton
        label={`Remove uploaded image ${image.name}`}
        className={removeIconClass}
        onClick={() => onRemoveUploadedImage(image.name)}
      >
        <CloseIcon />
      </IconButton>
    </span>
  ));

  if (variant === "chat") {
    return (
      <div className="flex flex-wrap gap-1 mb-2 px-3">
        {attached}
        {uploads}
        {images}
      </div>
    );
  }

  return (
    <>
      {attached.length > 0 && <div className="flex flex-wrap gap-1 mt-1.5">{attached}</div>}
      {uploads.length > 0 && <div className="flex flex-wrap gap-1 mt-1.5">{uploads}</div>}
      {images.length > 0 && <div className="flex flex-wrap gap-1 mt-1.5">{images}</div>}
    </>
  );
}

function AutocompleteDropdowns({
  variant,
  autocomplete,
}: {
  variant: PromptFormVariant;
  autocomplete: PromptAutocompleteViewModel;
}) {
  const horizontalClass = variant === "chat" ? "left-4 right-4" : "left-0 right-0";
  const dropdownClass = `menu-pop absolute bottom-full ${horizontalClass} z-dropdown mb-1 max-h-52 overflow-y-auto rounded-lg border border-border bg-surface-1 shadow-card`;

  function renderSkill(skill: SkillMetadata, index: number) {
    return (
      <button
        key={skill.name}
        type="button"
        className={`w-full cursor-pointer px-3 py-2 text-left text-base hover:bg-surface-2 ${
          index === autocomplete.skillAutocompleteIndex ? "bg-surface-2" : ""
        }`}
        onMouseDown={(event) => {
          event.preventDefault();
          autocomplete.selectSkillAutocompleteItem(skill);
        }}
      >
        <span className="block font-mono text-text-primary">/{skill.name}</span>
        {skill.description && <span className="block mt-0.5 text-text-muted">{skill.description}</span>}
      </button>
    );
  }

  function renderFile(path: string, index: number) {
    const base = path.split("/").pop() ?? path;
    const dir = path.slice(0, path.length - base.length);
    return (
      <button
        key={path}
        type="button"
        className={`w-full text-left px-3 py-1.5 text-xs font-mono cursor-pointer hover:bg-surface-2 ${
          index === autocomplete.autocompleteIndex ? "bg-surface-2" : ""
        }`}
        onMouseDown={(event) => {
          event.preventDefault();
          autocomplete.selectAutocompleteItem(path);
        }}
      >
        <span className="text-text-muted">{dir}</span>
        <span className="text-text-primary font-medium">{base}</span>
      </button>
    );
  }

  return (
    <>
      {autocomplete.showSkillAutocomplete &&
        (autocomplete.skillAutocompleteResults.length > 0 || autocomplete.skillsLoading) && (
          <div className={dropdownClass}>
            {autocomplete.skillsLoading && !autocomplete.skillsCache && (
              <div role="status" aria-busy="true" className="px-3 py-2 text-base text-text-muted">
                Loading skills…
              </div>
            )}
            {autocomplete.skillAutocompleteResults.map(renderSkill)}
          </div>
        )}
      {autocomplete.showAutocomplete && autocomplete.autocompleteResults.length > 0 && (
        <div className={dropdownClass}>
          {autocomplete.filesLoading && !autocomplete.filesCache && (
            <div role="status" aria-busy="true" className="px-3 py-2 text-base text-text-muted">
              Loading files…
            </div>
          )}
          {autocomplete.autocompleteResults.map(renderFile)}
        </div>
      )}
    </>
  );
}

function PromptToggles({
  variant,
  disabled,
  leadingChips,
  reasoningEfforts,
  reasoningEffort,
  defaultReasoningEffort,
  reasoningLabel,
  onCycleReasoningEffort,
  planModeAvailable,
  planMode,
  onTogglePlanMode,
}: Pick<
  PromptFormViewProps,
  | "disabled"
  | "leadingChips"
  | "reasoningEfforts"
  | "reasoningEffort"
  | "defaultReasoningEffort"
  | "reasoningLabel"
  | "onCycleReasoningEffort"
  | "planModeAvailable"
  | "planMode"
  | "onTogglePlanMode"
> & {
  variant: PromptFormVariant;
}) {
  const chat = variant === "chat";
  // Same chip geometry as the repo/model select chips so all four toolbar
  // controls read as one size and box. Resting state matches the select chip's
  // enabled look; the toggled-on state adds a restrained surface wash and strong
  // border so a settings toggle does not outshine the send action.
  const toggleClass = cx(
    "btn-press",
    selectChipTriggerBase,
    "border-border text-text-secondary hover:border-border-hover hover:text-text-primary",
    "aria-pressed:border-border-strong aria-pressed:bg-surface-3 aria-pressed:text-text-primary",
    "aria-[pressed=mixed]:border-border-strong aria-[pressed=mixed]:bg-surface-3 aria-[pressed=mixed]:text-text-primary",
    "disabled:cursor-not-allowed disabled:opacity-40",
  );

  const reasoningActive = reasoningEffort !== defaultReasoningEffort;
  const effectivePlanMode = planMode ?? "off";
  const planModeActive = effectivePlanMode !== "off";

  return (
    <>
      {leadingChips}
      {reasoningEfforts && reasoningEfforts.length > 0 && (
        <button
          type="button"
          onClick={onCycleReasoningEffort}
          aria-label={`Thinking: ${reasoningLabel}. Click to cycle.`}
          aria-pressed={reasoningActive}
          disabled={disabled}
          className={toggleClass}
          title={`Thinking: ${reasoningLabel}. Click to cycle.`}
        >
          {!chat && <ClockIcon />}
          {/* One family per control group: the label and value stay Geist like
              the sibling repo/model/plan chips (DESIGN.md grouping rule). */}
          <span>Thinking: {reasoningLabel}</span>
          {/* Visible cycle affordance — this control steps through the effort
              ladder rather than toggling. */}
          <ChevronDownIcon className="size-2.5 shrink-0" aria-hidden />
        </button>
      )}
      {planModeAvailable && (
        <button
          type="button"
          onClick={onTogglePlanMode}
          aria-label={`Plan mode: ${effectivePlanMode}. Click to cycle.`}
          aria-pressed={effectivePlanMode === "on" ? true : effectivePlanMode === "auto" ? "mixed" : false}
          disabled={disabled}
          className={toggleClass}
          title="Plan mode: Cycloid writes a plan and waits for your approval before implementing."
        >
          {planModeActive ? <CheckIcon className="size-3 shrink-0" /> : null}
          Plan: {effectivePlanMode}
        </button>
      )}
    </>
  );
}

function SendButton({ view, variant }: { view: PromptFormViewProps; variant: PromptFormVariant }) {
  const chat = variant === "chat";
  // Kit primary — white ink with the glow-white hover bloom and btn-press
  // darken. The button stays interactive while "disabled" (aria-disabled +
  // type="button") so the reason tooltip keeps hover/focus reachability.
  // Chat renders an arrow-only send, so it's a 36px square (control-md height +
  // matching width, no horizontal padding) rather than a padded pill; the
  // default view keeps a labeled lg pill.
  const effectiveButtonClass = cx(
    chat
      ? cx(baseClasses, variantClasses.primary, "control-md w-9")
      : buttonClasses({ variant: "primary", size: "lg" }),
    view.sendDisabled && "cursor-not-allowed opacity-40",
  );
  const wrapperClass = chat
    ? "group relative shrink-0 inline-flex"
    : `group relative inline-flex ${view.sendDisabled ? "cursor-not-allowed" : ""}`;
  const tooltipClass =
    "pointer-events-none absolute bottom-full right-0 z-tooltip mb-2 hidden w-max max-w-[220px] border border-border bg-surface-1 px-2.5 py-1.5 text-left text-xs leading-snug text-text-secondary shadow-card group-hover:block group-focus:block group-focus-within:block";

  return (
    <span
      aria-describedby={view.sendDisabled && view.sendDisabledTooltip ? view.sendTooltipId : undefined}
      className={wrapperClass}
    >
      <button
        type={view.sendDisabled ? "button" : "submit"}
        aria-busy={view.isSubmitting || undefined}
        aria-disabled={view.sendDisabled ? true : undefined}
        aria-label={
          view.sendDisabled && view.sendDisabledTooltip
            ? `${view.sendLabel}: ${view.sendDisabledTooltip}`
            : view.sendLabel
        }
        className={effectiveButtonClass}
      >
        {view.isSubmitting ? (
          <SpinnerIcon className="h-4 w-4" />
        ) : chat ? (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="5 12 12 5 19 12" />
          </svg>
        ) : (
          view.sendLabel
        )}
      </button>
      {view.sendDisabled && view.sendDisabledTooltip && (
        <span id={view.sendTooltipId} role="tooltip" className={tooltipClass}>
          {view.sendDisabledTooltip}
        </span>
      )}
    </span>
  );
}

export function ChatPromptFormView(view: PromptFormViewProps) {
  const running = view.lifecycle.phase === "running";
  const error = view.uploadError || view.submitError;
  const errorId = `${view.sendTooltipId}-error`;
  return (
    <form
      aria-busy={view.isSubmitting || undefined}
      onSubmit={view.onSubmit}
      onDragOver={view.onDragOver}
      onDragLeave={view.onDragLeave}
      onDrop={view.onDrop}
    >
      <AttachmentChips
        attachedFiles={view.attachedFiles}
        uploadedFiles={view.uploadedFiles}
        uploadedImages={view.uploadedImages}
        variant="chat"
        onRemoveAttachedFile={view.onRemoveAttachedFile}
        onRemoveUploadedFile={view.onRemoveUploadedFile}
        onRemoveUploadedImage={view.onRemoveUploadedImage}
      />
      <PromptFormError id={errorId} error={error} variant="chat" />

      <input
        ref={view.fileInputRef}
        type="file"
        multiple
        accept={view.acceptExtensions}
        className="hidden"
        onChange={(event) => {
          if (event.target.files) view.onProcessFiles(event.target.files);
          event.target.value = "";
        }}
      />

      <div
        className={`session-stack-surface command-composer relative flex flex-col transition-colors duration-[--duration-med] focus-within:border-accent ${
          running ? "border-warning-soft-border" : "hover:border-border-hover"
        } ${view.isDragOver ? "outline outline-1 outline-accent-soft-border" : ""}`}
      >
        <div className="relative">
          {view.autocomplete.filesCache && view.highlightedHtml && (
            <div
              ref={view.highlightRef}
              aria-hidden
              className="pointer-events-none absolute inset-0 px-5 py-4 text-lg leading-snug text-text-primary font-[inherit] whitespace-pre-wrap break-words overflow-hidden"
              dangerouslySetInnerHTML={{ __html: view.highlightedHtml }}
            />
          )}
          <textarea
            aria-label="Prompt"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            autoComplete="off"
            ref={view.textareaRef}
            value={view.value}
            onChange={view.onChange}
            onKeyDown={view.onKeyDown}
            onSelect={view.onSelect}
            onScroll={view.onScroll}
            onPaste={view.onPaste}
            disabled={view.disabled}
            rows={1}
            placeholder={view.placeholder}
            style={{ fieldSizing: "content" } as React.CSSProperties}
            className={`w-full min-w-0 bg-transparent border-0 resize-none px-5 py-4 text-lg leading-snug font-[inherit] placeholder:text-text-muted disabled:opacity-50 disabled:cursor-not-allowed max-h-48 ${
              view.autocomplete.filesCache && view.highlightedHtml
                ? "text-transparent caret-text-primary"
                : "text-text-primary"
            }`}
          />
          <AutocompleteDropdowns variant="chat" autocomplete={view.autocomplete} />
        </div>

        <div className="command-composer-toolbar flex items-center justify-between gap-2 px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <IconButton
              label="Attach files"
              onClick={() => view.fileInputRef.current?.click()}
              disabled={
                view.disabled ||
                (view.uploadedFiles.length >= MAX_UPLOADED_FILES && view.uploadedImages.length >= MAX_UPLOADED_IMAGES)
              }
            >
              <PaperclipIcon />
            </IconButton>
            <PromptToggles
              variant="chat"
              disabled={view.disabled}
              leadingChips={view.leadingChips}
              reasoningEfforts={view.reasoningEfforts}
              reasoningEffort={view.reasoningEffort}
              defaultReasoningEffort={view.defaultReasoningEffort}
              reasoningLabel={view.reasoningLabel}
              onCycleReasoningEffort={view.onCycleReasoningEffort}
              planModeAvailable={view.planModeAvailable}
              planMode={view.planMode}
              onTogglePlanMode={view.onTogglePlanMode}
            />
          </div>
          <SendButton view={view} variant="chat" />
        </div>
      </div>
    </form>
  );
}

export function DefaultPromptFormView(view: PromptFormViewProps) {
  const composerPaddingClass = view.matchChatPadding ? "px-3 py-2.5" : "px-4 py-3";
  const running = view.lifecycle.phase === "running";
  const error = view.uploadError || view.submitError;
  const errorId = `${view.sendTooltipId}-error`;
  return (
    <form
      aria-busy={view.isSubmitting || undefined}
      onSubmit={view.onSubmit}
      onDragOver={view.onDragOver}
      onDragLeave={view.onDragLeave}
      onDrop={view.onDrop}
    >
      <input
        ref={view.fileInputRef}
        type="file"
        multiple
        accept={view.acceptExtensions}
        className="hidden"
        onChange={(event) => {
          if (event.target.files) view.onProcessFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <div
        className={`session-stack-surface relative flex flex-col transition-colors duration-[--duration-med] focus-within:border-accent ${
          running ? "border-warning-soft-border" : "hover:border-border-hover"
        } ${view.isDragOver ? "outline outline-1 outline-accent-soft-border" : ""}`}
      >
        <div className="relative">
          {view.autocomplete.filesCache && view.highlightedHtml && (
            <div
              ref={view.highlightRef}
              aria-hidden
              className={`absolute inset-0 ${composerPaddingClass} text-lg leading-[1.55] text-text-primary font-[inherit] whitespace-pre-wrap break-words
                         overflow-hidden pointer-events-none`}
              dangerouslySetInnerHTML={{ __html: view.highlightedHtml }}
            />
          )}
          <textarea
            aria-label="Prompt"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            autoComplete="off"
            ref={view.textareaRef}
            value={view.value}
            onChange={view.onChange}
            onKeyDown={view.onKeyDown}
            onSelect={view.onSelect}
            onScroll={view.onScroll}
            onPaste={view.onPaste}
            disabled={view.disabled}
            rows={1}
            placeholder={view.placeholder}
            className={`w-full ${composerPaddingClass} text-lg leading-[1.55] bg-transparent border-0
                       resize-none overflow-x-hidden font-[inherit]
                       placeholder:text-text-muted placeholder:italic
                       disabled:opacity-50 disabled:cursor-not-allowed
                       ${view.autocomplete.filesCache && view.highlightedHtml ? "text-transparent caret-text-primary" : "text-text-primary"}`}
          />
          <AutocompleteDropdowns variant="default" autocomplete={view.autocomplete} />
        </div>
        <div className="px-3">
          <AttachmentChips
            attachedFiles={view.attachedFiles}
            uploadedFiles={view.uploadedFiles}
            uploadedImages={view.uploadedImages}
            variant="default"
            onRemoveAttachedFile={view.onRemoveAttachedFile}
            onRemoveUploadedFile={view.onRemoveUploadedFile}
            onRemoveUploadedImage={view.onRemoveUploadedImage}
          />
        </div>
        <div className="rule flex flex-wrap items-center justify-end gap-2 px-2.5 py-2">
          {view.leadingActions}
          <IconButton
            label="Upload files as context"
            onClick={() => view.fileInputRef.current?.click()}
            disabled={
              view.disabled ||
              (view.uploadedFiles.length >= MAX_UPLOADED_FILES && view.uploadedImages.length >= MAX_UPLOADED_IMAGES)
            }
          >
            <PaperclipIcon />
          </IconButton>
          <PromptToggles
            variant="default"
            disabled={view.disabled}
            reasoningEfforts={view.reasoningEfforts}
            reasoningEffort={view.reasoningEffort}
            defaultReasoningEffort={view.defaultReasoningEffort}
            reasoningLabel={view.reasoningLabel}
            onCycleReasoningEffort={view.onCycleReasoningEffort}
            planModeAvailable={view.planModeAvailable}
            planMode={view.planMode}
            onTogglePlanMode={view.onTogglePlanMode}
          />
          <SendButton view={view} variant="default" />
        </div>
      </div>
      <PromptFormError id={errorId} error={error} variant="default" />
    </form>
  );
}
