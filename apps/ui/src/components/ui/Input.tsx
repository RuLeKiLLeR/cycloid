import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

import { ChevronDownIcon } from "../icons";
import { cx } from "./utils";

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  controlSize?: "sm" | "md" | "lg";
};

const inputSizeClasses = {
  sm: "control-sm text-sm",
  md: "control-md text-base",
  lg: "control-lg text-base",
} as const;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { controlSize = "md", className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cx(
        "w-full border border-border-strong bg-surface-1 px-3 text-text-primary placeholder:text-text-muted transition-colors hover:border-border-hover focus-visible:border-border-focus disabled:cursor-not-allowed disabled:opacity-40",
        inputSizeClasses[controlSize],
        className,
      )}
      {...props}
    />
  );
});

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cx(
        "control-textarea w-full border border-border-strong bg-surface-1 text-base text-text-primary placeholder:text-text-muted transition-colors hover:border-border-hover focus-visible:border-border-focus disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
});

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  wrapperClassName?: string;
  controlSize?: "sm" | "md" | "lg";
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, wrapperClassName, children, controlSize = "md", ...props },
  ref,
) {
  return (
    <div className={cx("relative", wrapperClassName)}>
      <select
        ref={ref}
        className={cx(
          "w-full cursor-pointer appearance-none border border-border-strong bg-surface-1 px-3 pr-9 text-text-primary transition-colors hover:border-border-hover focus-visible:border-border-focus disabled:cursor-not-allowed disabled:opacity-40",
          inputSizeClasses[controlSize],
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
    </div>
  );
});
