import {
  SECRET_IMPORT_KEY_PATTERN,
  SECRET_IMPORT_MAX_USAGE_NOTE_CHARS,
} from "../../../../shared/secrets/import-format.js";

export type EnvBlobEntryMeta = {
  usageNote: string | null;
  sensitive: boolean;
};

export type EnvBlobEntryMetaMap = Record<string, EnvBlobEntryMeta>;

export function emptyEntryMeta(): EnvBlobEntryMeta {
  return { usageNote: null, sensitive: true };
}

export function normalizeUsageNote(note: string | null | undefined): string | null {
  if (note == null) return null;
  const trimmed = note.trim();
  if (!trimmed) return null;
  if (trimmed.length > SECRET_IMPORT_MAX_USAGE_NOTE_CHARS) {
    return trimmed.slice(0, SECRET_IMPORT_MAX_USAGE_NOTE_CHARS);
  }
  return trimmed;
}

export function parseEntryMetaJson(raw: string | null | undefined): EnvBlobEntryMetaMap {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: EnvBlobEntryMetaMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!SECRET_IMPORT_KEY_PATTERN.test(key)) continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        out[key] = emptyEntryMeta();
        continue;
      }
      const record = value as Record<string, unknown>;
      const usageNote =
        record.usageNote === null || record.usageNote === undefined
          ? null
          : typeof record.usageNote === "string"
            ? normalizeUsageNote(record.usageNote)
            : null;
      const sensitive = record.sensitive === false ? false : true;
      out[key] = { usageNote, sensitive };
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeEntryMetaJson(meta: EnvBlobEntryMetaMap): string {
  const sortedKeys = Object.keys(meta).sort((left, right) => left.localeCompare(right));
  const normalized: EnvBlobEntryMetaMap = {};
  for (const key of sortedKeys) {
    const entry = meta[key];
    if (!entry) continue;
    normalized[key] = {
      usageNote: normalizeUsageNote(entry.usageNote),
      sensitive: entry.sensitive !== false,
    };
  }
  return JSON.stringify(normalized);
}

/** Drop metadata for keys that are no longer present in the env map. */
export function pruneEntryMeta(meta: EnvBlobEntryMetaMap, keyNames: readonly string[]): EnvBlobEntryMetaMap {
  const keep = new Set(keyNames);
  const next: EnvBlobEntryMetaMap = {};
  for (const [key, value] of Object.entries(meta)) {
    if (keep.has(key)) next[key] = value;
  }
  return next;
}

export function mergeEntryMetaForKeys(
  existing: EnvBlobEntryMetaMap,
  keys: readonly string[],
  patch: { usageNote?: string | null; sensitive?: boolean },
): EnvBlobEntryMetaMap {
  const next = { ...existing };
  for (const key of keys) {
    const previous = next[key] ?? emptyEntryMeta();
    next[key] = {
      usageNote: patch.usageNote !== undefined ? normalizeUsageNote(patch.usageNote) : previous.usageNote,
      sensitive: patch.sensitive !== undefined ? patch.sensitive !== false : previous.sensitive,
    };
  }
  return next;
}

export function entriesFromImport(
  importEntries: ReadonlyArray<{ key: string; usageNote: string | null }>,
  sensitive: boolean,
  existing: EnvBlobEntryMetaMap,
): EnvBlobEntryMetaMap {
  const next = { ...existing };
  for (const entry of importEntries) {
    next[entry.key] = {
      usageNote: normalizeUsageNote(entry.usageNote),
      sensitive: sensitive !== false,
    };
  }
  return next;
}
