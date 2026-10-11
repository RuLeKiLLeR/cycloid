import { useCallback, useRef, useState } from "react";

import type { PlanModeSetting } from "../../../../../shared/plan-mode";
import { useSyncEffect } from "../../hooks/useEffects";
import { getPlaceholder, isStatusDisabled, type LifecycleSnapshot } from "../../utils/prompt-form";
import { formatReasoningEffortLabel } from "./utils";

export function usePromptComposerState({
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
}: {
  lifecycle: LifecycleSnapshot;
  externalDisabled?: boolean;
  customPlaceholder?: string;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  submitDisabledReason?: string;
  isSubmitting?: boolean;
  busyLabel?: string;
  warmWithReasoningEffort: (reasoningEffort?: string) => void;
  resetWarmup: () => void;
  initialValue?: string;
  // Current plan-mode value (home composer only). Surfaced back out alongside
  // reasoningEffort so the submit payload reads every session-creation flag
  // from one place. Ownership + persistence live in the home page.
  planMode?: PlanModeSetting;
}) {
  const [value, setValue] = useState(initialValue ?? "");
  const [reasoningEffort, setReasoningEffort] = useState<string | undefined>(defaultReasoningEffort);

  const statusDisabled = isStatusDisabled(lifecycle);
  const disabled = statusDisabled || !!externalDisabled || !!busyLabel;
  const effectsKey = reasoningEfforts?.join(",") ?? "";
  const prevReasoningConfigRef = useRef({ defaultReasoningEffort, effectsKey });

  useSyncEffect(() => {
    const previous = prevReasoningConfigRef.current;
    if (previous.effectsKey !== effectsKey || previous.defaultReasoningEffort !== defaultReasoningEffort) {
      prevReasoningConfigRef.current = { defaultReasoningEffort, effectsKey };
      setReasoningEffort(defaultReasoningEffort);
      resetWarmup();
      if (value.trim()) warmWithReasoningEffort(defaultReasoningEffort);
    }
  }, [defaultReasoningEffort, effectsKey, resetWarmup, value, warmWithReasoningEffort]);

  const cycleReasoningEffort = useCallback(() => {
    if (!reasoningEfforts || reasoningEfforts.length === 0) return;
    const index = reasoningEfforts.indexOf(reasoningEffort ?? "");
    const next = reasoningEfforts[(index + 1) % reasoningEfforts.length];
    setReasoningEffort(next);
    resetWarmup();
    if (value.trim()) warmWithReasoningEffort(next);
  }, [reasoningEffort, reasoningEfforts, resetWarmup, value, warmWithReasoningEffort]);

  const resetComposerAfterSubmit = useCallback(() => {
    resetWarmup();
    setValue("");
  }, [resetWarmup]);

  const reasoningLabel = formatReasoningEffortLabel(reasoningEffort);
  const placeholder = getPlaceholder(lifecycle, !!externalDisabled, customPlaceholder);
  const sendDisabled = disabled || !!submitDisabledReason || !!isSubmitting || !value.trim();
  const sendDisabledTooltip =
    submitDisabledReason ??
    (busyLabel
      ? busyLabel
      : isSubmitting
        ? "Sending prompt…"
        : disabled
          ? "Send is unavailable right now."
          : !value.trim()
            ? "Enter a prompt to enable Send."
            : undefined);
  const sendLabel = "Send";

  return {
    value,
    setValue,
    disabled,
    reasoningEffort,
    cycleReasoningEffort,
    resetComposerAfterSubmit,
    placeholder,
    reasoningLabel,
    sendDisabled,
    sendDisabledTooltip,
    sendLabel,
    planMode,
  };
}
