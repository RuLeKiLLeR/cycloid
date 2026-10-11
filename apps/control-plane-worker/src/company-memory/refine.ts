import { GPT54_MINI_SIDECAR_REASONING_EFFORT } from "../../../../shared/constants/models.js";
import { OpenAIServiceTier } from "../../../../shared/enums/openai-service-tier.js";
import type { StructuredOutputTool } from "../../../../shared/llm/structured-output.js";
import {
  MEMORY_AGENT_MAX_TOKENS_PER_TURN,
  MEMORY_AGENT_MODEL,
  MEMORY_AGENT_TOTAL_TIMEOUT_MS,
} from "../constants/memory";
import { createLogger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { queryPlatformStructuredOutput } from "../services/platform-structured-output";
import type { Env } from "../types";
import {
  coerceMemoryFact,
  coerceMemoryLink,
  coerceMemoryPage,
  MEMORY_PAGE_TYPES,
  type MemoryFactInput,
  type MemoryLinkInput,
  type MemoryPageInput,
  writeMemoryRefineOutput,
} from "./core-db";
import {
  claimPendingIngestionEvent,
  getIngestionEvent,
  markIngestionEventSkipped,
  resetIngestionEventPending,
} from "./db";
import { isAllowedMemoryLinkType, MEMORY_LINK_TYPES } from "./verbs";

const log = createLogger({ bindings: { component: "company-memory-refine" } });
const REFINE_MAX_ATTEMPTS = 3;

export interface MemoryRefineQueueMessage {
  businessId: string;
  ingestionEventId: string;
  trigger: "auto" | "on_demand";
}

interface RefineOutput {
  facts?: unknown[];
  entities?: unknown[];
  edges?: unknown[];
}

const REFINE_TOOL: StructuredOutputTool = {
  name: "submit_memory_refine",
  description: "Extract typed company memory from one source event.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      facts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: {
              type: "string",
              enum: [
                "decision",
                "constraint",
                "action_item",
                "open_question",
                "preference",
                "fact",
                "dead_end",
                "commitment",
              ],
            },
            claim: { type: "string" },
            holder: { type: "string" },
            confidence: { type: "number" },
            durable: {
              type: "boolean",
              description:
                "True only when this is durable company memory. False for user instructions, one-off requests, report-only directions, tool-call instructions, or prompt metadata.",
            },
            effective_date: { type: ["string", "null"] },
            valid_until: { type: ["string", "null"] },
            due_at: { type: ["string", "null"] },
          },
          required: ["kind", "claim", "holder", "confidence", "durable", "effective_date", "valid_until", "due_at"],
        },
      },
      entities: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            page_type: { type: "string", enum: [...MEMORY_PAGE_TYPES] },
            slug: { type: "string" },
            title: { type: "string" },
            summary: { type: ["string", "null"] },
          },
          required: ["page_type", "slug", "title", "summary"],
        },
      },
      edges: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            from: {
              type: "object",
              additionalProperties: false,
              properties: { page_type: { type: "string", enum: [...MEMORY_PAGE_TYPES] }, slug: { type: "string" } },
              required: ["page_type", "slug"],
            },
            to: {
              type: "object",
              additionalProperties: false,
              properties: { page_type: { type: "string", enum: [...MEMORY_PAGE_TYPES] }, slug: { type: "string" } },
              required: ["page_type", "slug"],
            },
            link_type: { type: "string", enum: [...MEMORY_LINK_TYPES] },
          },
          required: ["from", "to", "link_type"],
        },
      },
    },
    required: ["facts", "entities", "edges"],
  },
};

export async function enqueueMemoryRefineIfPending(
  env: Env,
  result: { created: boolean; id: string },
  businessId: string,
): Promise<void> {
  if (!result.created || !env.MEMORY_REFINE_QUEUE) return;
  await env.MEMORY_REFINE_QUEUE.send({
    businessId,
    ingestionEventId: result.id,
    trigger: "auto",
  } satisfies MemoryRefineQueueMessage);
}

export async function handleMemoryRefineQueue(batch: MessageBatch<MemoryRefineQueueMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await refineIngestionEvent(env, msg.body);
      msg.ack();
    } catch (err) {
      log.error({ err: String(err), body: msg.body }, "Memory refine failed");
      // Console logs are not shipped to Datadog (logpush is off); direct-post
      // so the [Memory] refine-failures monitor can fire.
      await postStructuredEventToDd(env, { event: "memory.refine_failed", error: String(err) });
      msg.retry({ delaySeconds: 30 });
    }
  }
}

export async function refineIngestionEvent(
  env: Env,
  message: MemoryRefineQueueMessage,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<{ status: "complete" | "skipped"; reason?: string }> {
  const event = await getIngestionEvent(env.DB, message.businessId, message.ingestionEventId);
  if (!event) return { status: "skipped", reason: "event_missing" };
  if (event.processingState === "complete") return { status: "skipped", reason: "already_complete" };
  if (event.processingState === "quarantined") return { status: "skipped", reason: "quarantined" };
  if (event.processingState !== "pending") return { status: "skipped", reason: "already_processing" };

  const claimedEvent = await claimPendingIngestionEvent(env.DB, event.businessId, event.id);
  if (!claimedEvent) return { status: "skipped", reason: "already_processing" };
  if (!claimedEvent.contentText?.trim()) {
    await markIngestionEventSkipped(env.DB, claimedEvent.id, claimedEvent.businessId, "empty_content");
    return { status: "skipped", reason: "empty_content" };
  }

  const budget = await reserveMemoryRefineBudget(env, claimedEvent.businessId);
  if (!budget) {
    await markIngestionEventSkipped(env.DB, claimedEvent.id, claimedEvent.businessId, "budget_exceeded");
    return { status: "skipped", reason: "budget_exceeded" };
  }

  try {
    const refineTimeoutMs = normalizeRefineTimeoutMs(options?.timeoutMs);
    const raw = (await queryPlatformStructuredOutput(
      env,
      {
        model: MEMORY_AGENT_MODEL,
        reasoningEffort: GPT54_MINI_SIDECAR_REASONING_EFFORT,
        tool: REFINE_TOOL,
        systemPrompt:
          "Extract durable company memory. Only emit self-contained claims directly supported by the source. Mark durable=false for user instructions, one-off requests, report-only directions, tool-call instructions, prompt metadata, or anything the company should not remember as a fact. Do not invent dates, owners, services, or relationships.",
        userPrompt: buildRefinePrompt(claimedEvent),
        maxTokens: MEMORY_AGENT_MAX_TOKENS_PER_TURN,
        timeoutMs: refineTimeoutMs,
        signal: options?.signal,
        serviceTier: OpenAIServiceTier.Flex,
        strictErrors: true,
        retry: { maxAttempts: REFINE_MAX_ATTEMPTS },
        spanName: "company_memory.refine",
      },
      {
        subsystem: "company_memory",
        callType: "memory_refine",
        phase: "background",
        sourceId: `memory_refine:${claimedEvent.businessId}:${claimedEvent.id}`,
        businessId: claimedEvent.businessId,
      },
      { logger: log },
    )) as RefineOutput;
    const parsed = parseRefineOutput(raw);
    await writeMemoryRefineOutput(env.DB, { event: claimedEvent, ...parsed });
    await settleMemoryRefineBudget(env, budget, budget.reservedUsdMicros);
    return { status: "complete" };
  } catch (err) {
    await releaseMemoryRefineBudget(env, budget);
    await resetIngestionEventPending(env.DB, claimedEvent.id, claimedEvent.businessId);
    throw err;
  }
}

function normalizeRefineTimeoutMs(timeoutMs: number | undefined): number {
  return Math.max(1, Math.min(MEMORY_AGENT_TOTAL_TIMEOUT_MS, Math.floor(timeoutMs ?? MEMORY_AGENT_TOTAL_TIMEOUT_MS)));
}

function buildRefinePrompt(event: { sourceUri: string; sourceTimeMs: number; contentText: string | null }): string {
  return [
    `Source URI: ${event.sourceUri}`,
    `Source time: ${new Date(event.sourceTimeMs).toISOString()}`,
    "",
    "Source text:",
    event.contentText ?? "",
  ].join("\n");
}

function parseRefineOutput(raw: RefineOutput): {
  pages: MemoryPageInput[];
  facts: MemoryFactInput[];
  links: MemoryLinkInput[];
} {
  const pages = (Array.isArray(raw.entities) ? raw.entities : [])
    .map((entry) => (typeof entry === "object" && entry ? coerceMemoryPage(entry as Record<string, unknown>) : null))
    .filter((entry): entry is MemoryPageInput => Boolean(entry));
  const facts = (Array.isArray(raw.facts) ? raw.facts : [])
    .map((entry) => (typeof entry === "object" && entry ? coerceMemoryFact(entry as Record<string, unknown>) : null))
    .filter((entry): entry is MemoryFactInput => Boolean(entry));
  const modelLinks = (Array.isArray(raw.edges) ? raw.edges : [])
    .map((entry) => {
      if (typeof entry !== "object" || !entry) return null;
      const record = entry as Record<string, unknown>;
      const link = coerceMemoryLink(record);
      if (!link && typeof record.link_type === "string" && !isAllowedMemoryLinkType(record.link_type)) {
        log.warn({ linkType: record.link_type }, "Dropped disallowed memory link type");
      }
      return link;
    })
    .filter((entry): entry is MemoryLinkInput => Boolean(entry));
  const pageKeys = new Set(pages.map((page) => memoryPageKey(page.pageType, page.slug)));
  const links = modelLinks.filter((link) => {
    const fromKey = memoryPageKey(link.from.pageType, link.from.slug);
    const toKey = memoryPageKey(link.to.pageType, link.to.slug);
    if (pageKeys.has(fromKey) && pageKeys.has(toKey)) return true;
    log.warn(
      {
        fromPageType: link.from.pageType,
        fromSlug: link.from.slug,
        toPageType: link.to.pageType,
        toSlug: link.to.slug,
        linkType: link.linkType,
      },
      "Dropped memory link with unresolved endpoint",
    );
    return false;
  });
  return { pages, facts, links: dedupeLinks(links) };
}

function dedupeLinks(links: MemoryLinkInput[]): MemoryLinkInput[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${memoryPageKey(link.from.pageType, link.from.slug)}:${memoryPageKey(link.to.pageType, link.to.slug)}:${link.linkType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function memoryPageKey(pageType: string, slug: string): string {
  return `${pageType}:${slug}`;
}

interface BudgetReservation {
  reservedUsdMicros: number;
  month: string;
  now: number;
  key: string;
}

const DEFAULT_REFINE_MONTHLY_CAP_USD_MICROS = 50_000_000;
const DEFAULT_REFINE_ESTIMATE_USD_MICROS = 250_000;

async function reserveMemoryRefineBudget(env: Env, businessId: string): Promise<BudgetReservation | null> {
  const now = Date.now();
  const monthlyLimitUsdMicros = parseBudgetCap(env.MEMORY_REFINE_MONTHLY_USD_CAP_PER_BUSINESS);
  const key = `memory-refine:${businessId}`;
  if (!env.OPENAI_GATEWAY_BUDGET) {
    return {
      key,
      reservedUsdMicros: DEFAULT_REFINE_ESTIMATE_USD_MICROS,
      month: new Date(now).toISOString().slice(0, 7),
      now,
    };
  }
  const id = env.OPENAI_GATEWAY_BUDGET.idFromName(key);
  const response = await env.OPENAI_GATEWAY_BUDGET.get(id).fetch("https://internal/budget/reserve", {
    method: "POST",
    body: JSON.stringify({
      estimateUsdMicros: DEFAULT_REFINE_ESTIMATE_USD_MICROS,
      monthlyLimitUsdMicros,
      now,
    }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { reservedUsdMicros?: unknown; month?: unknown };
  if (typeof body.reservedUsdMicros !== "number") return null;
  return {
    key,
    reservedUsdMicros: body.reservedUsdMicros,
    month: typeof body.month === "string" ? body.month : new Date(now).toISOString().slice(0, 7),
    now,
  };
}

async function settleMemoryRefineBudget(env: Env, budget: BudgetReservation, actualUsdMicros: number): Promise<void> {
  if (!env.OPENAI_GATEWAY_BUDGET) return;
  const id = env.OPENAI_GATEWAY_BUDGET.idFromName(budget.key);
  const response = await env.OPENAI_GATEWAY_BUDGET.get(id).fetch("https://internal/budget/settle", {
    method: "POST",
    body: JSON.stringify({
      reservedUsdMicros: budget.reservedUsdMicros,
      actualUsdMicros,
      month: budget.month,
      now: budget.now,
    }),
  });
  logMemoryBudgetFailure(response, budget, "settle");
}

async function releaseMemoryRefineBudget(env: Env, budget: BudgetReservation): Promise<void> {
  if (!env.OPENAI_GATEWAY_BUDGET) return;
  const id = env.OPENAI_GATEWAY_BUDGET.idFromName(budget.key);
  const response = await env.OPENAI_GATEWAY_BUDGET.get(id).fetch("https://internal/budget/release", {
    method: "POST",
    body: JSON.stringify({
      reservedUsdMicros: budget.reservedUsdMicros,
      month: budget.month,
      now: budget.now,
    }),
  });
  logMemoryBudgetFailure(response, budget, "release");
}

function logMemoryBudgetFailure(response: Response, budget: BudgetReservation, operation: "release" | "settle"): void {
  if (response.ok) return;
  log.error(
    {
      budgetKeyId: budget.key,
      operation,
      status: response.status,
    },
    "Company memory budget DO call failed",
  );
}

function parseBudgetCap(value: string | undefined): number {
  const parsed = value ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_REFINE_MONTHLY_CAP_USD_MICROS;
}
