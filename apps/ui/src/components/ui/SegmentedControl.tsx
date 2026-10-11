import { type KeyboardEvent, type ReactNode, useRef } from "react";

import { cx } from "./utils";

export type SegmentedOption<T extends string = string> = {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
};

type SegmentedControlBaseProps<T extends string = string> = {
  options: SegmentedOption<T>[];
  className?: string;
  ariaLabel?: string;
};

export type SegmentedControlProps<T extends string = string> = SegmentedControlBaseProps<T> &
  (
    | {
        /** Radio semantics (default): exactly one segment selected. */
        multiSelect?: false;
        value: T;
        onChange: (value: T) => void;
      }
    | {
        /**
         * Toggle semantics: each segment toggles independently (`aria-pressed`
         * buttons in a group). `value` is the set of active segment values;
         * `onChange` receives the next set in option order.
         */
        multiSelect: true;
        value: readonly T[];
        onChange: (value: T[]) => void;
      }
  );

export function SegmentedControl<T extends string = string>(props: SegmentedControlProps<T>) {
  const { options, className, ariaLabel } = props;
  const multiSelect = props.multiSelect === true;
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabledIndexes = options.flatMap((option, index) => (option.disabled ? [] : [index]));

  const isSelected = (option: SegmentedOption<T>) =>
    multiSelect ? (props.value as readonly T[]).includes(option.value) : props.value === option.value;

  const selectedIndex = multiSelect ? -1 : options.findIndex((option) => isSelected(option) && !option.disabled);
  const tabStopIndex = selectedIndex >= 0 ? selectedIndex : enabledIndexes[0];

  function activate(option: SegmentedOption<T>) {
    if (option.disabled) return;
    if (multiSelect) {
      const active = props.value as readonly T[];
      const next = active.includes(option.value)
        ? active.filter((value) => value !== option.value)
        : options
            .filter((candidate) => active.includes(candidate.value) || candidate.value === option.value)
            .map((candidate) => candidate.value);
      (props.onChange as (value: T[]) => void)(next);
      return;
    }
    (props.onChange as (value: T) => void)(option.value);
  }

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (enabledIndexes.length === 0) return;

    const currentEnabledIndex = enabledIndexes.indexOf(index);
    let nextIndex: number | undefined;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = enabledIndexes[(currentEnabledIndex + 1) % enabledIndexes.length];
        break;
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = enabledIndexes[(currentEnabledIndex - 1 + enabledIndexes.length) % enabledIndexes.length];
        break;
      case "Home":
        nextIndex = enabledIndexes[0];
        break;
      case "End":
        nextIndex = enabledIndexes[enabledIndexes.length - 1];
        break;
      default:
        return;
    }

    event.preventDefault();
    if (nextIndex === undefined) return;
    const option = options[nextIndex];
    if (!option || option.disabled) return;
    // Radio semantics: selection follows focus. Toggle semantics: arrows move
    // focus only; Space/Enter (native click) toggles.
    if (!multiSelect) activate(option);
    optionRefs.current[nextIndex]?.focus();
  }

  return (
    <div
      role={multiSelect ? "group" : "radiogroup"}
      aria-label={ariaLabel}
      // Sharp bordered track — segments share a 1px border-strong edge, no radius.
      className={cx("inline-flex items-center border border-border-strong bg-surface-1", className)}
    >
      {options.map((option, index) => {
        const selected = isSelected(option);
        return (
          <button
            key={option.value}
            ref={(node) => {
              optionRefs.current[index] = node;
            }}
            type="button"
            role={multiSelect ? undefined : "radio"}
            aria-pressed={multiSelect ? selected : undefined}
            aria-checked={multiSelect ? undefined : selected}
            tabIndex={multiSelect ? undefined : index === tabStopIndex ? 0 : -1}
            disabled={option.disabled}
            onClick={() => activate(option)}
            onKeyDown={(event) => moveFocus(event, index)}
            className={cx(
              // Selected flips to surface-3 fill + a 2px white top bar; sharp
              // corners, no pill. The divider (::before) and selection bar
              // (::after) are pseudo-elements, not borders, so the global
              // *:focus-visible border flip cannot turn them white on keyboard
              // focus.
              "btn-press relative inline-flex control-sm items-center gap-1.5 px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-4",
              "before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-border-strong first:before:hidden",
              "after:pointer-events-none after:absolute after:inset-x-0 after:top-0 after:h-0.5",
              selected
                ? "bg-surface-3 text-text-primary after:bg-border-focus"
                : "text-text-muted hover:text-text-primary hover:bg-surface-2",
            )}
          >
            {option.icon != null && <span className="shrink-0">{option.icon}</span>}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
