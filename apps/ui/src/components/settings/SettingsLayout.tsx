import { type ReactNode } from "react";

import { Badge, Button } from "../ui";

export type SettingsScope = "user" | "workspace" | "repository";

const SCOPE_BADGE_COPY: Record<SettingsScope, { label: string; title: string }> = {
  user: { label: "Only you", title: "Changes here affect only your account and sessions." },
  workspace: { label: "Whole workspace", title: "Changes here affect everyone in this workspace." },
  repository: { label: "This repository", title: "Changes here apply to the selected repository." },
};

/** Scope pill for a settings section: who is affected when this changes.
    Render via SettingsSection's `meta` slot. */
export function SettingsScopeBadge({ scope }: { scope: SettingsScope }) {
  const copy = SCOPE_BADGE_COPY[scope];
  return <Badge title={copy.title}>{copy.label}</Badge>;
}

export function SettingsPageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 pb-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1 className={`font-display text-3xl text-text-primary ${eyebrow ? "mt-2" : ""}`}>{title}</h1>
        {description ? (
          <p className="mt-2 max-w-[60ch] text-md leading-relaxed text-text-secondary">{description}</p>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2 sm:pb-1">{action}</div> : null}
    </header>
  );
}

export function SettingsSection({
  title,
  description,
  children,
  meta,
  framed = false,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  meta?: ReactNode;
  /** Use only for true framed tools or repeated entity collections. */
  framed?: boolean;
  /** Extra classes on the section root (e.g. `editorial-fade` when the whole
      section mounts in place of a skeleton). */
  className?: string;
}) {
  return (
    <section className={className ? `scroll-mt-6 ${className}` : "scroll-mt-6"}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-medium text-text-primary">{title}</h2>
          {description ? (
            <p className="mt-2 max-w-[60ch] text-base leading-relaxed text-text-secondary">{description}</p>
          ) : null}
        </div>
        {meta ? <div className="shrink-0">{meta}</div> : null}
      </header>
      <div
        className={
          framed
            ? "mt-3 overflow-hidden border border-border bg-surface-1 [&>*+*]:border-t [&>*+*]:border-border"
            : "mt-4 [&>*+*]:border-t [&>*+*]:border-border"
        }
      >
        {children}
      </div>
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  control,
  hint,
  error,
  badge,
}: {
  title: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Optional status pill rendered inline after the title. Pass a `<Badge>`;
      the caller owns the badge's accessibility role (`status`/`alert`). */
  badge?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 text-md leading-snug text-text-primary">{title}</span>
          {badge ? <span className="shrink-0">{badge}</span> : null}
        </div>
        {description ? <p className="mt-1 text-base leading-relaxed text-text-muted">{description}</p> : null}
        {hint ? <p className="mt-1.5 text-base text-text-muted">{hint}</p> : null}
        {error ? (
          <p role="alert" className="mt-1.5 text-base text-error">
            {error}
          </p>
        ) : null}
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
}

export function SettingsSkeleton({
  rows = 3,
  showHeader = true,
  control = true,
}: {
  rows?: number;
  showHeader?: boolean;
  /** Renders a toggle-shaped placeholder on the right. Disable for pages whose
      rows aren't toggles (text inputs, metric cards) so the skeleton doesn't
      imply a layout it then snaps away from. */
  control?: boolean;
}) {
  return (
    <div role="status" aria-busy="true" aria-label="Loading settings">
      <div className="motion-safe:animate-pulse" aria-hidden="true">
        {showHeader ? <div className="h-3 w-28 bg-surface-2" /> : null}
        <div className={showHeader ? "mt-3 border border-border bg-surface-1" : "border border-border bg-surface-1"}>
          {Array.from({ length: rows }).map((_, index) => (
            <div
              key={index}
              className="flex items-start justify-between gap-6 px-4 py-3 [&+&]:border-t [&+&]:border-border"
            >
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-3.5 w-40 max-w-full bg-surface-2" />
                <div className="h-3 w-64 max-w-full bg-surface-2" />
              </div>
              {control ? <div className="h-[18px] w-8 shrink-0 bg-surface-2" /> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SettingsError({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="editorial-fade border border-error-soft-border bg-error-soft px-4 py-3 text-base text-error"
    >
      <p>{message ?? "Something went wrong loading this section."}</p>
      {onRetry ? (
        <Button type="button" onClick={onRetry} variant="danger" size="sm" className="mt-2.5">
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function SettingsField({
  label,
  htmlFor,
  description,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  description?: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="px-4 py-3">
      <label htmlFor={htmlFor} className="mb-1.5 block text-base text-text-primary">
        {label}
      </label>
      {description ? <p className="mb-2 text-base leading-relaxed text-text-secondary">{description}</p> : null}
      {children}
      {hint ? <p className="mt-1.5 text-base text-text-muted">{hint}</p> : null}
      {error ? (
        <p role="alert" className="mt-1.5 text-base text-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
