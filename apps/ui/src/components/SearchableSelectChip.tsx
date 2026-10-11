import { type FocusEvent, Fragment, useId, useMemo, useRef, useState } from "react";

import { useSyncEffect } from "../hooks/useEffects";
import { ChevronDownIcon } from "./icons";
import { Input } from "./ui";

// Trigger geometry shared with the composer toolbar toggles (Thinking/Plan) so
// every control in the toolbar reads as one chip family — same 36px height, box,
// padding, and text size. State/tone classes are layered on per-consumer.
export const selectChipTriggerBase =
  "inline-flex control-md items-center gap-2 border px-3 text-base font-medium transition-colors duration-[--duration-fast]";

export type SearchableSelectChipOption = {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
};

type SearchableSelectChipOptionSection = {
  key: string;
  group?: string;
  options: SearchableSelectChipOption[];
};

export function SearchableSelectChip({
  id,
  ariaLabel,
  label,
  selectedLabel,
  value,
  disabled,
  placeholder,
  placeholderActive,
  requiresAttention,
  allowCustomValue,
  onChange,
  options,
}: {
  id?: string;
  ariaLabel: string;
  label: string;
  selectedLabel: string;
  value: string;
  disabled?: boolean;
  placeholder?: string;
  placeholderActive?: boolean;
  requiresAttention?: boolean;
  allowCustomValue?: boolean;
  onChange: (next: string) => boolean | void;
  options: SearchableSelectChipOption[];
}) {
  const attentionActive = requiresAttention && !disabled;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const generatedId = useId();
  const controlId = id ?? `searchable-select-${generatedId}`;
  const labelId = `${controlId}-label`;
  const attentionId = attentionActive ? `${controlId}-attention` : undefined;
  const searchId = `${controlId}-search`;
  const listboxId = `${controlId}-listbox`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef("");

  useSyncEffect(() => {
    if (!open) {
      queryRef.current = "";
      setQuery("");
    }
  }, [open, selectedLabel, value]);

  useSyncEffect(() => {
    if (open) searchInputRef.current?.focus();
  }, [open]);

  const normalizedOptions = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return options;
    return options.filter(
      (option) => option.label.toLowerCase().includes(search) || option.value.toLowerCase().includes(search),
    );
  }, [options, query]);

  const optionByValue = useMemo(() => {
    const entries = new Map<string, SearchableSelectChipOption>();
    for (const option of options) {
      entries.set(option.value, option);
      entries.set(option.value.toLowerCase(), option);
      entries.set(option.label, option);
      entries.set(option.label.toLowerCase(), option);
    }
    return entries;
  }, [options]);

  const normalizedOptionSections = useMemo(() => {
    const sections: SearchableSelectChipOptionSection[] = [];
    const sectionByGroup = new Map<string, SearchableSelectChipOptionSection>();

    for (const option of normalizedOptions) {
      if (!option.group) {
        sections.push({ key: `option:${option.value}`, options: [option] });
        continue;
      }

      const existingSection = sectionByGroup.get(option.group);
      if (existingSection) {
        existingSection.options.push(option);
        continue;
      }

      const section = { key: `group:${option.group}`, group: option.group, options: [option] };
      sectionByGroup.set(option.group, section);
      sections.push(section);
    }

    return sections;
  }, [normalizedOptions]);

  const displayedOptions = useMemo(
    () => normalizedOptionSections.flatMap((section) => section.options),
    [normalizedOptionSections],
  );
  const activeOptionIndex = displayedOptions.findIndex((option) => option.value === activeValue);
  const activeOptionId = activeOptionIndex >= 0 ? `${controlId}-option-${activeOptionIndex}` : undefined;

  useSyncEffect(() => {
    if (!open) {
      setActiveValue(null);
      return;
    }

    setActiveValue((current) => {
      const currentOption = displayedOptions.find((option) => option.value === current);
      if (currentOption && !currentOption.disabled) return current;
      return (
        displayedOptions.find((option) => option.value === value && !option.disabled)?.value ??
        displayedOptions.find((option) => !option.disabled)?.value ??
        null
      );
    });
  }, [displayedOptions, open, value]);

  function resolveMatch(next: string): SearchableSelectChipOption | undefined {
    const trimmed = next.trim();
    return optionByValue.get(trimmed) ?? optionByValue.get(trimmed.toLowerCase());
  }

  function selectValue(next: string) {
    const handled = onChange(next);
    if (handled === false) {
      queryRef.current = "";
      setQuery("");
      setOpen(false);
      return;
    }
    queryRef.current = "";
    setQuery("");
    setOpen(false);
  }

  function closeAndFocusTrigger() {
    queryRef.current = "";
    setQuery("");
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveActive(direction: 1 | -1) {
    const enabledOptions = displayedOptions.filter((option) => !option.disabled);
    if (enabledOptions.length === 0) return;
    const currentIndex = enabledOptions.findIndex((option) => option.value === activeValue);
    const nextIndex =
      currentIndex < 0
        ? direction === 1
          ? 0
          : enabledOptions.length - 1
        : (currentIndex + direction + enabledOptions.length) % enabledOptions.length;
    setActiveValue(enabledOptions[nextIndex]?.value ?? null);
  }

  function commit(next: string) {
    if (!next.trim()) {
      queryRef.current = "";
      setQuery("");
      setOpen(false);
      return;
    }
    const match = resolveMatch(next);
    if (match && !match.disabled) {
      selectValue(match.value);
      return;
    }
    if (allowCustomValue) {
      selectValue(next.trim());
      return;
    }
    queryRef.current = "";
    setQuery("");
    setOpen(false);
  }

  return (
    <div
      className="group relative inline-flex"
      onBlur={(e: FocusEvent<HTMLDivElement>) => {
        if (e.currentTarget.contains(e.relatedTarget)) return;
        commit(queryRef.current);
      }}
    >
      <span id={labelId} className="sr-only">
        {ariaLabel}
      </span>
      {attentionId ? (
        <span id={attentionId} className="sr-only">
          {ariaLabel} requires attention
        </span>
      ) : null}
      <button
        ref={triggerRef}
        id={id}
        aria-labelledby={labelId}
        aria-describedby={attentionId}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className={`${selectChipTriggerBase} ${
          disabled
            ? "border-border text-text-muted opacity-60 cursor-not-allowed bg-surface-2"
            : attentionActive
              ? "border-warning-soft-border bg-warning-soft text-warning"
              : placeholderActive
                ? "border-border text-text-muted hover:text-text-secondary hover:border-border-hover"
                : "border-border text-text-secondary hover:text-text-primary hover:border-border-hover"
        }`}
      >
        {label}
        <ChevronDownIcon className="size-2.5 shrink-0" />
      </button>
      {open && (
        <div className="menu-pop absolute left-0 top-full z-dropdown mt-2 w-72 max-w-[80vw] rounded-lg border border-border bg-surface-1 p-2 shadow-card">
          <label htmlFor={searchId} className="sr-only">
            {ariaLabel} search
          </label>
          <Input
            id={searchId}
            ref={searchInputRef}
            controlSize="sm"
            role="combobox"
            aria-labelledby={labelId}
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded="true"
            aria-activedescendant={activeOptionId}
            type="search"
            value={query}
            placeholder={placeholder ?? `Search ${ariaLabel.toLowerCase()}…`}
            onChange={(e) => {
              queryRef.current = e.currentTarget.value;
              setQuery(e.currentTarget.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                moveActive(e.key === "ArrowDown" ? 1 : -1);
                return;
              }
              if (e.key === "Home" || e.key === "End") {
                e.preventDefault();
                const enabledOptions = displayedOptions.filter((option) => !option.disabled);
                const option = e.key === "Home" ? enabledOptions[0] : enabledOptions[enabledOptions.length - 1];
                setActiveValue(option?.value ?? null);
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                const currentSearch = queryRef.current.trim().toLowerCase();
                const activeOption = displayedOptions.find(
                  (option) =>
                    option.value === activeValue &&
                    !option.disabled &&
                    (!currentSearch ||
                      option.label.toLowerCase().includes(currentSearch) ||
                      option.value.toLowerCase().includes(currentSearch)),
                );
                if (activeOption) selectValue(activeOption.value);
                else commit(queryRef.current);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                closeAndFocusTrigger();
              }
            }}
          />
          <div id={listboxId} role="listbox" aria-labelledby={labelId} className="mt-2 max-h-56 overflow-y-auto py-1">
            {normalizedOptionSections.map((section) => {
              const optionButtons = section.options.map((option, i) => {
                const optionIndex = displayedOptions.indexOf(option);
                const active = option.value === activeValue;
                return (
                  <button
                    key={`${option.value}-${i}`}
                    id={`${controlId}-option-${optionIndex}`}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    disabled={option.disabled}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => {
                      if (!option.disabled) setActiveValue(option.value);
                    }}
                    onClick={() => selectValue(option.value)}
                    className={`block w-full rounded-md px-2.5 py-2 text-left text-base transition-colors duration-[--duration-fast] ${
                      option.disabled
                        ? "cursor-not-allowed text-text-muted"
                        : active || option.value === value
                          ? "bg-surface-2 text-text-primary"
                          : "text-text-secondary hover:bg-surface-2 hover:text-text-primary"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              });

              if (!section.group) {
                return <Fragment key={section.key}>{optionButtons}</Fragment>;
              }

              return (
                <div key={section.key} role="group" aria-label={section.group}>
                  <div className="px-2.5 pb-1 pt-2 text-base font-medium text-text-muted">{section.group}</div>
                  {optionButtons}
                </div>
              );
            })}
            {normalizedOptions.length === 0 && (
              <div className="px-2.5 py-2 text-base text-text-muted">
                {allowCustomValue ? "Press Enter to use this value" : "No matches"}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
