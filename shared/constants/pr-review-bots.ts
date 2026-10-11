export const PR_REVIEW_BOT_IDS = [
  "greptile",
  "coderabbit",
  "cursor-bugbot",
  "chatgpt-codex",
  "strix",
  "copilot",
] as const;

export type PrReviewKnownBotId = (typeof PR_REVIEW_BOT_IDS)[number];

export type PrReviewExpectedBot = { type: "known"; id: PrReviewKnownBotId } | { type: "custom"; login: string };

export const PR_REVIEW_EXPECTED_BOT_LIMIT = 25;

export const PR_REVIEW_BOT_LABELS: Record<PrReviewKnownBotId, string> = {
  greptile: "Greptile",
  coderabbit: "CodeRabbit",
  "cursor-bugbot": "Cursor Bugbot",
  "chatgpt-codex": "ChatGPT Codex",
  strix: "Strix",
  copilot: "GitHub Copilot",
};

export const PR_REVIEW_BOT_OPTIONS = PR_REVIEW_BOT_IDS.map((id) => ({
  id,
  label: PR_REVIEW_BOT_LABELS[id],
}));

export const PR_REVIEW_KNOWN_BOT_ID_SET: ReadonlySet<string> = new Set(PR_REVIEW_BOT_IDS);

const GITHUB_OWNER_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const GITHUB_REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function normalizeGithubLogin(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidGithubOwnerLogin(value: string): boolean {
  return GITHUB_OWNER_LOGIN_RE.test(value);
}

export function isValidGithubRepoName(value: string): boolean {
  return GITHUB_REPO_NAME_RE.test(value);
}

export function normalizePrReviewExpectedBot(bot: PrReviewExpectedBot): PrReviewExpectedBot {
  if (bot.type === "known") {
    return { type: "known", id: bot.id.toLowerCase() as PrReviewKnownBotId };
  }
  return { type: "custom", login: normalizeGithubLogin(bot.login) };
}

export function prReviewBotKeyLabel(key: string): string {
  // The QA verifier's managed-comment key (not a user-configurable known-bot union member).
  // Keep this as a bare label; the persona header belongs to shared/agent/pr-personas.ts (rendering only).
  if (key === "known:cycloid-qa") return "Cycloid QA";
  if (key.startsWith("known:")) {
    const id = key.slice("known:".length);
    return PR_REVIEW_BOT_LABELS[id as PrReviewKnownBotId] ?? id;
  }
  if (key.startsWith("custom:")) {
    // Wrap in a code span so embedding the label in a GitHub comment shows the @login for
    // readability without resolving the mention and notifying that account.
    return `\`@${key.slice("custom:".length)}\``;
  }
  return key;
}

export const MERGE_CONFLICT_RESOLUTION_DEFAULT_ENABLED = true;
