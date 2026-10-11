import { type ReactNode } from "react";

export type ContextSectionProps = {
  title: ReactNode;
  /** Short prose beneath the section title. */
  description?: ReactNode;
  /** Right-aligned header slot. */
  aside?: ReactNode;
  children: ReactNode;
};

/**
 * A titled, read-only block on the context page. Flat bordered card per the kit
 * (surface-1 + 1px border, sharp corners): a Geist eyebrow label anchors the
 * header, an optional aside sits opposite it, and a sentence-case description
 * appears only when the content is not self-evident.
 */
export function ContextSection({ title, description, aside, children }: ContextSectionProps) {
  return (
    <section className="border border-border bg-surface-1">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="eyebrow min-w-0 truncate">{title}</h2>
        {aside != null && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
      </div>
      <div className="flex flex-col gap-4 p-4">
        {description != null && <p className="max-w-prose text-sm text-text-muted">{description}</p>}
        {children}
      </div>
    </section>
  );
}
