import { type MouseEvent, type ReactNode } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { CheckIcon, CopyIcon } from "../icons";
import { IconButton, type IconButtonSize } from "./IconButton";
import { cx } from "./utils";

export type CopyButtonProps = {
  /** Text written to the clipboard. */
  value: string;
  /**
   * Accessible name — `aria-label` + `title`. Sentence case, verb-first
   * ("Copy branch main", "Copy session ID").
   */
  label: string;
  /**
   * Visible content (text variant). Omit for the icon-only affordance, which
   * renders through IconButton (28px ghost square, 40x40 hit area).
   */
  children?: ReactNode;
  /** Content swapped in while the copied confirmation is active. */
  copiedChildren?: ReactNode;
  /** Title/announcement while copied. */
  copiedLabel?: string;
  size?: IconButtonSize;
  /**
   * Text variant only: render the trailing copy/check swap icon. Set false for
   * pure text swaps ("Copy" -> "Copied" via copiedChildren).
   */
  showIcon?: boolean;
  /**
   * Text variant only: keep the copy icon invisible until the button is
   * hovered or keyboard-focused (for readouts embedded in navigating rows).
   */
  revealIconOnHover?: boolean;
  className?: string;
  disabled?: boolean;
  /** Confirmation reset window; defaults to the useCopyToClipboard constant. */
  resetMs?: number;
};

/**
 * The sanctioned copy affordance. Wraps the canonical useCopyToClipboard hook
 * with the built-in copy -> check confirmation swap. Clicks never bubble:
 * copy buttons sit inside rows and cards that navigate, so the handler always
 * calls preventDefault + stopPropagation.
 */
export function CopyButton({
  value,
  label,
  children,
  copiedChildren,
  copiedLabel = "Copied",
  size = "sm",
  showIcon = true,
  revealIconOnHover = false,
  className,
  disabled,
  resetMs,
}: CopyButtonProps) {
  const [copied, copy] = useCopyToClipboard(resetMs);

  const onClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    copy(value);
  };

  if (children == null) {
    return (
      <IconButton
        label={label}
        title={copied ? copiedLabel : label}
        size={size}
        onClick={onClick}
        disabled={disabled}
        className={className}
      >
        {copied ? <CheckIcon className="text-text-primary" /> : <CopyIcon />}
      </IconButton>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={copied ? copiedLabel : label}
      className={cx(
        "group/copy inline-flex min-w-0 items-center gap-1 bg-transparent text-left text-text-muted transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
    >
      {copied && copiedChildren != null ? copiedChildren : children}
      {showIcon &&
        (copied ? (
          <CheckIcon className="size-3 shrink-0 text-text-primary" />
        ) : (
          <CopyIcon
            className={cx(
              "size-3 shrink-0",
              revealIconOnHover &&
                "opacity-0 transition-opacity duration-[--duration-fast] group-hover/copy:opacity-100 group-focus-visible/copy:opacity-100",
            )}
          />
        ))}
    </button>
  );
}
