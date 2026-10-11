import { INSTRUCTION_CONTENT_NOTICE, USER_CONTENT_UNTRUSTED_NOTICE } from "../constants/prompt-context.js";

export const PROMPT_CONTROL_TAG_NAMES = [
  "user_content",
  "system-reminder",
  "instruction_content",
  "cycloid:company_memory",
] as const;

export type StructuralPromptInjectionHitKind = "html_comment" | "zero_width";
export type StructuralPromptInjectionRule = "instruction_override" | "prompt_exfiltration" | "prompt_control_tag";
export type StructuralPromptInjectionHit = {
  kind: StructuralPromptInjectionHitKind;
  rule: StructuralPromptInjectionRule;
};

const PROMPT_CONTROL_TAG_RE = new RegExp(
  String.raw`</?(?:${PROMPT_CONTROL_TAG_NAMES.map(escapeRegExp).join("|")})\b[^>]*>`,
  "gi",
);
const PROMPT_CONTROL_TAG_SCAN_RE = new RegExp(
  String.raw`</?(?:${PROMPT_CONTROL_TAG_NAMES.map(escapeRegExp).join("|")})\b[^>]*>`,
  "i",
);
const HTML_COMMENT_RE = /<!--([\s\S]*?)-->/g;
const INVISIBLE_FRAGMENT_RE =
  /[\u00ad\u034f\u061c\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff]/gu;
/** Bound worst-case regex work on very large WebFetch pages. */
export const STRUCTURAL_INJECTION_SCAN_MAX_CHARS = 512 * 1024;
const STRUCTURAL_SCAN_RULES: ReadonlyArray<{ rule: StructuralPromptInjectionRule; re: RegExp }> = [
  {
    rule: "instruction_override",
    re: /\b(?:ignore|disregard|forget|override)\b.{0,48}\b(?:previous|prior|above|earlier|system|developer)\b.{0,24}\binstructions?\b/i,
  },
  {
    rule: "prompt_exfiltration",
    re: /\b(?:reveal|repeat|print|show|display|dump)\b.{0,48}\b(?:system prompt|developer message|hidden instructions?|full prompt|prompt)\b/i,
  },
  { rule: "prompt_control_tag", re: PROMPT_CONTROL_TAG_SCAN_RE },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeStructuralScanText(content: string): string {
  return content.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function structuralPromptInjectionRules(content: string): Set<StructuralPromptInjectionRule> {
  const normalized = normalizeStructuralScanText(content);
  const rules = new Set<StructuralPromptInjectionRule>();
  if (!normalized) return rules;

  for (const { rule, re } of STRUCTURAL_SCAN_RULES) {
    if (re.test(normalized)) rules.add(rule);
  }
  return rules;
}

function localizedInvisibleSpans(visibleContent: string): string[] {
  const spans = visibleContent.split(/(?<=[.!?])\s+|\n+/).filter((span) => {
    const invisibleRe = new RegExp(INVISIBLE_FRAGMENT_RE.source, "u");
    return invisibleRe.test(span);
  });
  if (spans.length > 0) return spans;
  const invisibleRe = new RegExp(INVISIBLE_FRAGMENT_RE.source, "u");
  return invisibleRe.test(visibleContent) ? [visibleContent] : [];
}

function collectZeroWidthStructuralInjectionRules(visibleContent: string): Set<StructuralPromptInjectionRule> {
  const rules = new Set<StructuralPromptInjectionRule>();
  for (const span of localizedInvisibleSpans(visibleContent)) {
    const strippedSpan = span.replace(INVISIBLE_FRAGMENT_RE, "");
    const originalRules = structuralPromptInjectionRules(span);
    const strippedRules = structuralPromptInjectionRules(strippedSpan);
    for (const rule of strippedRules) {
      if (!originalRules.has(rule)) rules.add(rule);
    }
  }
  return rules;
}

export function scanFetchedWebContentForStructuralInjection(content: string): StructuralPromptInjectionHit[] {
  if (content.length > STRUCTURAL_INJECTION_SCAN_MAX_CHARS) return [];

  const hits = new Map<string, StructuralPromptInjectionHit>();
  const addHits = (kind: StructuralPromptInjectionHitKind, rules: Iterable<StructuralPromptInjectionRule>) => {
    for (const rule of rules) {
      hits.set(`${kind}:${rule}`, { kind, rule });
    }
  };

  for (const match of content.matchAll(HTML_COMMENT_RE)) {
    const commentBody = match[1];
    if (!commentBody) continue;
    addHits("html_comment", structuralPromptInjectionRules(commentBody));
  }

  const visibleContent = content.replace(HTML_COMMENT_RE, "");
  addHits("zero_width", collectZeroWidthStructuralInjectionRules(visibleContent));

  return [...hits.values()];
}

export function escapeUserContentTags(content: string): string {
  return content.replace(PROMPT_CONTROL_TAG_RE, (match) => `&lt;${match.slice(1, -1)}&gt;`);
}

export function sanitizeXmlAttribute(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/["<>]/g, "")
    .trim();
}

const PROMPT_ACTOR_USER_ID_RE = /^[A-Za-z0-9:_-]{1,128}$/;

export function normalizePromptActorUserId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return PROMPT_ACTOR_USER_ID_RE.test(normalized) ? normalized : null;
}

export function wrapUserContent(
  content: string,
  source: string,
  author?: string,
  options?: { includeUntrustedNotice?: boolean },
): string {
  const sourceAttr = sanitizeXmlAttribute(source) || "unknown";
  const authorAttr = author ? ` author="${sanitizeXmlAttribute(author)}"` : "";
  const escaped = escapeUserContentTags(content);

  const lines = [`<user_content source="${sourceAttr}"${authorAttr}>`, escaped, "</user_content>"];
  if (options?.includeUntrustedNotice !== false) {
    lines.push("", USER_CONTENT_UNTRUSTED_NOTICE);
  }
  return lines.join("\n");
}

export function wrapInstructionContent(content: string, source: string, path?: string): string {
  const sourceAttr = sanitizeXmlAttribute(source) || "unknown";
  const pathAttr = path ? ` path="${sanitizeXmlAttribute(path)}"` : "";
  const escaped = escapeUserContentTags(content);

  return [
    `<instruction_content source="${sourceAttr}"${pathAttr}>`,
    escaped,
    "</instruction_content>",
    "",
    INSTRUCTION_CONTENT_NOTICE,
  ].join("\n");
}
