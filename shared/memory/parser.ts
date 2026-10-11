/**
 * Parser/serializer for Memory 2.0 files under .cycloid/memory/**.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { isRecord } from "../utils/type-guards.js";

export const MEMORY_ROOT_DIR = ".cycloid/memory";
export const MEMORY_IGNORED_FILENAMES = new Set(["README.md", "index.md"]);

export const MEMORY_VERTICALS = ["engineering"] as const;
export const MEMORY_TYPES = ["factual", "interaction", "action"] as const;
export const MEMORY_ACTION_TYPES = ["procedure", "trigger", "execution", "outcome"] as const;
export const MEMORY_LEVELS = ["strategic", "tactical", "gotcha"] as const;
export const MEMORY_PRIMITIVES = [
  "entity",
  "artifact",
  "claim",
  "assumption",
  "decision",
  "commitment",
  "procedure",
  "trigger",
  "execution",
  "outcome",
  "gotcha",
  "conflict",
] as const;
export const MEMORY_STATUSES = ["proposed", "active", "superseded", "rejected"] as const;
export const MEMORY_CONFIDENCES = ["low", "medium", "high"] as const;
export const MEMORY_AUTHORITIES = ["inferred", "reviewed", "source_of_truth"] as const;
export const MEMORY_ENFORCEMENTS = ["none", "suggest", "warn", "block"] as const;
export const ENGINEERING_DOMAINS = [
  "architecture",
  "code_structure",
  "data_model",
  "data_persistence",
  "external_interface",
  "runtime_behavior",
  "testing",
  "build_deploy",
  "security",
  "observability",
  "dependencies",
  "developer_workflow",
  "review_preference",
] as const;

type ValueOf<T extends readonly string[]> = T[number];

export type MemoryVertical = ValueOf<typeof MEMORY_VERTICALS>;
export type MemoryType = ValueOf<typeof MEMORY_TYPES>;
export type MemoryActionType = ValueOf<typeof MEMORY_ACTION_TYPES>;
export type MemoryLevel = ValueOf<typeof MEMORY_LEVELS>;
export type MemoryPrimitive = ValueOf<typeof MEMORY_PRIMITIVES>;
export type MemoryStatus = ValueOf<typeof MEMORY_STATUSES>;
export type MemoryConfidence = ValueOf<typeof MEMORY_CONFIDENCES>;
export type MemoryAuthority = ValueOf<typeof MEMORY_AUTHORITIES>;
export type MemoryEnforcement = ValueOf<typeof MEMORY_ENFORCEMENTS>;
export type EngineeringDomain = ValueOf<typeof ENGINEERING_DOMAINS>;

export interface MemoryEvidence {
  type: string;
  ref: string;
}

export interface MemoryTriggers {
  tools: string[];
  path_globs: string[];
  command_patterns: string[];
  forbidden_patterns: string[];
  mcp_tools: string[];
}

export interface MemoryFile {
  id: string;
  vertical: MemoryVertical;
  memory_type: MemoryType;
  action_type: MemoryActionType | null;
  level: MemoryLevel;
  primitive: MemoryPrimitive;
  engineering_domains: EngineeringDomain[];
  subjects: string[];
  symbols: string[];
  tags: string[];
  status: MemoryStatus;
  confidence: MemoryConfidence;
  authority: MemoryAuthority;
  owner: string | null;
  applies_to: string[];
  context_hint: string;
  source_pr_urls: string[];
  source_session_ids: string[];
  evidence: MemoryEvidence[];
  enforcement: MemoryEnforcement;
  triggers: MemoryTriggers | null;
  supersedes: string[];
  contradicts: string[];
  created_at: string;
  updated_at: string;
  content: string;
}

export interface Memory {
  id: string;
  content: string;
  context_hint: string;
  memory_type: MemoryType;
  action_type: MemoryActionType | null;
  type: string;
  level: MemoryLevel;
  primitive: MemoryPrimitive;
  status: MemoryStatus;
  confidence: MemoryConfidence;
  authority: MemoryAuthority;
  enforcement: MemoryEnforcement;
  applies_to: string[];
  subjects: string[];
  symbols: string[];
  tags: string[];
  source_pr_urls: string[];
  source_pr_number: number | null;
  source_session_ids: string[];
  referenced_files: string | null;
  triggers: MemoryTriggers | null;
  scope: "repo";
}

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

const REQUIRED_STRING_FIELDS = [
  "id",
  "vertical",
  "memory_type",
  "level",
  "primitive",
  "status",
  "confidence",
  "authority",
  "context_hint",
  "created_at",
  "updated_at",
] as const;

const FRONTMATTER_FIELD_ORDER = [
  "id",
  "vertical",
  "memory_type",
  "action_type",
  "level",
  "primitive",
  "engineering_domains",
  "subjects",
  "symbols",
  "tags",
  "status",
  "confidence",
  "authority",
  "owner",
  "applies_to",
  "context_hint",
  "source_pr_urls",
  "source_session_ids",
  "evidence",
  "enforcement",
  "triggers",
  "supersedes",
  "contradicts",
  "created_at",
  "updated_at",
] as const;

const MEMORY_TYPE_PRIMITIVES: Record<MemoryType, ReadonlySet<MemoryPrimitive>> = {
  factual: new Set(["entity", "artifact", "claim", "assumption"]),
  interaction: new Set(["decision", "commitment", "conflict"]),
  action: new Set(["procedure", "trigger", "execution", "outcome", "gotcha"]),
};

export function parseMemoryFile(raw: string): MemoryFile | null {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = normalized.match(FRONTMATTER_REGEX);
  if (!match) return null;

  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1]);
  } catch {
    return null;
  }
  if (!isRecord(frontmatter)) return null;

  return normalizeMemoryFile(frontmatter, match[2].trim());
}

export function toRuntimeMemory(file: MemoryFile): Memory {
  return {
    id: file.id,
    content: file.content,
    context_hint: file.context_hint,
    memory_type: file.memory_type,
    action_type: file.action_type,
    type: file.memory_type,
    level: file.level,
    primitive: file.primitive,
    status: file.status,
    confidence: file.confidence,
    authority: file.authority,
    enforcement: file.enforcement,
    applies_to: file.applies_to,
    subjects: file.subjects,
    symbols: file.symbols,
    tags: file.tags,
    source_pr_urls: file.source_pr_urls,
    source_pr_number: firstGithubPullRequestNumber(file.source_pr_urls),
    source_session_ids: file.source_session_ids,
    referenced_files: file.applies_to.length > 0 ? JSON.stringify(file.applies_to) : null,
    triggers: file.triggers,
    scope: "repo",
  };
}

export function serializeMemoryFile(memory: MemoryFile): string {
  const frontmatter: Record<string, unknown> = {};
  for (const key of FRONTMATTER_FIELD_ORDER) {
    const value = memory[key];
    if (key === "action_type" && value === null) continue;
    if (key === "owner" && value === null) continue;
    if (key === "triggers" && value === null) continue;
    frontmatter[key] = value;
  }

  return `---\n${stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${memory.content.trim()}\n`;
}

export function memoryFilename(id: string, title?: string): string {
  const slug = id.replace(/^mem[-_]/, "").replace(/[^a-zA-Z0-9-]/g, "-");
  const titleSlug = title ? slugifyTitle(title) : "";
  return titleSlug ? `${slug}-${titleSlug}.md` : `${slug}.md`;
}

export function memoryPathForFile(
  memory: Pick<MemoryFile, "id" | "level" | "memory_type" | "primitive"> &
    Partial<Pick<MemoryFile, "context_hint" | "content">>,
): string {
  return `${MEMORY_ROOT_DIR}/engineering/${pathSegmentForMemory(memory)}/${memoryFilename(
    memory.id,
    memoryTitleForFilename(memory),
  )}`;
}

export function shouldIgnoreMemoryPath(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return MEMORY_IGNORED_FILENAMES.has(name);
}

function normalizeMemoryFile(fields: Record<string, unknown>, content: string): MemoryFile | null {
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof fields[field] !== "string" || fields[field].trim() === "") return null;
  }

  const vertical = enumValue(fields.vertical, MEMORY_VERTICALS);
  const memoryType = enumValue(fields.memory_type, MEMORY_TYPES);
  const level = enumValue(fields.level, MEMORY_LEVELS);
  const primitive = enumValue(fields.primitive, MEMORY_PRIMITIVES);
  const status = enumValue(fields.status, MEMORY_STATUSES);
  const confidence = enumValue(fields.confidence, MEMORY_CONFIDENCES);
  const authority = enumValue(fields.authority, MEMORY_AUTHORITIES);
  if (!vertical || !memoryType || !level || !primitive || !status || !confidence || !authority) return null;

  const actionType = fields.action_type === undefined ? null : enumValue(fields.action_type, MEMORY_ACTION_TYPES);
  if (memoryType === "action" && !actionType) return null;
  if (memoryType !== "action" && fields.action_type !== undefined) return null;
  if (!MEMORY_TYPE_PRIMITIVES[memoryType].has(primitive)) return null;

  const engineeringDomains = stringEnumArray(fields.engineering_domains, ENGINEERING_DOMAINS);
  if (vertical === "engineering" && engineeringDomains.length === 0) return null;

  const enforcement = fields.enforcement === undefined ? "none" : enumValue(fields.enforcement, MEMORY_ENFORCEMENTS);
  if (!enforcement) return null;

  const triggers = fields.triggers === undefined ? null : normalizeTriggers(fields.triggers);
  if (fields.triggers !== undefined && !triggers) return null;
  const requiresTriggers =
    primitive === "trigger" || actionType === "trigger" || enforcement === "warn" || enforcement === "block";
  if (requiresTriggers && !triggers) return null;
  if (enforcement === "block" && triggers && !hasAnyBlockingPattern(triggers)) return null;

  const evidence = normalizeEvidence(fields.evidence);
  if (!evidence) return null;

  return {
    id: (fields.id as string).trim(),
    vertical,
    memory_type: memoryType,
    action_type: actionType,
    level,
    primitive,
    engineering_domains: engineeringDomains,
    subjects: stringArray(fields.subjects),
    symbols: stringArray(fields.symbols),
    tags: stringArray(fields.tags),
    status,
    confidence,
    authority,
    owner: typeof fields.owner === "string" && fields.owner.trim() !== "" ? fields.owner.trim() : null,
    applies_to: stringArray(fields.applies_to),
    context_hint: (fields.context_hint as string).trim(),
    source_pr_urls: stringArray(fields.source_pr_urls),
    source_session_ids: stringArray(fields.source_session_ids),
    evidence,
    enforcement,
    triggers,
    supersedes: stringArray(fields.supersedes),
    contradicts: stringArray(fields.contradicts),
    created_at: (fields.created_at as string).trim(),
    updated_at: (fields.updated_at as string).trim(),
    content,
  };
}

export function firstGithubPullRequestNumber(urls: string[]): number | null {
  for (const url of urls) {
    const match = url.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)\b/i);
    if (!match?.[1]) continue;
    const parsed = Number(match[1]);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function pathSegmentForMemory(memory: Pick<MemoryFile, "level" | "memory_type" | "primitive">): string {
  if (memory.level === "gotcha" || memory.primitive === "gotcha") return "gotchas";
  if (memory.memory_type === "factual") {
    if (memory.primitive === "entity" || memory.primitive === "artifact") return "factual/entities";
    if (memory.primitive === "assumption") return "factual/assumptions";
    return "factual/claims";
  }
  if (memory.memory_type === "interaction") {
    if (memory.primitive === "commitment") return "interaction/commitments";
    if (memory.primitive === "conflict") return "interaction/conflicts";
    return "interaction/decisions";
  }
  return `action/${memory.primitive}s`;
}

export function memoryDisplayTitle(memory: Partial<Pick<MemoryFile, "context_hint" | "content">>): string {
  const heading = memory.content?.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || memory.context_hint || "";
}

function memoryTitleForFilename(memory: Partial<Pick<MemoryFile, "context_hint" | "content">>): string {
  return memoryDisplayTitle(memory);
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

function normalizeTriggers(value: unknown): MemoryTriggers | null {
  if (!isRecord(value)) return null;
  return {
    tools: stringArray(value.tools),
    path_globs: stringArray(value.path_globs),
    command_patterns: stringArray(value.command_patterns),
    forbidden_patterns: stringArray(value.forbidden_patterns),
    mcp_tools: stringArray(value.mcp_tools),
  };
}

function hasAnyBlockingPattern(triggers: MemoryTriggers): boolean {
  return triggers.command_patterns.length > 0 || triggers.forbidden_patterns.length > 0;
}

function normalizeEvidence(value: unknown): MemoryEvidence[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const evidence: MemoryEvidence[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.type !== "string" || typeof entry.ref !== "string") return null;
    evidence.push({ type: entry.type, ref: entry.ref });
  }
  return evidence;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T): ValueOf<T> | null {
  if (typeof value !== "string") return null;
  return (allowed as readonly string[]).includes(value) ? (value as ValueOf<T>) : null;
}

function stringEnumArray<const T extends readonly string[]>(value: unknown, allowed: T): ValueOf<T>[] {
  const values = stringArray(value);
  return values.every((entry) => (allowed as readonly string[]).includes(entry)) ? (values as ValueOf<T>[]) : [];
}

function stringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .map((entry) => entry.trim());
}
