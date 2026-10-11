import { type ButtonHTMLAttributes, forwardRef } from "react";

import { cx } from "./utils";

export type IconButtonSize = "sm" | "md";

// Square ghost geometry on the kit control ladder: sm = 28x28 (control-sm),
// md = 36x36 (control-md). Icons inherit currentColor and size to 16px.
const sizeClasses: Record<IconButtonSize, string> = {
  sm: "control-sm w-7",
  md: "control-md w-9",
};

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  /**
   * Accessible name (required) — applied as both `aria-label` and `title`.
   * Sentence case, verb-first ("Dismiss", "Copy session ID").
   */
  label: string;
  size?: IconButtonSize;
  /** The icon (a currentColor SVG from components/icons.tsx). */
  children: React.ReactNode;
};

/**
 * Ghost icon-only button — the sanctioned icon-button idiom. Visible geometry
 * stays on the control ladder while `.hit-area-40` (App.css) pads the pointer
 * target to at least 40x40px via an invisible `::after` with negative inset,
 * so dense rows keep tap-friendly targets without visual bulk.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = "sm", className, type = "button", children, title, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      className={cx(
        "btn-press hit-area-40 inline-flex shrink-0 items-center justify-center border border-transparent bg-transparent px-0 text-text-secondary hover:bg-surface-2 hover:text-text-primary active:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-4",
        sizeClasses[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});
