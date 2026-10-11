import { safeHttpsUrl } from "../../../utils/safe-url";
import { EmptyState } from "../../ui";
import type { FileChange } from "../workbench";

export type ChangesPanelProps = {
  changes: FileChange[];
  /** Published PR URL, or null pre-publish. Links the panel to GitHub's exact diff. */
  prUrl: string | null;
};

function PrChangesLink({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-sm text-accent hover:underline">
      View PR changes
    </a>
  );
}

/** Authoritative touched files observed in tool and patch events. */
export function ChangesPanel({ changes, prUrl }: ChangesPanelProps) {
  const prHref = safeHttpsUrl(prUrl);
  const prChangesHref = prHref ? `${prHref}/files` : null;

  if (changes.length === 0) {
    return (
      <EmptyState title="No changes yet." action={prChangesHref ? <PrChangesLink href={prChangesHref} /> : null} />
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="eyebrow">Touched files ({changes.length})</span>
      </div>
      <ul className="flex flex-col gap-px">
        {changes.map((change) => (
          <li key={change.path} className="flex items-center gap-3 px-2 py-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary" title={change.path}>
              {change.path}
            </span>
            {change.edits > 1 && (
              <span className="shrink-0 font-mono-tabular text-xs text-text-muted">{change.edits} edits</span>
            )}
          </li>
        ))}
      </ul>
      {prChangesHref && (
        <div className="px-1 pt-3">
          <PrChangesLink href={prChangesHref} />
        </div>
      )}
    </div>
  );
}
