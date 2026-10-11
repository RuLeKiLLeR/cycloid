import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "fs";
import { isAbsolute, join, sep } from "path";

import type {
  PrTemplateFillFactId,
  PrTemplateFillLlmOutput,
  PrTemplateFillSection,
} from "../../../../shared/llm/post-execution.js";
import { stripLlmAuthoredAbsoluteUrls } from "../utils/pr-body-links.js";

export type PrTemplateSource = "repo_local" | "org_default" | "cycloid_config";

export type PrTemplateCandidate = {
  path: string;
  source: PrTemplateSource;
  content: string;
};

export type PrTemplateProvider = {
  listCandidates(): Promise<PrTemplateCandidate[]>;
};

export type ResolvedPrTemplate =
  { status: "found"; candidate: PrTemplateCandidate } | { status: "none"; reason: string };

export type PrTemplateSlot = "narrative" | "summary" | "verification" | "visualEvidence" | "risk" | "followUps";

export type CompactPrTemplateContent = Record<PrTemplateSlot, string> & {
  checkedCheckboxes?: string[];
};

export type TemplateClassificationInput = {
  headings: TemplateHeading[];
  diffSummary?: string;
  availableEvidenceTypes: string[];
};

export type TemplateSectionMapping = {
  slot: PrTemplateSlot;
  headingText: string;
  confidence: number;
};

export type PrTemplateSectionClassifier = {
  classify(input: TemplateClassificationInput): Promise<TemplateSectionMapping[]>;
};

export type TemplateHeading = {
  lineIndex: number;
  endLineIndex: number;
  level: number;
  text: string;
  normalizedText: string;
  body: string;
};

const MAX_TEMPLATE_BYTES = 128 * 1024;
const MANAGED_BLOCK_RE =
  /<!--\s*cycloid:managed:start\s+(narrative|summary|verification|visualEvidence|risk|followUps)\s*-->[\s\S]*?<!--\s*cycloid:managed:end\s+\1\s*-->/g;
const CYCLOID_SUMMARY_HEADING_RE = /^##\s+Cycloid Summary\s*$/i;
const CYCLOID_VERIFICATION_HEADING_RE = /^##\s+Cycloid (?:QA|Verification)\s*$/i;

const EXACT_TEMPLATE_PATHS = [
  ".github/PULL_REQUEST_TEMPLATE/cycloid.md",
  "PULL_REQUEST_TEMPLATE/cycloid.md",
  "docs/PULL_REQUEST_TEMPLATE/cycloid.md",
  ".github/pull_request_template.md",
  "pull_request_template.md",
  "docs/pull_request_template.md",
] as const;

const GENERIC_TEMPLATE_DIRS = [
  ".github/PULL_REQUEST_TEMPLATE",
  "PULL_REQUEST_TEMPLATE",
  "docs/PULL_REQUEST_TEMPLATE",
] as const;

const CYCLOID_CONFIG_PATH = ".cycloid.json";

type CycloidJsonConfig = {
  pr?: { templatePath?: unknown };
};

const VISIBLE_PLACEHOLDERS: Array<{ slot: PrTemplateSlot; token: string }> = [
  { slot: "summary", token: "{{CYCLOID_SUMMARY}}" },
  { slot: "verification", token: "{{CYCLOID_VERIFICATION}}" },
  { slot: "verification", token: "{{CYCLOID_EVIDENCE}}" },
  { slot: "visualEvidence", token: "{{CYCLOID_SCREENSHOTS}}" },
];

const INVISIBLE_PLACEHOLDERS: Array<{ slot: PrTemplateSlot; pattern: RegExp }> = [
  { slot: "summary", pattern: /<!--\s*cycloid:summary\s*-->/gi },
  { slot: "verification", pattern: /<!--\s*cycloid:verification\s*-->/gi },
  { slot: "verification", pattern: /<!--\s*cycloid:evidence\s*-->/gi },
  { slot: "visualEvidence", pattern: /<!--\s*cycloid:screenshots\s*-->/gi },
];

function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path) && !path.includes("..");
}

function readTemplateFile(
  repoRoot: string,
  path: string,
  source: PrTemplateSource = "repo_local",
): PrTemplateCandidate | null {
  if (!isMarkdownPath(path)) return null;
  const fullPath = join(repoRoot, path);
  try {
    if (!existsSync(fullPath)) return null;
    const stats = lstatSync(fullPath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_TEMPLATE_BYTES) return null;
    return { path, source, content: readFileSync(fullPath, "utf-8") };
  } catch {
    return null;
  }
}

export class RepoLocalPrTemplateProvider implements PrTemplateProvider {
  constructor(private readonly repoRoot: string) {}

  async listCandidates(): Promise<PrTemplateCandidate[]> {
    const candidates: PrTemplateCandidate[] = [];
    for (const path of EXACT_TEMPLATE_PATHS) {
      const candidate = readTemplateFile(this.repoRoot, path);
      if (candidate) candidates.push(candidate);
    }

    for (const dir of GENERIC_TEMPLATE_DIRS) {
      const fullDir = join(this.repoRoot, dir);
      try {
        if (!existsSync(fullDir)) continue;
        const dirStats = lstatSync(fullDir);
        if (!dirStats.isDirectory()) continue;
        for (const entry of readdirSync(fullDir).sort()) {
          if (!/\.md$/i.test(entry)) continue;
          const path = `${dir}/${entry}`;
          if (EXACT_TEMPLATE_PATHS.includes(path as (typeof EXACT_TEMPLATE_PATHS)[number])) continue;
          const candidate = readTemplateFile(this.repoRoot, path);
          if (candidate) candidates.push(candidate);
        }
      } catch {
        continue;
      }
    }
    return candidates;
  }
}

/**
 * Tier 1 (ARC-1126): an explicit PR template pointed to by `pr.templatePath` in
 * the repo's `.cycloid.json`. Read from the local checkout at publish time, the
 * same way pre-publish tests read `.cycloid.json`. Fails soft to `[]` on any
 * problem (missing/invalid config, missing/unsafe/non-markdown path, missing
 * file) so the chain falls through to auto-discovery.
 */
export class CycloidJsonPrTemplateProvider implements PrTemplateProvider {
  constructor(private readonly repoRoot: string) {}

  async listCandidates(): Promise<PrTemplateCandidate[]> {
    const configPath = join(this.repoRoot, CYCLOID_CONFIG_PATH);
    let raw: string;
    try {
      if (!existsSync(configPath)) return [];
      raw = readFileSync(configPath, "utf-8");
    } catch {
      return [];
    }

    let config: CycloidJsonConfig;
    try {
      config = JSON.parse(raw) as CycloidJsonConfig;
    } catch {
      return [];
    }

    const templatePath = config.pr?.templatePath;
    if (typeof templatePath !== "string") return [];
    const trimmed = templatePath.trim();
    if (!trimmed || isAbsolute(trimmed)) return [];

    // The path is repo-author-controlled, so confirm it resolves to a real file
    // inside the repo tree before reading it. `readTemplateFile`'s `lstatSync`
    // only guards the final component; an intermediate symlinked directory
    // (e.g. `link/foo.md` where `link -> /etc`) would otherwise read a file
    // outside the checkout — a Cycloid-owned secret in the sandbox — into the
    // PR body. Fail soft to `[]` so the chain falls through to auto-discovery.
    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = realpathSync(this.repoRoot);
      realTarget = realpathSync(join(this.repoRoot, trimmed));
    } catch {
      return [];
    }
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) return [];

    const candidate = readTemplateFile(this.repoRoot, trimmed, "cycloid_config");
    return candidate ? [candidate] : [];
  }
}

export async function resolvePrTemplate(provider: PrTemplateProvider): Promise<ResolvedPrTemplate> {
  let candidates: PrTemplateCandidate[];
  try {
    candidates = await provider.listCandidates();
  } catch {
    return { status: "none", reason: "provider_failed" };
  }

  const byPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
  for (const path of EXACT_TEMPLATE_PATHS) {
    const candidate = byPath.get(path);
    if (candidate) return { status: "found", candidate };
  }

  if (candidates.length === 1) return { status: "found", candidate: candidates[0] };
  if (candidates.length > 1) return { status: "none", reason: "multiple_templates_ambiguous" };
  return { status: "none", reason: "no_template" };
}

/**
 * Resolve a PR template by trying providers in precedence order and returning
 * the first that yields a template. ARC-1126 composes
 * [CycloidJson (tier 1), RepoLocal (tier 2)]; ARC-1124 will insert the
 * pr_structure memory provider (tier 3) before the built-in default, which is
 * the `status: "none"` fallthrough the caller handles.
 */
export async function resolvePrTemplateChain(providers: PrTemplateProvider[]): Promise<ResolvedPrTemplate> {
  let lastResolved: ResolvedPrTemplate = { status: "none", reason: "no_template" };
  for (const provider of providers) {
    const resolved = await resolvePrTemplate(provider);
    if (resolved.status === "found") return resolved;
    lastResolved = resolved;
  }
  return lastResolved;
}

function normalizeHeadingText(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[*_`[\]()#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isFenceToggle(line: string, fence: string | null): string | null {
  const match = line.trim().match(/^(`{3,}|~{3,})/);
  if (!match) return fence;
  const marker = match[1][0];
  if (!fence) return marker;
  return fence === marker ? null : fence;
}

export function parseTemplateHeadings(markdown: string): TemplateHeading[] {
  return parseTemplateHeadingsWithOptions(markdown, { ignoreManagedBlocks: false });
}

function parseTemplateHeadingsOutsideManagedBlocks(markdown: string): TemplateHeading[] {
  return parseTemplateHeadingsWithOptions(markdown, { ignoreManagedBlocks: true });
}

function parseTemplateHeadingsWithOptions(
  markdown: string,
  options: { ignoreManagedBlocks: boolean },
): TemplateHeading[] {
  const lines = markdown.split("\n");
  const starts: Array<{ lineIndex: number; level: number; text: string; normalizedText: string }> = [];
  let fence: string | null = null;
  let managedBlockSlot: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const managedStart = lines[index].match(/<!--\s*cycloid:managed:start\s+(\w+)\s*-->/);
    if (options.ignoreManagedBlocks && managedStart) {
      managedBlockSlot = managedStart[1];
      continue;
    }
    if (options.ignoreManagedBlocks && managedBlockSlot) {
      const managedEnd = new RegExp(`<!--\\s*cycloid:managed:end\\s+${managedBlockSlot}\\s*-->`).test(lines[index]);
      if (managedEnd) managedBlockSlot = null;
      continue;
    }
    const nextFence = isFenceToggle(lines[index], fence);
    if (!fence && !nextFence) {
      const match = lines[index].match(/^(#{1,6})\s+(.+?)\s*$/);
      if (match) {
        starts.push({
          lineIndex: index,
          level: match[1].length,
          text: match[2].trim(),
          normalizedText: normalizeHeadingText(match[2]),
        });
      }
    }
    fence = nextFence;
  }

  return starts.map((heading, index) => {
    const next = starts.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    const endLineIndex = next?.lineIndex ?? lines.length;
    return {
      ...heading,
      endLineIndex,
      body: lines.slice(heading.lineIndex + 1, endLineIndex).join("\n"),
    };
  });
}

function managedBlock(slot: PrTemplateSlot, content: string): string {
  return [`<!-- cycloid:managed:start ${slot} -->`, content.trim(), `<!-- cycloid:managed:end ${slot} -->`].join("\n");
}

function contentForSlot(content: CompactPrTemplateContent, slot: PrTemplateSlot): string {
  return content[slot]?.trim() ?? "";
}

function replaceExistingManagedBlocks(
  markdown: string,
  content: CompactPrTemplateContent,
  inserted: Set<PrTemplateSlot>,
): string {
  return markdown.replace(MANAGED_BLOCK_RE, (_block, rawSlot: PrTemplateSlot) => {
    const slotContent = contentForSlot(content, rawSlot);
    inserted.add(rawSlot);
    return slotContent ? managedBlock(rawSlot, slotContent) : "";
  });
}

function replaceFirst(
  raw: string,
  token: string | RegExp,
  replacement: string,
): { markdown: string; replaced: boolean } {
  let replaced = false;
  const markdown = raw.replace(token, () => {
    if (replaced) return "";
    replaced = true;
    return replacement;
  });
  return { markdown, replaced };
}

function replacePlaceholders(
  markdown: string,
  content: CompactPrTemplateContent,
  inserted: Set<PrTemplateSlot>,
): string {
  let rendered = markdown;
  for (const placeholder of VISIBLE_PLACEHOLDERS) {
    if (inserted.has(placeholder.slot)) continue;
    const slotContent = contentForSlot(content, placeholder.slot);
    if (!rendered.includes(placeholder.token)) continue;
    const result = replaceFirst(
      rendered,
      placeholder.token,
      slotContent ? managedBlock(placeholder.slot, slotContent) : "",
    );
    rendered = result.markdown.split(placeholder.token).join("");
    if (result.replaced) inserted.add(placeholder.slot);
  }

  for (const placeholder of INVISIBLE_PLACEHOLDERS) {
    if (inserted.has(placeholder.slot)) continue;
    const slotContent = contentForSlot(content, placeholder.slot);
    if (!placeholder.pattern.test(rendered)) {
      placeholder.pattern.lastIndex = 0;
      continue;
    }
    placeholder.pattern.lastIndex = 0;
    const result = replaceFirst(
      rendered,
      placeholder.pattern,
      slotContent ? managedBlock(placeholder.slot, slotContent) : "",
    );
    rendered = result.markdown.replace(placeholder.pattern, "");
    placeholder.pattern.lastIndex = 0;
    if (result.replaced) inserted.add(placeholder.slot);
  }
  return rendered;
}

function insertIntoHeadingSection(markdown: string, heading: TemplateHeading, block: string): string {
  const lines = markdown.split("\n");
  const insertionIndex = sectionInsertionIndex(lines, heading);
  const before = lines.slice(0, insertionIndex).join("\n").trimEnd();
  const after = lines.slice(insertionIndex).join("\n").trimStart();
  return after ? `${before}\n\n${block}\n\n${after}` : `${before}\n\n${block}`;
}

function sectionInsertionIndex(lines: string[], heading: TemplateHeading): number {
  let index = heading.lineIndex + 1;
  let sawTemplateHelper = false;
  while (index < heading.endLineIndex) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      index += 1;
      continue;
    }
    if (trimmed.startsWith("<!--")) {
      sawTemplateHelper = true;
      index += 1;
      while (index < heading.endLineIndex && !lines[index - 1].includes("-->")) index += 1;
      continue;
    }
    break;
  }
  return sawTemplateHelper ? index : heading.endLineIndex;
}

function removeCycloidVerificationSection(markdown: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => CYCLOID_VERIFICATION_HEADING_RE.test(line.trim()));
  if (start === -1) return markdown;
  const end = lines.findIndex((line, index) => index > start && /^#{1,6}\s+\S/.test(line.trim()));
  return [...lines.slice(0, start), ...lines.slice(end === -1 ? lines.length : end)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeCycloidSummarySection(markdown: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => CYCLOID_SUMMARY_HEADING_RE.test(line.trim()));
  if (start === -1) return markdown;
  const end = lines.findIndex((line, index) => index > start && /^#{1,6}\s+\S/.test(line.trim()));
  return [...lines.slice(0, start), ...lines.slice(end === -1 ? lines.length : end)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function appendFallbackVerificationSection(markdown: string, verification: string): string {
  const base = removeCycloidVerificationSection(markdown).trim();
  // This PR-body heading is regex-coupled by the regex above; persona headers belong to PR comments in shared/agent/pr-personas.ts.
  const section = ["## Cycloid QA", managedBlock("verification", verification)].join("\n");
  return base ? `${base}\n\n${section}` : section;
}

function normalizeCheckboxLabel(label: string): string {
  return label
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function applyCheckedCheckboxes(markdown: string, labels: ReadonlyArray<string> | undefined): string {
  if (!labels?.length) return markdown;
  const normalizedLabels = new Set(labels.map(normalizeCheckboxLabel));
  return markdown
    .split("\n")
    .map((line) => {
      const match = line.match(/^(\s*[-*]\s+\[)([ xX])(\]\s+)(.+?)\s*$/);
      if (!match) return line;
      const [, prefix, currentState, suffix, label] = match;
      if (currentState.toLowerCase() === "x") return line;
      return normalizedLabels.has(normalizeCheckboxLabel(label)) ? `${prefix}x${suffix}${label}` : line;
    })
    .join("\n");
}

export function renderPrBodyFromTemplate(input: {
  template: PrTemplateCandidate;
  content: CompactPrTemplateContent;
  classifier?: PrTemplateSectionClassifier;
}): string {
  if (!containsCycloidPlaceholders(input.template.content)) {
    const customerTemplate = removeCycloidSummarySection(input.template.content).trim();
    return applyCheckedCheckboxes(
      [completeCycloidFallbackBlock(input.content), customerTemplate].filter(Boolean).join("\n\n"),
      input.content.checkedCheckboxes,
    );
  }

  const inserted = new Set<PrTemplateSlot>();
  let rendered = replaceExistingManagedBlocks(input.template.content, input.content, inserted);
  rendered = replacePlaceholders(rendered, input.content, inserted);

  if (!inserted.has("verification") && contentForSlot(input.content, "verification")) {
    rendered = appendFallbackVerificationSection(rendered, contentForSlot(input.content, "verification"));
    inserted.add("verification");
  }
  if (!inserted.has("visualEvidence") && contentForSlot(input.content, "visualEvidence")) {
    rendered = `${rendered.trimEnd()}\n\n## Screenshots\n${managedBlock(
      "visualEvidence",
      contentForSlot(input.content, "visualEvidence"),
    )}`;
    inserted.add("visualEvidence");
  }

  return applyCheckedCheckboxes(rendered.replace(/\n{3,}/g, "\n\n").trim(), input.content.checkedCheckboxes);
}

function completeCycloidFallbackBlock(content: CompactPrTemplateContent): string {
  const blocks = [
    managedBlock("narrative", contentForSlot(content, "narrative") || "No summary was captured from the agent."),
  ];
  const verification = contentForSlot(content, "verification");
  if (verification) blocks.push(managedBlock("verification", verification));
  const visualEvidence = contentForSlot(content, "visualEvidence");
  if (visualEvidence) blocks.push(managedBlock("visualEvidence", visualEvidence));
  return ["## Cycloid Summary", ...blocks].join("\n\n");
}

const VERDICT_WORDS = ["CONFIRMED", "REFUTED", "INCONCLUSIVE"] as const;
const VERDICT_WORD_RE = new RegExp(`\\b(${VERDICT_WORDS.join("|")})\\b`, "i");

/**
 * Fail-closed verdict-free guard. The verdict lives in the managed "Cycloid
 * Verification" PR comment — the living state, re-verified per head SHA. The PR
 * body is frozen at publish, so verdict language baked into it goes stale and
 * contradicts the comment after re-verification. Case-insensitive on purpose:
 * "Confirmed: lint passed" is still a verdict claim, and the prompt forbids
 * these words outright, so any casing signals non-compliant text — drop it.
 */
export function verificationTextIsVerdictFree(text: string): boolean {
  return !VERDICT_WORD_RE.test(text);
}

const CYCLOID_MANAGED_MARKER_RE = /<!--\s*cycloid:managed:(?:start|end)\s+\w+\s*-->/g;

/**
 * Strip any Cycloid managed-block markers the model may have echoed into its
 * text. Without this, the model occasionally emits `<!-- cycloid:managed:start
 * verification -->` inside its prose and the assembler wraps it again, producing
 * nested/malformed blocks that break the control-plane's managed-block updates.
 */
function stripManagedMarkers(text: string): string {
  return text
    .replace(CYCLOID_MANAGED_MARKER_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Proof kinds carry deterministic facts and must appear at most once: the model
// sometimes maps several testing subheadings (Testing / Local Tests / Unit Tests)
// to `verification`, which would otherwise duplicate the commands across sections.
const PROOF_FACT_IDS = new Set<PrTemplateFillFactId>(["verification", "visualEvidence"]);
const VERIFICATION_HEADING_ALIASES = new Set(["testing", "test plan", "verification", "qa", "evidence", "proof"]);

/**
 * Assemble an LLM section-fill into a resolved template.
 * - prose -> the LLM prose, with verdict words rejected for verification-like headings
 * - facts -> deterministic fact blocks, by id
 * - empty -> nothing
 * Headings with no matching fill section keep the customer's original content.
 */
/**
 * True when the template uses Cycloid placeholder tokens (`{{CYCLOID_*}}`) or
 * invisible markers. The deterministic renderer substitutes these; the LLM
 * section-fill leaves them literal, so a placeholder template must bypass the
 * fill and use {@link renderPrBodyFromTemplate}.
 */
export function containsCycloidPlaceholders(content: string): boolean {
  return (
    /\{\{CYCLOID_[A-Z_]+\}\}/.test(content) ||
    /<!--\s*cycloid:(summary|verification|evidence|screenshots)\s*-->/i.test(content)
  );
}

export function assembleSectionFilledBody(input: {
  templateContent: string;
  fill: PrTemplateFillLlmOutput;
  deterministic: {
    verificationBlock: string;
    visualEvidence: string;
    checkedCheckboxes?: string[];
  };
}): string {
  let rendered = input.templateContent;
  const originalHeadings = parseTemplateHeadings(input.templateContent);
  const emittedProofFacts = new Set<PrTemplateFillFactId>();
  for (const section of input.fill.sections) {
    const originalHeading = originalHeadings[section.index];
    if (!originalHeading || originalHeading.text !== section.heading) continue;
    const block = blockForSection(section, input.deterministic, emittedProofFacts);
    if (!block) continue;
    // Re-parse each iteration because insertion shifts line indices, but keep
    // indexing against the customer template outline rather than managed prose.
    const heading = parseTemplateHeadingsOutsideManagedBlocks(rendered)[section.index];
    if (!heading || heading.text !== originalHeading.text) continue;
    rendered = insertIntoHeadingSection(rendered, heading, block);
  }
  // Proof must never disappear: if the model never placed verification or visual
  // evidence (e.g. the relevant heading was truncated past the heading cap, or the
  // template has no testing/screenshot heading), append the deterministic blocks as
  // a fallback — mirroring renderPrBodyFromTemplate's behaviour.
  if (!emittedProofFacts.has("verification") && input.deterministic.verificationBlock.trim()) {
    rendered = appendFallbackVerificationSection(rendered, input.deterministic.verificationBlock.trim());
  }
  if (!emittedProofFacts.has("visualEvidence") && input.deterministic.visualEvidence.trim()) {
    rendered = `${rendered.trimEnd()}\n\n## Screenshots\n${managedBlock("visualEvidence", input.deterministic.visualEvidence.trim())}`;
  }
  return applyCheckedCheckboxes(rendered.replace(/\n{3,}/g, "\n\n").trim(), input.deterministic.checkedCheckboxes);
}

function blockForSection(
  section: PrTemplateFillSection,
  deterministic: { verificationBlock: string; visualEvidence: string },
  emittedProofFacts: Set<PrTemplateFillFactId>,
): string | null {
  switch (section.kind) {
    case "prose": {
      const text = stripLlmAuthoredAbsoluteUrls(stripManagedMarkers(section.text ?? ""));
      if (!text) return null;
      if (
        VERIFICATION_HEADING_ALIASES.has(normalizeHeadingText(section.heading)) &&
        !verificationTextIsVerdictFree(text)
      ) {
        return null;
      }
      return managedBlock("narrative", text);
    }
    case "facts": {
      const blocks: string[] = [];
      for (const factRef of section.factRefs ?? []) {
        if (emittedProofFacts.has(factRef)) continue;
        const block = blockForFactRef(factRef, deterministic);
        if (!block) continue;
        emittedProofFacts.add(factRef);
        blocks.push(block);
      }
      return blocks.length > 0 ? blocks.join("\n\n") : null;
    }
    case "empty":
      return null;
  }
}

function blockForFactRef(
  factRef: PrTemplateFillFactId,
  deterministic: { verificationBlock: string; visualEvidence: string },
): string | null {
  switch (factRef) {
    case "verification": {
      const verification = deterministic.verificationBlock.trim();
      return verification ? managedBlock("verification", verification) : null;
    }
    case "visualEvidence": {
      const links = deterministic.visualEvidence.trim();
      return links ? managedBlock("visualEvidence", links) : null;
    }
  }
}
