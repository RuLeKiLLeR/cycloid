import { useRef, useState } from "react";

import { useSyncEffect } from "../hooks/useEffects";
import { Button, Input } from "./ui";

type InlineInputProps = {
  id: string;
  onSubmit: (id: string, value: string) => void;
  placeholder: string;
  submitLabel: string;
  onCancel?: () => void;
  disabled?: boolean;
};

export function InlineInput({ id, onSubmit, placeholder, submitLabel, onCancel, disabled }: InlineInputProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmedValue = value.trim();
  const canSubmit = !disabled && trimmedValue.length > 0;

  useSyncEffect(() => {
    if (!disabled) inputRef.current?.focus();
  }, [disabled]);

  return (
    <form
      className="mt-2 flex flex-col gap-2 sm:flex-row"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) {
          onSubmit(id, trimmedValue);
          setValue("");
        }
      }}
    >
      <Input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={placeholder}
        autoComplete="off"
        className="flex-1 bg-surface-2 text-sm"
      />
      <Button
        type="submit"
        disabled={!canSubmit}
        variant="secondary"
        size="lg"
        className="border-accent-soft-border bg-accent-soft px-3 text-xs"
      >
        {submitLabel}
      </Button>
      {onCancel && (
        <Button
          type="button"
          onClick={onCancel}
          disabled={disabled}
          variant="secondary"
          size="lg"
          className="px-3 text-xs text-text-muted"
        >
          Cancel
        </Button>
      )}
    </form>
  );
}
