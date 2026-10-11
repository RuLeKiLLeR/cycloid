import type React from "react";

import type { PlanModeSetting } from "../../../../../shared/plan-mode";
import type { SkillMetadata } from "../../../../../shared/skills/index";
import type { UploadedFile, UploadedImage } from "../../../../../shared/types/sandbox";
import type { LifecycleSnapshot } from "../../utils/prompt-form";

export type PromptFormProps = {
  lifecycle: LifecycleSnapshot;
  onSubmit: (payload: {
    prompt: string;
    skills?: string[];
    files?: string[];
    uploadedFiles?: UploadedFile[];
    uploadedImages?: UploadedImage[];
    reasoningEffort?: string;
    planMode?: PlanModeSetting;
    takeoverPrUrl?: string;
  }) => void | Promise<void>;
  onWarm?: (reasoningEffort?: string) => void;
  loadFiles?: (reasoningEffort?: string) => Promise<string[]>;
  loadSkills?: () => Promise<SkillMetadata[]>;
  disabled?: boolean;
  placeholder?: string;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  submitDisabledReason?: string;
  /** Transient busy copy; disables the composer and takes precedence over the generic disabled tooltip. */
  busyLabel?: string;
  /** Seeds the composer once on mount (e.g. onboarding task templates). */
  initialValue?: string;
  variant?: "default" | "chat";
  /** Only consumed when `variant="chat"`. Has no effect in the default variant. */
  leadingChips?: React.ReactNode;
  /** Only consumed when `variant="default"`. Has no effect in the chat variant. */
  leadingActions?: React.ReactNode;
  /** Only consumed when `variant="default"`. Matches the landing composer textarea padding. */
  matchChatPadding?: boolean;
  /**
   * Home/new-session composer only. When true, renders the "Plan mode" toggle
   * chip (gated on the `planApproval` bootstrap capability). The follow-up
   * composer never sets this, so the chip stays home-only.
   */
  planModeAvailable?: boolean;
  /** Current plan-mode value backing the chip; also sent in the create body at submit time. */
  planMode?: PlanModeSetting;
  /** Toggles plan mode: optimistically flips + persists the user setting, rolling back on failure. */
  onTogglePlanMode?: () => void;
  /** Home composer only: enables the explicit PR takeover chip for this repo. */
  takeoverRepoUrl?: string;
};

export type PromptFormVariant = NonNullable<PromptFormProps["variant"]>;

export type PromptAutocompleteViewModel = {
  showSkillAutocomplete: boolean;
  skillsLoading: boolean;
  skillsCache: SkillMetadata[] | null;
  skillAutocompleteResults: SkillMetadata[];
  skillAutocompleteIndex: number;
  selectSkillAutocompleteItem: (skill: SkillMetadata) => void;
  showAutocomplete: boolean;
  filesLoading: boolean;
  filesCache: string[] | null;
  autocompleteResults: string[];
  autocompleteIndex: number;
  selectAutocompleteItem: (path: string) => void;
};

export type PromptFormViewProps = {
  lifecycle: LifecycleSnapshot;
  disabled: boolean;
  isDragOver: boolean;
  attachedFiles: string[];
  uploadedFiles: UploadedFile[];
  uploadedImages: UploadedImage[];
  uploadError: string | null;
  submitError: string | null;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  fileInputRef: React.RefObject<HTMLInputElement>;
  highlightRef: React.RefObject<HTMLDivElement>;
  value: string;
  placeholder: string;
  highlightedHtml: string;
  acceptExtensions: string;
  sendDisabled: boolean;
  sendDisabledTooltip: string | undefined;
  sendLabel: string;
  sendTooltipId: string;
  isSubmitting: boolean;
  leadingChips?: React.ReactNode;
  leadingActions?: React.ReactNode;
  matchChatPadding?: boolean;
  reasoningEfforts?: string[];
  reasoningEffort: string | undefined;
  defaultReasoningEffort: string | undefined;
  reasoningLabel: string;
  planModeAvailable?: boolean;
  planMode?: PlanModeSetting;
  onTogglePlanMode?: () => void;
  autocomplete: PromptAutocompleteViewModel;
  onSubmit: (event: React.FormEvent) => void;
  onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSelect: (event: React.SyntheticEvent<HTMLTextAreaElement>) => void;
  onScroll: () => void;
  onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
  onProcessFiles: (files: FileList | File[]) => void;
  onRemoveAttachedFile: (path: string) => void;
  onRemoveUploadedFile: (name: string) => void;
  onRemoveUploadedImage: (name: string) => void;
  onCycleReasoningEffort: () => void;
};
