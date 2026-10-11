import { parseMemoryConfidence } from "../../../../shared/memory/context-block";
import {
  insertMemoryConclusionSource,
  insertOrReinforceMemoryConclusion,
  listActiveMemoryConclusionsForScope,
  type MemoryConclusionLevel,
  type MemoryConclusionRow,
  type MemoryConfidence,
  upsertMemoryScopeCard,
} from "./context-db";
import { memoryConclusionSourceEdgeId, memoryContradictionConclusionId, memoryScopeCardId } from "./context-ids";

export type MemoryScopeCardEntryKind =
  | "constraint"
  | "preference"
  | "fact"
  | "open_question"
  | "action_item"
  | "decision"
  | "dead_end"
  | "repo_rule"
  | "observation";

export interface MemoryScopeCardEntry {
  kind: MemoryScopeCardEntryKind;
  content: string;
  conclusionId: string;
  confidence: MemoryConfidence;
  level: MemoryConclusionLevel;
}

export interface MemoryScopeCard {
  version: 1;
  entries: MemoryScopeCardEntry[];
}

export type MemoryScopeCardValidation =
  | { ok: true; card: MemoryScopeCard }
  | { ok: false; reason: "invalid_json" | "invalid_shape" | "invalid_entry_kind" | "behavioral_fluff" | "empty_entry" };

export interface ConsolidateMemoryScopeCardResult {
  status: "written" | "skipped";
  reason: "ok" | "no_conclusions" | "not_idle" | "invalid_card";
  entryCount: number;
}

const MEMORY_SCOPE_CARD_ALLOWED_KINDS: ReadonlySet<MemoryScopeCardEntryKind> = new Set([
  "constraint",
  "preference",
  "fact",
  "open_question",
  "action_item",
  "decision",
  "dead_end",
  "repo_rule",
  "observation",
]);

export async function consolidateMemoryScopeCardForScope(
  db: D1Database,
  params: {
    businessId: string;
    scopeId: string;
    observerPeerId: string;
    observedPeerId: string;
    idleMs: number;
    limit: number;
    nowMs: number;
  },
): Promise<ConsolidateMemoryScopeCardResult> {
  const conclusions = await listActiveMemoryConclusionsForScope(db, {
    businessId: params.businessId,
    scopeId: params.scopeId,
    limit: params.limit,
  });
  if (conclusions.length === 0) return { status: "skipped", reason: "no_conclusions", entryCount: 0 };
  const latestUpdateMs = Math.max(...conclusions.map((conclusion) => conclusion.updatedAtMs));
  if (latestUpdateMs > params.nowMs - params.idleMs) {
    return { status: "skipped", reason: "not_idle", entryCount: 0 };
  }

  await consolidateContradictions(db, params.businessId, conclusions, params.nowMs);

  const card = buildMemoryScopeCard(conclusions);
  const validation = validateMemoryScopeCard(card);
  if (!validation.ok) return { status: "skipped", reason: "invalid_card", entryCount: 0 };
  await upsertMemoryScopeCard(db, {
    id: memoryScopeCardId(params.businessId, params.scopeId, params.observerPeerId, params.observedPeerId),
    businessId: params.businessId,
    scopeId: params.scopeId,
    observerPeerId: params.observerPeerId,
    observedPeerId: params.observedPeerId,
    cardJson: JSON.stringify(validation.card),
    sourceConclusionIdsJson: JSON.stringify(validation.card.entries.map((entry) => entry.conclusionId)),
    status: "active",
    nowMs: params.nowMs,
  });
  return { status: "written", reason: "ok", entryCount: validation.card.entries.length };
}

async function consolidateContradictions(
  db: D1Database,
  businessId: string,
  conclusions: MemoryConclusionRow[],
  nowMs: number,
): Promise<void> {
  const pair = firstContradictionPair(conclusions);
  if (!pair) return;
  const [left, right] = pair;
  const conclusionId = memoryContradictionConclusionId(businessId, left.id, right.id);
  await insertOrReinforceMemoryConclusion(db, {
    id: conclusionId,
    businessId,
    collectionId: left.collectionId,
    scopeId: left.scopeId,
    kind: "contradiction",
    content: `Contradiction: "${left.content}" conflicts with "${right.content}".`,
    level: "contradiction",
    status: "active",
    confidence: "low",
    authority: "inferred",
    enforcement: "none",
    sourceKind: "memory_conclusion",
    sourceId: left.id,
    repoOwner: left.repoOwner,
    repoName: left.repoName,
    validUntilMs: null,
    metadataJson: JSON.stringify({ premiseConclusionIds: [left.id, right.id] }),
    nowMs,
    source: {
      id: memoryConclusionSourceEdgeId(businessId, conclusionId, "memory_conclusion", left.id),
      businessId,
      conclusionId,
      sourceKind: "memory_conclusion",
      sourceId: left.id,
      sourceUri: null,
      excerpt: left.content.slice(0, 500),
      relationship: "contradicts",
      nowMs,
    },
  });
  await insertMemoryConclusionSource(db, {
    id: memoryConclusionSourceEdgeId(businessId, conclusionId, "memory_conclusion", right.id),
    businessId,
    conclusionId,
    sourceKind: "memory_conclusion",
    sourceId: right.id,
    sourceUri: null,
    excerpt: right.content.slice(0, 500),
    relationship: "contradicts",
    nowMs,
  });
}

function firstContradictionPair(conclusions: MemoryConclusionRow[]): [MemoryConclusionRow, MemoryConclusionRow] | null {
  const seen = new Map<string, MemoryConclusionRow>();
  for (const conclusion of conclusions) {
    if (conclusion.level === "contradiction") continue;
    const normalized = normalizedContradictionKey(conclusion.content);
    if (!normalized) continue;
    const oppositeKey = `${normalized.subject}|${normalized.negative ? "positive" : "negative"}|${normalized.predicate}`;
    const opposite = seen.get(oppositeKey);
    if (opposite) {
      const pair: [MemoryConclusionRow, MemoryConclusionRow] =
        opposite.id.localeCompare(conclusion.id) <= 0 ? [opposite, conclusion] : [conclusion, opposite];
      return pair;
    }
    seen.set(
      `${normalized.subject}|${normalized.negative ? "negative" : "positive"}|${normalized.predicate}`,
      conclusion,
    );
  }
  return null;
}

function normalizedContradictionKey(content: string): { subject: string; predicate: string; negative: boolean } | null {
  const normalized = content
    .toLowerCase()
    .replace(/[.。]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const requireMatch = normalized.match(/^(.+?)\s+(does not require|do not require|requires|require)\s+(.+)$/);
  if (requireMatch) {
    return {
      subject: requireMatch[1].trim(),
      predicate: requireMatch[3].trim(),
      negative: requireMatch[2].includes("not"),
    };
  }
  const mustMatch = normalized.match(/^(.+?)\s+(must not|must)\s+(.+)$/);
  if (mustMatch) {
    return {
      subject: mustMatch[1].trim(),
      predicate: mustMatch[3].trim(),
      negative: mustMatch[2].includes("not"),
    };
  }
  return null;
}

export function parseMemoryScopeCardJson(json: string): MemoryScopeCardValidation {
  try {
    return validateMemoryScopeCard(JSON.parse(json));
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

function validateMemoryScopeCard(value: unknown): MemoryScopeCardValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "invalid_shape" };
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.entries)) return { ok: false, reason: "invalid_shape" };
  const entries = record.entries;
  if (entries.length === 0) return { ok: false, reason: "empty_entry" };
  const parsedEntries: MemoryScopeCardEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, reason: "invalid_shape" };
    const entryRecord = entry as Record<string, unknown>;
    const kind = entryRecord.kind;
    const content = typeof entryRecord.content === "string" ? entryRecord.content.trim() : "";
    const conclusionId = typeof entryRecord.conclusionId === "string" ? entryRecord.conclusionId.trim() : "";
    const confidence = parseMemoryConfidence(entryRecord.confidence);
    const level = levelValue(entryRecord.level);
    if (!kind || typeof kind !== "string" || !MEMORY_SCOPE_CARD_ALLOWED_KINDS.has(kind as MemoryScopeCardEntryKind)) {
      return { ok: false, reason: "invalid_entry_kind" };
    }
    if (!content || !conclusionId || !confidence || !level) return { ok: false, reason: "empty_entry" };
    if (looksLikeBehavioralFluff(content)) return { ok: false, reason: "behavioral_fluff" };
    parsedEntries.push({ kind: kind as MemoryScopeCardEntryKind, content, conclusionId, confidence, level });
  }
  return { ok: true, card: { version: 1, entries: parsedEntries.slice(0, 20) } };
}

function buildMemoryScopeCard(conclusions: MemoryConclusionRow[]): MemoryScopeCard {
  return {
    version: 1,
    entries: conclusions
      .flatMap((conclusion): MemoryScopeCardEntry[] => {
        const kind = cardKind(conclusion.kind);
        if (!kind) return [];
        return [
          {
            kind,
            content: conclusion.content,
            conclusionId: conclusion.id,
            confidence: conclusion.confidence,
            level: conclusion.level,
          },
        ];
      })
      .slice(0, 20),
  };
}

function cardKind(kind: string): MemoryScopeCardEntryKind | null {
  if (MEMORY_SCOPE_CARD_ALLOWED_KINDS.has(kind as MemoryScopeCardEntryKind)) return kind as MemoryScopeCardEntryKind;
  if (kind === "repo_rule") return "repo_rule";
  return "observation";
}

function levelValue(value: unknown): MemoryConclusionLevel | null {
  return value === "explicit" || value === "deductive" || value === "inductive" || value === "contradiction"
    ? value
    : null;
}

function looksLikeBehavioralFluff(content: string): boolean {
  const normalized = content.toLowerCase();
  return (
    normalized.startsWith("remember to ") ||
    normalized.startsWith("always ") ||
    normalized.startsWith("never ") ||
    normalized.includes("be careful") ||
    normalized.includes("make sure to")
  );
}
