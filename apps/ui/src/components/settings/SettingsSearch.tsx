import { NavLink } from "react-router";

import { SETTINGS_SEARCH_INDEX, type SettingsSearchEntry } from "../../constants/settings-search";
import { Input } from "../ui";

// Kept small: a result shows the page title plus at most this many matched
// setting labels for context.
const MAX_MATCHED_ITEMS_SHOWN = 3;

export type SettingsSearchResult = {
  entry: SettingsSearchEntry;
  /** Rendered items that matched, for "why this result" context under the title. */
  matchedItems: string[];
};

/**
 * Pure substring match over the static settings index. Every whitespace-
 * separated token must match somewhere in the entry (label, group, items, or
 * keywords) for the entry to qualify. Case-insensitive. Empty query → no
 * results (the caller renders the normal nav instead).
 */
export function matchSettingsSearch(
  query: string,
  entries: SettingsSearchEntry[] = SETTINGS_SEARCH_INDEX,
): SettingsSearchResult[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const results: SettingsSearchResult[] = [];
  for (const entry of entries) {
    const haystacks = [entry.label, entry.group, ...entry.items, ...entry.keywords].map((text) => text.toLowerCase());
    const allTokensMatch = tokens.every((token) => haystacks.some((haystack) => haystack.includes(token)));
    if (!allTokensMatch) continue;
    const matchedItems = entry.items.filter((item) => {
      const lower = item.toLowerCase();
      return tokens.some((token) => lower.includes(token));
    });
    results.push({ entry, matchedItems });
  }
  return results;
}

export function SettingsSearchInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Input
      type="search"
      controlSize="sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && value) {
          e.stopPropagation();
          onChange("");
        }
      }}
      placeholder="Search settings"
      aria-label="Search settings"
    />
  );
}

/**
 * Search results for the settings sidebar. Rendered in place of the nav while
 * a query is active. Access mirrors the nav exactly: hidden tabs never appear,
 * admin-only tabs render disabled with the same "Admins only" hint.
 */
export function SettingsSearchResults({
  query,
  accessByRoute,
  onNavigate,
}: {
  query: string;
  /** Route → access, computed by SettingsPage from SETTINGS_GROUPS + capabilities. */
  accessByRoute: Record<string, "enabled" | "disabled">;
  onNavigate: () => void;
}) {
  const results = matchSettingsSearch(query).filter((result) => accessByRoute[result.entry.to] !== undefined);

  if (results.length === 0) {
    return <p className="px-4 py-2 text-base text-text-muted">No settings match.</p>;
  }

  return (
    <ul className="flex flex-col" aria-label="Settings search results">
      {results.map(({ entry, matchedItems }) => {
        const context = matchedItems.slice(0, MAX_MATCHED_ITEMS_SHOWN).join(" · ");
        const disabled = accessByRoute[entry.to] === "disabled";
        return (
          <li key={entry.to} className="min-w-0">
            {disabled ? (
              <div
                aria-disabled="true"
                title="Admins only"
                className="cursor-not-allowed border-l-2 border-transparent px-4 py-2 text-text-muted"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-base leading-snug">{entry.label}</span>
                  <span className="eyebrow shrink-0">Admins only</span>
                </span>
                {context ? <span className="mt-0.5 block truncate text-sm">{context}</span> : null}
              </div>
            ) : (
              <NavLink
                to={entry.to}
                onClick={onNavigate}
                className="block border-l-2 border-transparent px-4 py-2 transition-colors duration-150 hover:bg-surface-2"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-base leading-snug text-text-primary">{entry.label}</span>
                  <span className="eyebrow shrink-0">{entry.group}</span>
                </span>
                {context ? <span className="mt-0.5 block truncate text-sm text-text-muted">{context}</span> : null}
              </NavLink>
            )}
          </li>
        );
      })}
    </ul>
  );
}
