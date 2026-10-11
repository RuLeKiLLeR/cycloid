/**
 * Shared parser for repo→snapshot map env vars (`E2B_REPO_SNAPSHOT_MAP_JSON`,
 * `FREESTYLE_REPO_SNAPSHOT_MAP_JSON`). The map is a JSON object keyed by
 * `owner/repo@branch` (checked first when a branch is known) then `owner/repo`;
 * each value is either a snapshot-id string or `{ snapshotId, allowPrivate }`.
 *
 * Visibility gate: `allowPrivate: true` extends an entry to private or
 * unknown-visibility repos; public repos always qualify. A plain string entry
 * therefore never matches a private/unknown repo — only the object form can
 * opt one in.
 *
 * Errors (malformed JSON / non-object root) are returned, not thrown: callers
 * warn and fall back to the default template/snapshot, so a bad map entry can
 * never block spawns — clearing the entry (or the var) is the kill switch.
 */
export type RepoSnapshotLookupResult =
  { snapshotId: string; key: string; error?: undefined } | { snapshotId: null; key?: undefined; error?: string };

export function lookupRepoSnapshotMap(
  raw: string | undefined,
  args: {
    /** Env var name, used only to label parse errors. */
    varName: string;
    repoOwner: string;
    repoName: string;
    branch: string | null;
    repoPrivate: boolean | undefined;
  },
): RepoSnapshotLookupResult {
  const trimmed = raw?.trim();
  if (!trimmed) return { snapshotId: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { snapshotId: null, error: `invalid ${args.varName}: ${String(error)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { snapshotId: null, error: `${args.varName} must be an object` };
  }

  const map = parsed as Record<string, unknown>;
  const keys = args.branch
    ? [`${args.repoOwner}/${args.repoName}@${args.branch}`, `${args.repoOwner}/${args.repoName}`]
    : [`${args.repoOwner}/${args.repoName}`];
  for (const key of keys) {
    const entry = map[key];
    const entryRecord =
      entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
    const snapshotId = typeof entry === "string" ? entry : entryRecord?.snapshotId;
    // allowPrivate extends an entry to private or unknown-visibility repos; public repos always qualify.
    if (args.repoPrivate !== false && entryRecord?.allowPrivate !== true) continue;
    if (typeof snapshotId !== "string") continue;
    if (snapshotId.trim()) return { snapshotId: snapshotId.trim(), key };
  }
  return { snapshotId: null };
}
