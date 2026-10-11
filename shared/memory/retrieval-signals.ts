export interface RetrievalSignals {
  terms: string[];
  files: string[];
  pathTerms: string[];
  symbolTerms: string[];
  errorTerms: string[];
  runtimeTerms: string[];
}

export interface StructuredReferenceSignals {
  ticketKeys: string[];
  incidentKeys: string[];
  prNumbers: number[];
  prUrls: string[];
  slackRefs: string[];
  cycloidTags: string[];
}

export type PathMatchKind = "exact_file" | "file_under_directory" | "glob_prefix" | "directory_overlap";

export interface PathMatchEvidence {
  memoryPath: string;
  taskPath: string;
  kind: PathMatchKind;
  score: number;
}

export interface PathSpecificityResult {
  score: number;
  matches: PathMatchEvidence[];
}

// Language/extension tokens that are too generic to be a useful memory match anchor.
export const GENERIC_REPO_MEMORY_SYMBOL_TERMS = new Set(["js", "jsx", "sh", "ts", "tsx"]);

// Canonical GitHub pull-request URL matcher: capture groups are [owner, repo, number].
// Non-global so it is safe to share across `.test()` and `.match()` call sites.
export const GITHUB_PULL_REQUEST_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\b/i;

export const COMPANY_MEMORY_SUBJECT_ENTITY_TERMS = new Set([
  "datadog",
  "github",
  "jira",
  "linear",
  "notion",
  "sentry",
  "slack",
  "stripe",
]);

export const COMPANY_MEMORY_DOMAIN_ENTITY_GROUPS = [
  new Set(["oauth", "callback"]),
  new Set(["design", "theme", "palette", "color", "token", "tokens"]),
  new Set(["billing", "invoice", "invoices"]),
  new Set(["checkout", "coupon", "coupons"]),
  new Set(["terraform", "tf", "infra"]),
] as const;

export const COMPANY_MEMORY_ENVIRONMENT_TERMS = new Set([
  "browser",
  "infra",
  "local",
  "locally",
  "localhost",
  "prod",
  "production",
  "qa",
  "staging",
  "terraform",
  "tf",
  "ui",
  "unit",
]);

const LANGUAGE_STOP_TERMS = new Set([
  "a",
  "about",
  "all",
  "also",
  "am",
  "an",
  "and",
  "after",
  "as",
  "at",
  "are",
  "be",
  "been",
  "before",
  "but",
  "by",
  "can",
  "change",
  "changes",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "done",
  "from",
  "for",
  "get",
  "give",
  "go",
  "has",
  "have",
  "help",
  "how",
  "https",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "next",
  "no",
  "not",
  "of",
  "off",
  "on",
  "or",
  "our",
  "out",
  "only",
  "please",
  "run",
  "should",
  "so",
  "that",
  "the",
  "their",
  "then",
  "there",
  "they",
  "this",
  "through",
  "to",
  "up",
  "use",
  "using",
  "was",
  "we",
  "when",
  "where",
  "whether",
  "who",
  "what",
  "why",
  "will",
  "work",
  "with",
  "would",
  "you",
  "your",
  "repository",
]);

const PATH_NOISE_TERMS = new Set([
  "app",
  "apps",
  "bin",
  "build",
  "code",
  "control",
  "dist",
  "js",
  "jsx",
  "lib",
  "node",
  "plane",
  "src",
  "test",
  "tests",
  "ts",
  "tsx",
  "worker",
]);

const RECALL_TEXT_NOISE_TERMS = new Set([
  "boilerplate",
  "behavior",
  "code",
  "comment",
  "expect",
  "expected",
  "github",
  "issue",
  "launch",
  "linear",
  "make",
  "memory",
  "metadata",
  "repo",
  "request",
  "slack",
  "test",
  "tests",
  "tool",
  "api",
  "ui",
]);

const FILE_PATH_RE =
  /(?:^|[\s`("'=])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+(?:\.[A-Za-z0-9][A-Za-z0-9._-]*)?)(?=$|[\s`)"',:;])/g;

export function buildRetrievalSignals(input: { text: string; files?: string[]; symbols?: string[] }): RetrievalSignals {
  const files = normalizePaths([...(input.files ?? []), ...extractPathSignals(input.text)]);
  const terms = normalizeSignalTerms(input.text);
  const pathTerms = unique(files.flatMap(pathEvidenceTerms));
  const symbolTerms = unique([...(input.symbols ?? []), ...extractSymbolTerms(input.text)].flatMap(termForms));
  const errorTerms = extractErrorTerms(terms);
  const runtimeTerms = unique([...pathTerms, ...terms].filter(isRuntimeEnvironmentTerm));
  return {
    terms,
    files,
    pathTerms,
    symbolTerms,
    errorTerms,
    runtimeTerms,
  };
}

export function normalizeSignalTerms(input: string | string[]): string[] {
  const value = Array.isArray(input) ? input.join(" ") : input;
  return unique(
    value
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_/-]{1,}/g)
      ?.flatMap(termForms)
      .filter(isUsefulSignalTerm) ?? [],
  );
}

function isUsefulSignalTerm(term: string): boolean {
  if (term.length < 2) return false;
  if (LANGUAGE_STOP_TERMS.has(term)) return false;
  if (/^\d{8}$/.test(term)) return false;
  return true;
}

export function isUsefulEvidenceTerm(term: string): boolean {
  if (term.includes("/")) return false;
  return isUsefulSignalTerm(term);
}

export function isUsefulRecallEvidenceTerm(term: string): boolean {
  return term.length >= 3 && isUsefulSignalTerm(term) && !RECALL_TEXT_NOISE_TERMS.has(term);
}

export function extractCompanySubjectEntityTerms(text: string): Set<string> {
  const textWithoutUrls = text.replace(/\bhttps?:\/\/\S+/gi, " ");
  return new Set(normalizeSignalTerms(textWithoutUrls).filter((term) => COMPANY_MEMORY_SUBJECT_ENTITY_TERMS.has(term)));
}

export function termForms(term: string): string[] {
  const normalized = term.toLowerCase();
  const forms = new Set([normalized]);
  if (normalized.includes("-") || normalized.includes("/") || normalized.includes("_")) {
    for (const part of normalized.split(/[-/_]+/g)) {
      if (isUsefulSignalTerm(part)) forms.add(part);
    }
  }
  if (["block", "blocked", "blocker", "blockers", "blocking"].includes(normalized)) forms.add("block");
  if (normalized.length > 4 && normalized.endsWith("ies")) forms.add(`${normalized.slice(0, -3)}y`);
  if (normalized.length > 4 && normalized.endsWith("es")) forms.add(normalized.slice(0, -2));
  if (normalized.length > 3 && normalized.endsWith("s")) forms.add(normalized.slice(0, -1));
  if (normalized.length > 5 && normalized.endsWith("ing")) forms.add(normalized.slice(0, -3));
  if (normalized.length > 4 && normalized.endsWith("ed")) forms.add(normalized.slice(0, -2));
  if (normalized.length > 4 && normalized.endsWith("ly")) forms.add(normalized.slice(0, -2));
  return [...forms];
}

export function extractPathSignals(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(FILE_PATH_RE)) {
    const path = normalizeExtractedPathSignal(match[1] ?? "");
    if (path) paths.push(path);
  }
  return paths;
}

function normalizeExtractedPathSignal(value: string): string | null {
  const path = value
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/[.,;:!?]+$/g, "")
    .toLowerCase();
  if (!path || !path.includes("/")) return null;
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const firstSegment = segments[0] ?? "";
  const lastSegment = segments[segments.length - 1] ?? "";
  const hasExtension = /\.[a-z0-9][a-z0-9._-]*$/i.test(lastSegment);
  const hasKnownRepoRoot = new Set([
    "app",
    "apps",
    "docs",
    "infra",
    "packages",
    "scripts",
    "shared",
    "src",
    "tests",
    "workers",
  ]).has(firstSegment);
  if (!hasExtension && !hasKnownRepoRoot) return null;
  return path;
}

export function extractStructuredReferenceSignals(text: string): StructuredReferenceSignals {
  const urlPattern = String.raw`https:\/\/[^\s<>"')]+`;
  const urls = text.match(new RegExp(urlPattern, "g")) ?? [];
  const prUrls = unique(urls.filter((url) => GITHUB_PULL_REQUEST_URL_RE.test(url)));
  return {
    ticketKeys: unique(text.match(/\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b/g) ?? []),
    incidentKeys: unique((text.match(/\bINC-\d{2,10}\b/gi) ?? []).map((key) => key.toLowerCase())),
    prNumbers: uniqueNumbers([...extractGithubPrNumbers(prUrls), ...extractPlainPrNumbers(text)]),
    prUrls,
    slackRefs: unique(urls.filter((url) => /^https:\/\/[^/]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d{10,}/i.test(url))),
    cycloidTags: unique(
      text
        .split(/[\s<>]+/g)
        .filter((token) => /^\/?cycloid:[A-Za-z0-9_-]+/.test(token))
        .map((token) => `<${token.replace(/>$/, "")}>`),
    ),
  };
}

function extractGithubPrNumbers(urls: string[]): number[] {
  return urls.flatMap((url) => {
    const match = url.match(/\/pull\/(\d+)\b/i);
    if (!match?.[1]) return [];
    const value = Number(match[1]);
    return Number.isInteger(value) && value > 0 ? [value] : [];
  });
}

export function extractPlainPrNumbers(text: string): number[] {
  const numbers: number[] = [];
  const pattern = /\b(?:PR|pull request)\s*#?\s*(\d{1,7})\b/gi;
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1]);
    if (Number.isInteger(value) && value > 0) numbers.push(value);
  }
  return numbers;
}

export function isPullRequestReferencedForRepo(
  text: string,
  sourcePrNumber: number,
  repoOwner: string | null | undefined,
  repoName: string | null | undefined,
): boolean {
  const structured = extractStructuredReferenceSignals(text);
  const urlsForSourcePr = structured.prUrls.filter((url) => {
    const match = url.match(GITHUB_PULL_REQUEST_URL_RE);
    return Number(match?.[3]) === sourcePrNumber;
  });
  if (urlsForSourcePr.length > 0) {
    const owner = repoOwner?.trim().toLowerCase();
    const name = repoName?.trim().toLowerCase();
    if (!owner || !name) return false;
    return urlsForSourcePr.some((url) => {
      const match = url.match(GITHUB_PULL_REQUEST_URL_RE);
      return (
        match?.[1]?.toLowerCase() === owner &&
        match?.[2]?.toLowerCase() === name &&
        Number(match?.[3]) === sourcePrNumber
      );
    });
  }
  return extractPlainPrNumbers(text).includes(sourcePrNumber);
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

export function normalizePaths(paths: string[]): string[] {
  return unique(
    paths
      .flatMap(expandPathGlob)
      .map((path) =>
        path
          .trim()
          .replace(/^\.\/+/, "")
          .replace(/\/\*\*$/, "")
          .replace(/\/\*$/, "")
          .toLowerCase(),
      )
      .filter(Boolean),
  );
}

function pathsIntersect(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function pathSpecificityScore(memoryPaths: string[], taskPaths: string[]): PathSpecificityResult {
  const normalizedMemoryPaths = unique(memoryPaths.map((path) => path.trim()).filter(Boolean));
  const normalizedTaskPaths = normalizePaths(taskPaths);
  const matches = normalizedMemoryPaths
    .flatMap((memoryPath) =>
      normalizedTaskPaths.flatMap((taskPath) => {
        const match = bestPathMatch(memoryPath, taskPath);
        return match ? [match] : [];
      }),
    )
    .sort(
      (a, b) => b.score - a.score || a.memoryPath.localeCompare(b.memoryPath) || a.taskPath.localeCompare(b.taskPath),
    );
  return {
    score: matches[0]?.score ?? 0,
    matches,
  };
}

function bestPathMatch(memoryPath: string, taskPath: string): PathMatchEvidence | null {
  const globPrefix = globPrefixForPath(memoryPath);
  const memory = normalizePaths([memoryPath])[0];
  const task = normalizePaths([taskPath])[0];
  if (!memory || !task) return null;
  const memorySpecificity = pathSpecificityWeight(memory);
  const taskSpecificity = pathSpecificityWeight(task);
  if (globPrefix && task.startsWith(`${globPrefix}/`)) {
    return {
      memoryPath: memory,
      taskPath: task,
      kind: "glob_prefix",
      score: Math.min(0.72, 0.38 + memorySpecificity * 0.22 + taskSpecificity * 0.06),
    };
  }
  if (memory === task) {
    return {
      memoryPath: memory,
      taskPath: task,
      kind: "exact_file",
      score: Math.min(1, 0.9 + memorySpecificity * 0.1),
    };
  }
  if (task.startsWith(`${memory}/`) && pathLooksLikeDirectory(memoryPath)) {
    return {
      memoryPath: memory,
      taskPath: task,
      kind: "file_under_directory",
      score: Math.min(0.82, 0.46 + memorySpecificity * 0.2 + taskSpecificity * 0.08),
    };
  }
  if (pathsIntersect(memory, task)) {
    return {
      memoryPath: memory,
      taskPath: task,
      kind: "directory_overlap",
      score: Math.min(0.42, 0.18 + Math.min(memorySpecificity, taskSpecificity) * 0.18),
    };
  }
  return null;
}

function pathSpecificityWeight(path: string): number {
  const normalized = normalizePaths([path])[0];
  if (!normalized) return 0;
  const segments = normalized.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1] ?? "";
  const fileBonus = /\.[a-z0-9][a-z0-9._-]*$/i.test(lastSegment) ? 0.35 : 0;
  const depthScore = Math.min(0.55, segments.length * 0.08);
  const evidenceScore = Math.min(0.25, pathEvidenceTerms(normalized).length * 0.05);
  return Math.min(1, depthScore + fileBonus + evidenceScore);
}

export function pathEvidenceTerms(path: string): string[] {
  return path
    .toLowerCase()
    .split(/[/. _-]+/g)
    .map((term) => term.trim())
    .filter((term) => isUsefulSignalTerm(term) && !PATH_NOISE_TERMS.has(term));
}

export function overlapScore(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const matched = right.filter(
    (value) => leftSet.has(value) || [...leftSet].some((leftValue) => pathsIntersect(leftValue, value)),
  );
  return matched.length === 0 ? 0 : Math.min(1, matched.length / Math.min(left.length, right.length));
}

export function buildSignalIdf(documents: string[]): Map<string, number> {
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of new Set(normalizeSignalTerms(document))) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const documentCount = Math.max(1, documents.length);
  const idf = new Map<string, number>();
  for (const [term, frequency] of documentFrequency) {
    idf.set(term, Math.log(1 + (documentCount - frequency + 0.5) / (frequency + 0.5)));
  }
  return idf;
}

export function textSimilarityScore(text: string, queryTerms: string[], idf: ReadonlyMap<string, number>): number {
  const documentTerms = new Set(normalizeSignalTerms(text));
  const usefulTerms = queryTerms.filter(isUsefulSignalTerm);
  if (usefulTerms.length === 0) return 0;
  const weightedTerms = usefulTerms
    .map((term) => ({ term, weight: idf.get(term) ?? 0.1 }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 16);
  const denominator = weightedTerms.reduce((sum, term) => sum + term.weight, 0);
  if (denominator <= 0) return 0;
  return (
    weightedTerms.filter(({ term }) => documentTerms.has(term)).reduce((sum, term) => sum + term.weight, 0) /
    denominator
  );
}

function extractErrorTerms(terms: string[]): string[] {
  return unique(
    terms
      .flatMap(termForms)
      .filter((term) => /error|fail|failed|failure|timeout|exception|denied|unauthorized|forbidden/.test(term))
      .concat(terms.filter((term) => /^(?:4\d\d|5\d\d|[45]xx)$/.test(term))),
  );
}

export function extractNegatedSignalTerms(text: string, terms: Iterable<string>): Set<string> {
  const targetTerms = new Set([...terms].flatMap(termForms));
  const tokens =
    text
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_/-]{1,}/g) ?? [];
  const negated = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const tokenForms = termForms(tokens[index] ?? "").filter((term) => targetTerms.has(term));
    if (tokenForms.length === 0) continue;
    const previousTokens = tokens.slice(Math.max(0, index - 4), index);
    if (!previousTokens.some(isNegationToken)) continue;
    for (const term of tokenForms) negated.add(term);
  }
  return negated;
}

export function hasAnyTerm(terms: Set<string>, needles: Iterable<string>): boolean {
  for (const needle of needles) {
    if (terms.has(needle)) return true;
  }
  return false;
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function expandPathGlob(path: string): string[] {
  const normalized = path.trim();
  if (!normalized.includes("*")) return [normalized];
  return [normalized, normalized.replace(/\/\*\*\/?\*?$/, ""), normalized.replace(/\*.*$/, "")].filter(Boolean);
}

function globPrefixForPath(path: string): string | null {
  if (!path.includes("*")) return null;
  return normalizePaths([path.replace(/\*.*$/, "").replace(/\/+$/, "")])[0] ?? null;
}

function pathLooksLikeDirectory(path: string): boolean {
  const normalized = path.trim();
  const segments = normalized.split("/");
  const lastSegment = segments[segments.length - 1] ?? "";
  return normalized.endsWith("/") || !/\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(lastSegment);
}

function extractSymbolTerms(text: string): string[] {
  return text.match(/\b[A-Za-z_$][A-Za-z0-9_$]{2,}\b/g) ?? [];
}

function isRuntimeEnvironmentTerm(term: string): boolean {
  return (
    term.startsWith("prod") ||
    term.startsWith("staging") ||
    term === "qa" ||
    term === "local" ||
    term === "localhost" ||
    term === "unit" ||
    term === "browser" ||
    term === "infra" ||
    term === "ui"
  );
}

function isNegationToken(token: string): boolean {
  return ["avoid", "except", "never", "no", "not", "skip", "without"].includes(token);
}
