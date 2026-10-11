import { computeSha256Hex, normalizeWebhookReference } from "../utils";
import type { IngestionEventRow } from "./db";
import { isAllowedMemoryLinkType, type MemoryLinkType } from "./verbs";

export const MEMORY_PAGE_TYPES = [
  "customer",
  "repo",
  "service",
  "person",
  "channel",
  "incident",
  "thread",
  "decision",
  "episode",
] as const;
export type MemoryPageType = (typeof MEMORY_PAGE_TYPES)[number];

export const MEMORY_FACT_KINDS = [
  "decision",
  "constraint",
  "action_item",
  "open_question",
  "preference",
  "fact",
  "dead_end",
  "commitment",
] as const;
export type MemoryFactKind = (typeof MEMORY_FACT_KINDS)[number];

const PAGE_TYPE_SET = new Set<string>(MEMORY_PAGE_TYPES);
const FACT_KIND_SET = new Set<string>(MEMORY_FACT_KINDS);
const MEMORY_SLUG_MAX_CHARS = 200;
const MEMORY_PAGE_TITLE_MAX_CHARS = 500;
const MEMORY_PAGE_SUMMARY_MAX_CHARS = 2_000;
const MEMORY_FACT_CLAIM_MAX_CHARS = 4_000;
const MEMORY_FACT_HOLDER_MAX_CHARS = 200;
const MEMORY_FACT_SOURCE_EVENT_BATCH_SIZE = 99;

export interface MemoryPageInput {
  pageType: MemoryPageType;
  slug: string;
  title: string;
  summary?: string | null;
  effectiveAtMs?: number | null;
}

export interface MemoryFactInput {
  kind: MemoryFactKind;
  claim: string;
  holder: string;
  confidence: number;
  durable: boolean;
  effectiveAtMs?: number | null;
  validUntilMs?: number | null;
  dueAtMs?: number | null;
}

export interface MemoryLinkInput {
  from: { pageType: MemoryPageType; slug: string };
  to: { pageType: MemoryPageType; slug: string };
  linkType: MemoryLinkType;
  context?: string | null;
}

export interface MemoryWriteInput {
  event: IngestionEventRow;
  pages: MemoryPageInput[];
  facts: MemoryFactInput[];
  links: MemoryLinkInput[];
}

export interface MemoryFactRow {
  id: string;
  businessId: string;
  kind: MemoryFactKind;
  claim: string;
  holder: string;
  confidence: number;
  sourceEventId: string;
}

function normalizeSlug(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized ? normalized.slice(0, MEMORY_SLUG_MAX_CHARS).replace(/-+$/g, "") || null : null;
}

function truncateTrimmed(value: string, maxChars: number): string {
  return value.trim().slice(0, maxChars).trim();
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function pageKey(pageType: MemoryPageType, slug: string): string {
  return `${pageType}:${slug}`;
}

async function stableId(prefix: string, parts: Array<string | number | null | undefined>): Promise<string> {
  return `${prefix}_${await computeSha256Hex(parts.map((part) => String(part ?? "")).join("\u001f"))}`;
}

function asSafeMs(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
}

export function coerceMemoryPage(input: Record<string, unknown>): MemoryPageInput | null {
  const pageType = normalizeWebhookReference(input.page_type ?? input.pageType);
  const slug = normalizeSlug(normalizeWebhookReference(input.slug) ?? "");
  const title = typeof input.title === "string" ? truncateTrimmed(input.title, MEMORY_PAGE_TITLE_MAX_CHARS) : "";
  if (!pageType || !PAGE_TYPE_SET.has(pageType) || !slug || !title) return null;
  return {
    pageType: pageType as MemoryPageType,
    slug,
    title,
    summary:
      typeof input.summary === "string" && input.summary.trim()
        ? truncateTrimmed(input.summary, MEMORY_PAGE_SUMMARY_MAX_CHARS)
        : null,
  };
}

export function coerceMemoryFact(input: Record<string, unknown>): MemoryFactInput | null {
  const kind = normalizeWebhookReference(input.kind);
  const claim = typeof input.claim === "string" ? truncateTrimmed(input.claim, MEMORY_FACT_CLAIM_MAX_CHARS) : "";
  const holder =
    typeof input.holder === "string" && input.holder.trim()
      ? truncateTrimmed(input.holder, MEMORY_FACT_HOLDER_MAX_CHARS)
      : "brain";
  const confidence = typeof input.confidence === "number" ? input.confidence : 0.5;
  if (!kind || !FACT_KIND_SET.has(kind) || !claim || input.durable !== true) return null;
  return {
    kind: kind as MemoryFactKind,
    claim,
    holder,
    confidence: clampConfidence(confidence),
    durable: true,
    effectiveAtMs: parseDateMs(input.effective_date),
    validUntilMs: parseDateMs(input.valid_until),
    dueAtMs: parseDateMs(input.due_at),
  };
}

export function coerceMemoryLink(input: Record<string, unknown>): MemoryLinkInput | null {
  const linkType = normalizeWebhookReference(input.link_type ?? input.linkType);
  const from = typeof input.from === "object" && input.from ? coerceMemoryPageRef(input.from) : null;
  const to = typeof input.to === "object" && input.to ? coerceMemoryPageRef(input.to) : null;
  if (!linkType || !isAllowedMemoryLinkType(linkType) || !from || !to) return null;
  return { from, to, linkType };
}

export function coerceMemoryPageRef(input: object): { pageType: MemoryPageType; slug: string } | null {
  const record = input as Record<string, unknown>;
  const pageType = normalizeWebhookReference(record.page_type ?? record.pageType);
  const slug = normalizeSlug(normalizeWebhookReference(record.slug) ?? "");
  if (!pageType || !PAGE_TYPE_SET.has(pageType) || !slug) return null;
  return { pageType: pageType as MemoryPageType, slug };
}

function parseDateMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export async function writeMemoryRefineOutput(db: D1Database, input: MemoryWriteInput): Promise<void> {
  const businessId = input.event.businessId;
  const pageIds = new Map<string, string>();
  const statements: D1PreparedStatement[] = [];

  for (const page of input.pages) {
    const slug = normalizeSlug(page.slug);
    if (!slug) continue;
    const id = await stableId("mp", [businessId, page.pageType, slug]);
    pageIds.set(pageKey(page.pageType, slug), id);
    statements.push(
      db
        .prepare(
          `INSERT INTO memory_pages
           (id, business_id, page_type, slug, title, summary, effective_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(business_id, page_type, slug) DO UPDATE SET
             title = excluded.title,
             summary = COALESCE(excluded.summary, memory_pages.summary),
             effective_at_ms = COALESCE(excluded.effective_at_ms, memory_pages.effective_at_ms),
             updated_at_ms = unixepoch() * 1000,
             deleted_at_ms = NULL`,
        )
        .bind(id, businessId, page.pageType, slug, page.title, page.summary ?? null, asSafeMs(page.effectiveAtMs)),
    );
    statements.push(provenanceStatement(db, "page", id, input.event.id, businessId));
  }

  for (const fact of input.facts) {
    const claim = fact.claim.trim();
    if (!claim) continue;
    const id = await stableId("mf", [businessId, input.event.id, fact.kind, claim]);
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO memory_facts
           (id, business_id, kind, claim, holder, confidence, effective_at_ms, valid_until_ms, due_at_ms, source_event_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          businessId,
          fact.kind,
          claim,
          fact.holder,
          clampConfidence(fact.confidence),
          asSafeMs(fact.effectiveAtMs),
          asSafeMs(fact.validUntilMs),
          asSafeMs(fact.dueAtMs),
          input.event.id,
        ),
    );
    statements.push(provenanceStatement(db, "fact", id, input.event.id, businessId));
  }

  for (const link of input.links) {
    const fromId = pageIds.get(pageKey(link.from.pageType, link.from.slug));
    const toId = pageIds.get(pageKey(link.to.pageType, link.to.slug));
    if (!fromId || !toId) continue;
    const id = await stableId("ml", [businessId, fromId, toId, link.linkType, input.event.id]);
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO memory_links
           (id, business_id, from_page_id, to_page_id, link_type, link_source, origin_event_id, context)
           VALUES (?, ?, ?, ?, ?, 'extracted', ?, ?)`,
        )
        .bind(id, businessId, fromId, toId, link.linkType, input.event.id, link.context ?? null),
    );
    statements.push(provenanceStatement(db, "link", id, input.event.id, businessId));
  }

  statements.push(
    db
      .prepare(
        `UPDATE ingestion_events
         SET processing_state = 'complete', processed_at_ms = unixepoch() * 1000
         WHERE id = ? AND business_id = ?`,
      )
      .bind(input.event.id, businessId),
  );

  if (statements.length > 0) await db.batch(statements);
}

function provenanceStatement(
  db: D1Database,
  memoryKind: "fact" | "link" | "page",
  memoryId: string,
  sourceEventId: string,
  businessId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO memory_provenance
       (memory_kind, memory_id, source_event_id, business_id)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(memoryKind, memoryId, sourceEventId, businessId);
}

export async function listMemoryFactsForSourceEvents(
  db: D1Database,
  businessId: string,
  sourceEventIds: string[],
): Promise<Map<string, MemoryFactRow[]>> {
  const uniqueSourceEventIds = [...new Set(sourceEventIds.filter((id) => id.trim()))];
  const factsBySourceEventId = new Map<string, MemoryFactRow[]>();
  for (const sourceEventId of uniqueSourceEventIds) {
    factsBySourceEventId.set(sourceEventId, []);
  }
  for (let offset = 0; offset < uniqueSourceEventIds.length; offset += MEMORY_FACT_SOURCE_EVENT_BATCH_SIZE) {
    const batch = uniqueSourceEventIds.slice(offset, offset + MEMORY_FACT_SOURCE_EVENT_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    const result = await db
      .prepare(
        `SELECT id, business_id, kind, claim, holder, confidence, source_event_id
         FROM memory_facts
         WHERE business_id = ? AND source_event_id IN (${placeholders})
         ORDER BY source_event_id ASC, created_at_ms ASC`,
      )
      .bind(businessId, ...batch)
      .all<{
        id: string;
        business_id: string;
        kind: MemoryFactKind;
        claim: string;
        holder: string;
        confidence: number;
        source_event_id: string;
      }>();
    for (const row of result.results) {
      const facts = factsBySourceEventId.get(row.source_event_id);
      if (!facts) continue;
      facts.push({
        id: row.id,
        businessId: row.business_id,
        kind: row.kind,
        claim: row.claim,
        holder: row.holder,
        confidence: row.confidence,
        sourceEventId: row.source_event_id,
      });
    }
  }
  return factsBySourceEventId;
}
