export type QaDirectiveParseResult = {
  qa: boolean;
  text: string;
  removedVerifyDirective: boolean;
};

export type QaTargetPullRequestUrlSelection =
  | {
      status: "missing";
      targetPrUrl: null;
      urls: string[];
    }
  | {
      status: "selected";
      targetPrUrl: string;
      source: "prompt" | "current-pr";
      urls: string[];
    }
  | {
      status: "ambiguous";
      targetPrUrl: null;
      urls: string[];
    };

export const AMBIGUOUS_QA_TARGET_PR_URL_MESSAGE =
  "QA target is ambiguous because the prompt includes multiple GitHub pull request URLs. Provide targetPrUrl or include only one pull request URL.";

const QA_TRUE_DIRECTIVE_REGEX = /(^|[\s,])qa[ \t]*=[ \t]*true(?=$|[\s,])/gi;
const REMOVED_VERIFY_TRUE_DIRECTIVE_REGEX = /(^|[\s,])verify[ \t]*=[ \t]*true(?=$|[\s,])/i;
const GITHUB_PULL_REQUEST_URL_REGEX = /\bhttps:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+\b/gi;
const MAX_TARGET_PR_URL_LENGTH = 500;

export function parseQaDirectiveFromText(rawText: unknown): QaDirectiveParseResult {
  if (typeof rawText !== "string") return { qa: false, text: "", removedVerifyDirective: false };

  let found = false;
  const removedVerifyDirective = REMOVED_VERIFY_TRUE_DIRECTIVE_REGEX.test(rawText);
  const text = rawText
    .replace(QA_TRUE_DIRECTIVE_REGEX, (match, prefix: string) => {
      found = true;
      return prefix && prefix.trim().length > 0 ? prefix : " ";
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+(\r?\n)/g, "$1")
    .replace(/(\r?\n)[ \t]+/g, "$1")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .trim();

  return { qa: found, text, removedVerifyDirective };
}

export function extractGithubPullRequestUrl(rawText: unknown): string | null {
  return extractGithubPullRequestUrls(rawText)[0] ?? null;
}

export function resolveQaTargetPullRequestUrl(
  rawText: unknown,
  options: { currentPrUrl?: unknown } = {},
): QaTargetPullRequestUrlSelection {
  const urls = extractGithubPullRequestUrls(rawText);
  const currentPrUrl = normalizeGithubPullRequestUrl(options.currentPrUrl);
  if (urls.length === 0) {
    return currentPrUrl
      ? { status: "selected", targetPrUrl: currentPrUrl, source: "current-pr", urls }
      : { status: "missing", targetPrUrl: null, urls };
  }
  if (urls.length === 1) {
    return { status: "selected", targetPrUrl: urls[0]!, source: "prompt", urls };
  }
  if (currentPrUrl) {
    return { status: "selected", targetPrUrl: currentPrUrl, source: "current-pr", urls };
  }
  return { status: "ambiguous", targetPrUrl: null, urls };
}

export function extractGithubPullRequestUrls(rawText: unknown): string[] {
  if (typeof rawText !== "string") return [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of rawText.matchAll(GITHUB_PULL_REQUEST_URL_REGEX)) {
    const normalized = normalizeGithubPullRequestUrl(match[0]);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      urls.push(normalized);
    }
  }
  return urls;
}

export function normalizeGithubPullRequestUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > MAX_TARGET_PR_URL_LENGTH) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts.length !== 4 || pathParts[2] !== "pull" || !/^\d+$/.test(pathParts[3])) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(pathParts[0]) || !/^[A-Za-z0-9_.-]+$/.test(pathParts[1])) return null;

  return `https://github.com/${pathParts[0]}/${pathParts[1]}/pull/${pathParts[3]}`;
}
