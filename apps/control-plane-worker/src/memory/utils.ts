import type {
  EngineeringDomain,
  MemoryActionType,
  MemoryAuthority,
  MemoryConfidence,
  MemoryEnforcement,
  MemoryFile,
  MemoryLevel,
  MemoryPrimitive,
  MemoryTriggers,
  MemoryType,
} from "../../../../shared/memory/parser.js";

export type MemorySemanticDefaults = {
  memory_type: MemoryType;
  action_type: MemoryActionType | null;
  level: MemoryLevel;
  primitive: MemoryPrimitive;
  engineering_domains: EngineeringDomain[];
};

export function semanticDefaultsForSuggestion(type: string, referencedFiles: string[]): MemorySemanticDefaults {
  const engineering_domains = inferEngineeringDomains(referencedFiles);
  if (type === "architecture") {
    return { memory_type: "factual", action_type: null, level: "strategic", primitive: "claim", engineering_domains };
  }
  if (type === "gotcha") {
    return {
      memory_type: "action",
      action_type: "procedure",
      level: "gotcha",
      primitive: "gotcha",
      engineering_domains,
    };
  }
  return {
    memory_type: "action",
    action_type: "procedure",
    level: "tactical",
    primitive: "procedure",
    engineering_domains,
  };
}

export function inferEngineeringDomains(paths: string[]): EngineeringDomain[] {
  const domains = new Set<EngineeringDomain>();
  for (const path of paths) {
    if (path.includes("test") || path.includes("spec")) domains.add("testing");
    if (path.includes("migrations") || path.includes("/db")) domains.add("data_persistence");
    if (path.includes("auth") || path.includes("security")) domains.add("security");
    if (path.includes("deploy") || path.includes("infra") || path.includes("wrangler")) domains.add("build_deploy");
    if (path.includes("ui") || path.includes("routes") || path.includes("api")) domains.add("external_interface");
  }
  if (domains.size === 0) domains.add("code_structure");
  return [...domains];
}

export function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function buildMemoryFileFromSuggestion({
  id,
  suggestion,
  params,
}: {
  id: string;
  suggestion: {
    type: string;
    content: string;
    context_hint: string;
    referenced_files: string[];
    memory_type?: MemoryType;
    action_type?: MemoryActionType | null;
    level?: MemoryLevel;
    primitive?: MemoryPrimitive;
    engineering_domains?: EngineeringDomain[];
    subjects?: string[];
    symbols?: string[];
    tags?: string[];
    confidence?: MemoryConfidence;
    authority?: MemoryAuthority;
    enforcement?: MemoryEnforcement;
    triggers?: MemoryTriggers | null;
    supersedes?: string[];
    contradicts?: string[];
  };
  params: { prUrl: string; sessionIds: string[] };
}): MemoryFile {
  const today = isoDate();
  const semantic = semanticDefaultsForSuggestion(suggestion.type, suggestion.referenced_files);
  return {
    id,
    vertical: "engineering",
    memory_type: suggestion.memory_type ?? semantic.memory_type,
    action_type: suggestion.action_type !== undefined ? suggestion.action_type : semantic.action_type,
    level: suggestion.level ?? semantic.level,
    primitive: suggestion.primitive ?? semantic.primitive,
    engineering_domains: suggestion.engineering_domains?.length
      ? suggestion.engineering_domains
      : semantic.engineering_domains,
    subjects: suggestion.subjects ?? [],
    symbols: suggestion.symbols ?? [],
    tags: suggestion.tags?.length ? suggestion.tags : [suggestion.type],
    status: "active",
    confidence: suggestion.confidence ?? "medium",
    authority: suggestion.authority ?? "reviewed",
    owner: "cycloid",
    applies_to: suggestion.referenced_files,
    context_hint: suggestion.context_hint,
    source_pr_urls: [params.prUrl],
    source_session_ids: params.sessionIds,
    evidence: [],
    enforcement: suggestion.enforcement ?? "none",
    triggers: suggestion.triggers ?? null,
    supersedes: suggestion.supersedes ?? [],
    contradicts: suggestion.contradicts ?? [],
    created_at: today,
    updated_at: today,
    content: suggestion.content,
  };
}

export function countCandidateAuditByLane<T extends string>(
  audit: Array<{ lane: T }> | undefined,
  lanes: readonly T[],
): Record<T, number> {
  return (audit ?? []).reduce<Record<T, number>>(
    (counts, entry) => {
      counts[entry.lane]++;
      return counts;
    },
    Object.fromEntries(lanes.map((lane) => [lane, 0])) as Record<T, number>,
  );
}
