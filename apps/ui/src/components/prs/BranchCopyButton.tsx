import { type MouseEvent } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { GitBranchIcon } from "../icons";
import { cx } from "../ui";

type IconProps = { className?: string };

const STROKE = {
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function CopyMini({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <rect x="5.5" y="5.5" width="8" height="8" />
      <path d="M10.5 2.5h-8v8" />
    </svg>
  );
}

function CheckMini({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

export type BranchCopyButtonProps = {
  branch: string;
  className?: string;
};

/**
 * Branch readout that copies its name on click. Sits inside PR rows whose
 * surrounding elements navigate, so the handler stops propagation. The
 * confirmation is a brief icon swap driven by useCopyToClipboard.
 */
export function BranchCopyButton({ branch, className }: BranchCopyButtonProps) {
  const [copied, copy] = useCopyToClipboard();

  return (
    <button
      type="button"
      onClick={(event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        copy(branch);
      }}
      aria-label={`Copy branch ${branch}`}
      title={copied ? "Copied" : `Copy ${branch}`}
      className={cx(
        "group/branch flex min-w-0 items-center gap-1 bg-transparent text-left text-xs text-text-muted transition-colors hover:text-text-primary",
        className,
      )}
    >
      <GitBranchIcon className="size-3 shrink-0" />
      <span className="truncate font-mono-tabular">{branch}</span>
      {copied ? (
        <CheckMini className="size-3 shrink-0 text-text-primary" />
      ) : (
        <CopyMini className="size-3 shrink-0 opacity-0 transition-opacity duration-[--duration-fast] group-hover/branch:opacity-100 group-focus-visible/branch:opacity-100" />
      )}
    </button>
  );
}
