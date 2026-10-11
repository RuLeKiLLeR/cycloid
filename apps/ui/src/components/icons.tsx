// Shared currentColor SVG icons. Replaces the mix of emoji (✅ ⏳ ⬜), text
// glyphs (× ↻ ▸ ⚠ ↑ ↓), and one-off inline SVGs that read as three different
// icon systems. All inherit color via currentColor and size via className.

type IconProps = { className?: string };

const STROKE = {
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function CheckIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

export function CopyIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <rect x="5.5" y="5.5" width="8" height="8" />
      <path d="M10.5 2.5h-8v8" />
    </svg>
  );
}

/** Overflow-menu trigger glyph — three horizontal dots. */
export function EllipsisIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} fill="currentColor">
      <circle cx="3.25" cy="8" r="1.1" />
      <circle cx="8" cy="8" r="1.1" />
      <circle cx="12.75" cy="8" r="1.1" />
    </svg>
  );
}

/** Sort-direction carets — replace the ▴/▾ text glyphs in column headers. */
export function SortAscIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} fill="currentColor">
      <path d="M8 4.5l4 6H4z" />
    </svg>
  );
}

export function SortDescIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} fill="currentColor">
      <path d="M8 11.5l-4-6h8z" />
    </svg>
  );
}

export function SpinnerIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={["animate-spin", className].filter(Boolean).join(" ")} fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function SquareIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <rect x="3" y="3" width="10" height="10" rx="2.5" />
    </svg>
  );
}

export function CaretRightIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

export function DownloadIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <path d="M8 2.5v7" />
      <path d="M5 7l3 3 3-3" />
      <path d="M3 12.5h10" />
    </svg>
  );
}

export function PlusIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

export function ChevronDownIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

export function WarningIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <path d="M8 2.5l6 10.5H2L8 2.5z" />
      <path d="M8 6.5v3" />
      <circle cx="8" cy="11.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function CloseIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function ExpandIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <path d="M6.5 3.5h-3v3" />
      <path d="M3.5 3.5l4 4" />
      <path d="M9.5 12.5h3v-3" />
      <path d="M12.5 12.5l-4-4" />
    </svg>
  );
}

export function DesktopIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <rect x="2.5" y="3" width="11" height="8" rx="1.5" />
      <path d="M6.5 13.5h3" />
      <path d="M8 11v2.5" />
    </svg>
  );
}

export function PanelRightIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M9.5 2.5v11" />
      <path d="M6.75 6l-2 2 2 2" />
    </svg>
  );
}

export function RefreshIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <path d="M13 8a5 5 0 1 1-1.5-3.5" />
      <path d="M13 3v2.5h-2.5" />
    </svg>
  );
}

export function ArchiveIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <rect x="2.5" y="3" width="11" height="3" rx="1" />
      <path d="M3.5 6.5v6a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-6" />
      <path d="M6.5 9h3" />
    </svg>
  );
}

export function GitBranchIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <path d="M4.5 5v5.5" />
      <path d="M6 3.5h2a3.5 3.5 0 0 1 3.5 3.5" />
    </svg>
  );
}

export function PaperclipIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} {...STROKE} strokeWidth={2}>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

export function GithubIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function ChipIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} {...STROKE}>
      <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
      <path d="M6.5 1.5v2M9.5 1.5v2M6.5 12.5v2M9.5 12.5v2M1.5 6.5h2M1.5 9.5h2M12.5 6.5h2M12.5 9.5h2" />
    </svg>
  );
}

/** Todo checklist status icon — replaces the ✅ / ⏳ / ⬜ emoji map. */
export function TodoStatusIcon({ status, className }: { status?: string | null; className?: string }) {
  if (status === "completed") return <CheckIcon className={`text-success ${className ?? ""}`.trim()} />;
  if (status === "in_progress") return <SpinnerIcon className={`text-accent ${className ?? ""}`.trim()} />;
  return <SquareIcon className={`text-text-muted ${className ?? ""}`.trim()} />;
}
