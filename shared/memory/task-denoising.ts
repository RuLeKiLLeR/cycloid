import {
  COMPANY_MEMORY_CONTEXT_FOOTER,
  COMPANY_MEMORY_CONTEXT_HEADER,
  INSTRUCTION_CONTENT_NOTICE,
  SIMILAR_SESSION_TASK_SEPARATOR,
  USER_CONTENT_UNTRUSTED_NOTICE,
} from "../constants/prompt-context.js";
import { extractPathSignals, extractStructuredReferenceSignals } from "./retrieval-signals.js";

type DenoisedTaskRemovedSection =
  "company_memory_context" | "memory_context" | "prompt_control_wrapper" | "cycloid_launch_prefix";

interface DenoiseTaskInput {
  rawText: string;
  repoOwner?: string | null;
  repoName?: string | null;
  files?: string[];
}

interface DenoisedTaskSignals {
  repo?: string;
  files: string[];
  ticketKeys: string[];
  incidentKeys: string[];
  prNumbers: number[];
  prUrls: string[];
  slackRefs: string[];
  cycloidTags: string[];
}

interface DenoisedTask {
  rawText: string;
  denoisedTaskText: string;
  removedSections: DenoisedTaskRemovedSection[];
  rawFingerprint: string;
  taskFingerprint: string;
  structuredSignals: DenoisedTaskSignals;
}

const INJECTED_CONTEXT_BLOCKS = [
  { label: "company_memory_context", header: COMPANY_MEMORY_CONTEXT_HEADER, footer: COMPANY_MEMORY_CONTEXT_FOOTER },
] as const;

export function denoiseTaskInput(input: DenoiseTaskInput): DenoisedTask {
  const removedSections: DenoisedTaskRemovedSection[] = [];
  const withoutInjectedContext = stripMemoryContextBlocks(
    stripLeadingInjectedContext(input.rawText, removedSections),
    removedSections,
  );
  const withoutLaunchPrefix = stripCycloidLaunchPrefix(withoutInjectedContext, removedSections);
  const withoutWrappers = stripPromptControlWrappers(withoutLaunchPrefix, removedSections);
  const denoisedTaskText = normalizeWhitespace(withoutWrappers);
  return {
    rawText: input.rawText,
    denoisedTaskText,
    removedSections: [...new Set(removedSections)],
    rawFingerprint: stableFingerprint(input.rawText),
    taskFingerprint: stableFingerprint(denoisedTaskText),
    structuredSignals: extractStructuredSignals(denoisedTaskText, input),
  };
}

function stripMemoryContextBlocks(rawText: string, removedSections: DenoisedTaskRemovedSection[]): string {
  const text = rawText.replace(/<cycloid_memory_context\b[^>]*>[\s\S]*?<\/cycloid_memory_context>/gi, () => {
    removedSections.push("memory_context");
    return "\n";
  });
  return text;
}

function stripCycloidLaunchPrefix(rawText: string, removedSections: DenoisedTaskRemovedSection[]): string {
  const text = rawText.replace(/^\s*@Cycloid\b(?:\s+\(DEV\))?(?:\s+repo=[^\s]+)?(?:\s+\[[^\]\n]+\])*\s*/i, (match) => {
    removedSections.push("cycloid_launch_prefix");
    return match.endsWith("\n") ? "\n" : "";
  });
  return text;
}

export function denoiseCurrentTaskText(rawText: string): string {
  return denoiseTaskInput({ rawText }).denoisedTaskText;
}

function stripLeadingInjectedContext(rawText: string, removedSections: DenoisedTaskRemovedSection[]): string {
  let offset = 0;
  for (;;) {
    const rest = rawText.slice(offset);
    const block = INJECTED_CONTEXT_BLOCKS.find((candidate) => rest.startsWith(candidate.header));
    if (!block) break;
    const footerIndex = rest.indexOf(block.footer);
    if (footerIndex === -1) break;
    const blockEnd = footerIndex + block.footer.length;
    if (!rest.slice(blockEnd).startsWith(SIMILAR_SESSION_TASK_SEPARATOR)) break;
    removedSections.push(block.label);
    offset += blockEnd + SIMILAR_SESSION_TASK_SEPARATOR.length;
  }
  return offset === 0 ? rawText : rawText.slice(offset);
}

function stripPromptControlWrappers(rawText: string, removedSections: DenoisedTaskRemovedSection[]): string {
  const before = rawText;
  const text = rawText
    .split("\n")
    .filter((line) => !isPromptControlWrapperLine(line))
    .join("\n");
  if (text !== before) removedSections.push("prompt_control_wrapper");
  return text;
}

function isPromptControlWrapperLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed === USER_CONTENT_UNTRUSTED_NOTICE || trimmed === INSTRUCTION_CONTENT_NOTICE) return true;
  return isPromptControlTagLine(trimmed, "user_content") || isPromptControlTagLine(trimmed, "instruction_content");
}

function isPromptControlTagLine(line: string, tagName: "user_content" | "instruction_content"): boolean {
  if (line === `</${tagName}>`) return true;
  if (!line.startsWith(`<${tagName}`) || !line.endsWith(">")) return false;
  const next = line[tagName.length + 1];
  return next === " " || next === ">";
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractStructuredSignals(text: string, input: DenoiseTaskInput): DenoisedTaskSignals {
  const explicitFiles = (input.files ?? []).map((file) => file.trim()).filter(Boolean);
  const references = extractStructuredReferenceSignals(text);
  const signals: DenoisedTaskSignals = {
    files: unique([...explicitFiles, ...extractPathSignals(text)]),
    ticketKeys: references.ticketKeys,
    incidentKeys: references.incidentKeys,
    prNumbers: references.prNumbers,
    prUrls: references.prUrls,
    slackRefs: references.slackRefs,
    cycloidTags: references.cycloidTags,
  };
  const owner = input.repoOwner?.trim().toLowerCase();
  const name = input.repoName?.trim().toLowerCase();
  if (owner && name) signals.repo = `${owner}/${name}`;
  return signals;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function stableFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
