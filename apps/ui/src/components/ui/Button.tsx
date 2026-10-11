import { type ButtonHTMLAttributes, forwardRef } from "react";

import { cx } from "./utils";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "accent";
type ButtonSize = "sm" | "md" | "lg";

export const variantClasses: Record<ButtonVariant, string> = {
  // White ink primary: solid white fill, inverse text, faint white bloom on
  // hover, darkens to gray-9 on press (via .btn-press brightness).
  primary: "glow-white-hover border border-accent bg-accent text-text-inverse active:bg-accent-hover",
  // Bordered outline; border flips to white on hover, surface steps up on press.
  secondary:
    "border border-border-strong bg-transparent text-text-primary hover:border-border-focus active:bg-surface-2",
  // Bordered error; blocked/failed destructive actions only.
  danger:
    "border border-error-soft-border bg-transparent text-error hover:border-error hover:bg-error-soft active:bg-error-soft-hover",
  // Transparent ghost; text brightens, surface steps up.
  ghost:
    "border border-transparent bg-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary active:bg-surface-3",
  // Arcane violet — reserved for live actions. Use sparingly.
  accent:
    "glow-live-hover border border-live bg-live text-on-live hover:border-live-bright hover:bg-live-bright active:bg-live-deep",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "control-sm px-3 text-sm",
  md: "control-md px-4 text-base",
  lg: "control-lg px-5 text-base",
};

// One base string shared by <Button> and buttonClasses() — no drift between the
// component and the class-string helper. `.btn-press` (App.css) owns the
// interactive transition (colors + glow + brightness) on the system curve.
export const baseClasses =
  "btn-press inline-flex shrink-0 items-center justify-center gap-2 font-medium disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Kit button classes for non-<button> elements (links, labels). Same constants
 * as <Button>; prefer the component when rendering an actual button.
 */
export const buttonClasses = ({
  variant = "secondary",
  size = "md",
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}) => cx(baseClasses, variantClasses[variant], sizeClasses[size], className);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className, type = "button", ...props },
  ref,
) {
  return <button ref={ref} type={type} className={buttonClasses({ variant, size, className })} {...props} />;
});
