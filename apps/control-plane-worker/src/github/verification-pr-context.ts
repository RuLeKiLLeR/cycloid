// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
import { normalizeGithubPullRequestUrl } from "../../../../shared/agent/verify-directive.js";
import { extractVercelDeployPreviewFromCheckRuns } from "../../../../shared/integrations/vercel-deploy-preview.js";
import type { VerificationPrContext } from "../../../../shared/types/sandbox.js";
import { tracedFetch } from "../observability/wrappers";
import type { Env } from "../types";
import { assertGithubOk } from "./errors";
import { getInstallationByOwner } from "./installations-db";
import { createInstallationToken } from "./octokit";
import { GITHUB_API, githubHeaders } from "./pr";

const USER_AGENT = "Cycloid-Control-Plane";
const MAX_BODY_CHARS = 4000;
const MAX_DISCUSSION_BODY_CHARS = 1000;
const MAX_COMMIT_MESSAGE_CHARS = 300;
const MAX_CHECKS_SUMMARY_CHARS = 2000;
const MAX_FILES = 100;
const MAX_COMMITS = 50;
const MAX_DISCUSSION = 40;

type VerificationPrContextEnv = Pick<Env, "DB" | "GITHUB_APP_ID" | "GITHUB_PRIVATE_KEY" | "REPOS_CACHE">;

export type ParsedGithubPullRequestUrl = {
  prUrl: string;
  owner: string;
  repo: string;
  number: number;
};

export type VerificationPrContextAuthHint = {
  installationId?: number | null;
  repoOwner?: string | null;
  repoName?: string | null;
  requireRepoMatch?: boolean;
};

type FetchJsonResult<T> = { ok: true; value: T } | { ok: false; warning: string };
type InstallationTokenResolution = { token: string | null; warning?: string };

type GithubPullRequestResponse = {
  html_url?: string;
  number?: number;
  title?: string | null;
  body?: string | null;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  labels?: Array<{ name?: string | null } | null> | null;
  user?: { login?: string | null } | null;
  head?: {
    ref?: string | null;
    sha?: string | null;
    repo?: {
      name?: string | null;
      owner?: { login?: string | null } | null;
    } | null;
  } | null;
  base?: { ref?: string | null } | null;
};

type GithubFileResponse = {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
};

type GithubCommitResponse = {
  sha?: string;
  commit?: { message?: string | null; author?: { name?: string | null } | null } | null;
  author?: { login?: string | null } | null;
};

type GithubDiscussionResponse = {
  user?: { login?: string | null } | null;
  body?: string | null;
  created_at?: string | null;
};

type GithubCheckRun = {
  id?: number | null;
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  // details_url / html_url point at the Actions job (".../actions/runs/{runId}/job/{jobId}"),
  // the only link from a check run back to its workflow run (and thus its workflow identity).
  details_url?: string | null;
  html_url?: string | null;
  output?: { title?: string | null; summary?: string | null; text?: string | null } | null;
  app?: { slug?: string | null; name?: string | null } | null;
};

type GithubCheckRunsResponse = {
  check_runs?: GithubCheckRun[];
};

type GithubWorkflowRunsResponse = {
  workflow_runs?: Array<{ id?: number | null; workflow_id?: number | null }>;
};

type GithubCombinedStatusResponse = {
  state?: string | null;
  statuses?: Array<{
    context?: string | null;
    state?: string | null;
  }>;
};

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function truncateText(value: string, maxChars: number, warnings: string[], label: string): string {
  if (value.length <= maxChars) return value;
  warnings.push(`${label} truncated to ${maxChars} characters.`);
  return `${value.slice(0, maxChars)}\n[truncated]`;
}

function apiUrl(owner: string, repo: string, path: string): string {
  return `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`;
}

function buildHeaders(token: string | null): HeadersInit {
  if (token) return githubHeaders(token);
  return {
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
}

export function parseGithubPullRequestUrl(rawUrl: unknown): ParsedGithubPullRequestUrl | null {
  const normalized = normalizeGithubPullRequestUrl(rawUrl);
  if (!normalized) return null;
  const url = new URL(normalized);
  const parts = url.pathname.split("/").filter(Boolean);
  const number = Number(parts[3]);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { prUrl: normalized, owner: parts[0], repo: parts[1], number };
}

export function githubPullRequestUrlMatchesRepo(
  rawUrl: unknown,
  repoOwner: string | null | undefined,
  repoName: string | null | undefined,
): boolean {
  if (!repoOwner || !repoName) return false;
  const parsed = parseGithubPullRequestUrl(rawUrl);
  return (
    parsed !== null &&
    parsed.owner.toLowerCase() === repoOwner.toLowerCase() &&
    parsed.repo.toLowerCase() === repoName.toLowerCase()
  );
}

function authHintMatchesTarget(
  authHint: VerificationPrContextAuthHint | undefined,
  target: ParsedGithubPullRequestUrl,
): boolean {
  return (
    authHint?.repoOwner?.toLowerCase() === target.owner.toLowerCase() &&
    authHint?.repoName?.toLowerCase() === target.repo.toLowerCase()
  );
}

async function resolveInstallationToken(
  env: VerificationPrContextEnv,
  target: ParsedGithubPullRequestUrl,
  authHint?: VerificationPrContextAuthHint,
): Promise<InstallationTokenResolution> {
  const authRequired = Boolean(authHint?.requireRepoMatch || authHint?.installationId);
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    if (authRequired) throw new Error("GitHub App credentials are required for this verification target");
    return { token: null, warning: "GitHub App credentials unavailable; fetching public PR context anonymously" };
  }

  const hintedOwnerMatches = authHintMatchesTarget(authHint, target);
  let installationId =
    hintedOwnerMatches && typeof authHint?.installationId === "number" ? authHint.installationId : null;

  if (authHint?.requireRepoMatch && !hintedOwnerMatches) {
    throw new Error("Verification target PR repository does not match authorized session repository");
  }

  if (!installationId) {
    const installation = await getInstallationByOwner(env.DB, target.owner);
    if (!installation || installation.suspended_at !== null) {
      if (authRequired) throw new Error("GitHub App installation is unavailable for this verification target");
      return { token: null, warning: "GitHub App installation unavailable; fetching public PR context anonymously" };
    }
    installationId = installation.installation_id;
  }

  return { token: await createInstallationToken(env as Env, installationId) };
}

async function fetchJson<T>(url: string, token: string | null, label: string): Promise<T> {
  const response = await tracedFetch(url, { headers: buildHeaders(token) }, label);
  await assertGithubOk(response, label);
  return (await response.json()) as T;
}

function parseLinkRel(linkHeader: string | null, rel: string): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === rel) return match[1];
  }
  return null;
}

async function fetchOptionalJson<T>(url: string, token: string | null, label: string): Promise<FetchJsonResult<T>> {
  try {
    return { ok: true, value: await fetchJson<T>(url, token, label) };
  } catch (error) {
    return { ok: false, warning: `${label}: ${String(error)}` };
  }
}

async function fetchOptionalRecentArray<T>(
  url: string,
  token: string | null,
  label: string,
): Promise<FetchJsonResult<T[]>> {
  try {
    const firstResponse = await tracedFetch(url, { headers: buildHeaders(token) }, label);
    await assertGithubOk(firstResponse, label);
    const lastUrl = parseLinkRel(firstResponse.headers.get("link"), "last");
    if (lastUrl && lastUrl !== url) {
      const lastResponse = await tracedFetch(lastUrl, { headers: buildHeaders(token) }, label);
      await assertGithubOk(lastResponse, `${label} last page`);
      return { ok: true, value: (await lastResponse.json()) as T[] };
    }
    return { ok: true, value: (await firstResponse.json()) as T[] };
  } catch (error) {
    return { ok: false, warning: `${label}: ${String(error)}` };
  }
}

// The Actions run id embedded in a check run's job URL; lets us map a check run back
// to its workflow run (and, via the run list, its workflow identity).
function parseActionsRunId(run: GithubCheckRun): string | null {
  const match = (run.details_url ?? run.html_url ?? "").match(/\/actions\/runs\/(\d+)/);
  return match ? match[1] : null;
}

// GitHub never deletes superseded check runs: a re-run (e.g. a CI job retried after a
// label flips a gate) leaves the original failed run on the SHA forever, alongside the
// newer green run. Branch protection / mergeability evaluate only the LATEST run per
// check, so summarizing the raw list makes a green, mergeable PR look like it still has
// a failing gate - which led the verifier to a false INCONCLUSIVE (ARC-1326).
//
// Collapse to the most recent run per check, where "same check" is keyed by
// (workflowId, name, app) -- NOT just (name, app). Two distinct workflows can emit a
// job with the same name (e.g. a "Validate" job in two deploy workflows); keying on the
// name alone would treat them as reruns of one check and could hide a genuine failure.
// runIdToWorkflow maps an Actions run id to its stable workflow id. When a run's workflow
// can't be resolved (map fetch failed, or a non-Actions check with no run id), fall back
// to a per-run key so the run is never collapsed with another -- failing closed: we may
// show a superseded run, but we never hide a distinct check's failure.
function latestCheckRunsByName(checkRuns: GithubCheckRun[], runIdToWorkflow: Map<string, string>): GithubCheckRun[] {
  const latest = new Map<string, { run: GithubCheckRun; recency: string; id: number }>();
  for (const run of checkRuns) {
    const runId = parseActionsRunId(run);
    const workflowKey = runId ? (runIdToWorkflow.get(runId) ?? `run:${runId}`) : `check:${run.id ?? ""}`;
    const identity = JSON.stringify([workflowKey, run.name ?? "", run.app?.slug ?? run.app?.name ?? ""]);
    // started_at orders attempts by when each run began; a newer in-flight run
    // supersedes an older completed one, matching GitHub's "latest run" check state.
    const recency = run.started_at ?? run.completed_at ?? "";
    const id = typeof run.id === "number" ? run.id : 0;
    const existing = latest.get(identity);
    if (!existing || recency > existing.recency || (recency === existing.recency && id > existing.id)) {
      latest.set(identity, { run, recency, id });
    }
  }
  return [...latest.values()].map((entry) => entry.run);
}

function formatChecksSummary(
  checkRuns: GithubCheckRunsResponse | null,
  combinedStatus: GithubCombinedStatusResponse | null,
  runIdToWorkflow: Map<string, string>,
  warnings: string[],
): string | null {
  const lines: string[] = [];
  if (checkRuns?.check_runs?.length) {
    // Sort deterministically before counting and slicing: GitHub returns
    // check runs in arrival order, so identical PR state would otherwise yield
    // different summary strings and a different slice(0, 10) subset run to run.
    const runState = (run: { status?: string | null; conclusion?: string | null }): string =>
      run.conclusion ?? run.status ?? "unknown";
    const sortedRuns = latestCheckRunsByName(checkRuns.check_runs, runIdToWorkflow).sort(
      (a, b) =>
        runState(a).localeCompare(runState(b)) ||
        (a.name ?? "").localeCompare(b.name ?? "") ||
        (a.app?.slug ?? a.app?.name ?? "").localeCompare(b.app?.slug ?? b.app?.name ?? ""),
    );
    const counts = new Map<string, number>();
    for (const run of sortedRuns) {
      counts.set(runState(run), (counts.get(runState(run)) ?? 0) + 1);
    }
    lines.push(
      `Check runs: ${[...counts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([state, count]) => `${state}=${count}`)
        .join(", ")}`,
    );
    for (const run of sortedRuns.slice(0, 10)) {
      const app = run.app?.slug ?? run.app?.name ?? "unknown app";
      lines.push(`- ${run.name ?? "unnamed"}: ${runState(run)} (${app})`);
    }
  }
  if (combinedStatus) {
    lines.push(`Commit status: ${combinedStatus.state ?? "unknown"}`);
    const sortedStatuses = [...(combinedStatus.statuses ?? [])].sort(
      (a, b) => (a.context ?? "").localeCompare(b.context ?? "") || (a.state ?? "").localeCompare(b.state ?? ""),
    );
    for (const status of sortedStatuses.slice(0, 10)) {
      lines.push(`- ${status.context ?? "unnamed"}: ${status.state ?? "unknown"}`);
    }
  }
  if (lines.length === 0) return null;
  return truncateText(lines.join("\n"), MAX_CHECKS_SUMMARY_CHARS, warnings, "checksSummary");
}

export async function fetchVerificationPrContext(
  env: VerificationPrContextEnv,
  targetPrUrl: string,
  authHint?: VerificationPrContextAuthHint,
): Promise<VerificationPrContext> {
  const parsed = parseGithubPullRequestUrl(targetPrUrl);
  if (!parsed) throw new Error("Invalid GitHub pull request URL");
  if (authHint?.requireRepoMatch && !authHintMatchesTarget(authHint, parsed)) {
    throw new Error("Verification target PR repository does not match authorized session repository");
  }

  const fetchWarnings: string[] = [];
  let token: string | null = null;
  try {
    const tokenResolution = await resolveInstallationToken(env, parsed, authHint);
    token = tokenResolution.token;
    if (tokenResolution.warning) fetchWarnings.push(tokenResolution.warning);
  } catch (error) {
    throw new Error(`GitHub installation token unavailable: ${String(error)}`);
  }

  const pr = await fetchJson<GithubPullRequestResponse>(
    apiUrl(parsed.owner, parsed.repo, `/pulls/${parsed.number}`),
    token,
    "github.verificationPrContext.pull",
  );
  const headSha = optionalString(pr.head?.sha) ?? "";

  const [filesResult, commitsResult, commentsResult, reviewsResult, checkRunsResult, statusResult, workflowRunsResult] =
    await Promise.all([
      fetchOptionalJson<GithubFileResponse[]>(
        apiUrl(parsed.owner, parsed.repo, `/pulls/${parsed.number}/files?per_page=${MAX_FILES}`),
        token,
        "github.verificationPrContext.files",
      ),
      fetchOptionalJson<GithubCommitResponse[]>(
        apiUrl(parsed.owner, parsed.repo, `/pulls/${parsed.number}/commits?per_page=${MAX_COMMITS}`),
        token,
        "github.verificationPrContext.commits",
      ),
      fetchOptionalRecentArray<GithubDiscussionResponse>(
        apiUrl(parsed.owner, parsed.repo, `/issues/${parsed.number}/comments?per_page=100`),
        token,
        "github.verificationPrContext.comments",
      ),
      fetchOptionalRecentArray<GithubDiscussionResponse>(
        apiUrl(parsed.owner, parsed.repo, `/pulls/${parsed.number}/reviews?per_page=100`),
        token,
        "github.verificationPrContext.reviews",
      ),
      headSha
        ? fetchOptionalJson<GithubCheckRunsResponse>(
            apiUrl(parsed.owner, parsed.repo, `/commits/${headSha}/check-runs?per_page=20`),
            token,
            "github.verificationPrContext.checkRuns",
          )
        : Promise.resolve({ ok: false as const, warning: "github.verificationPrContext.checkRuns: missing head SHA" }),
      headSha
        ? fetchOptionalJson<GithubCombinedStatusResponse>(
            apiUrl(parsed.owner, parsed.repo, `/commits/${headSha}/status`),
            token,
            "github.verificationPrContext.status",
          )
        : Promise.resolve({ ok: false as const, warning: "github.verificationPrContext.status: missing head SHA" }),
      // Workflow runs for this head let us map each check run to its workflow id, so
      // reruns collapse but distinct workflows sharing a job name stay separate (ARC-1326).
      headSha
        ? fetchOptionalJson<GithubWorkflowRunsResponse>(
            apiUrl(
              parsed.owner,
              parsed.repo,
              `/actions/runs?head_sha=${headSha}&per_page=100&exclude_pull_requests=true`,
            ),
            token,
            "github.verificationPrContext.workflowRuns",
          )
        : Promise.resolve({
            ok: false as const,
            warning: "github.verificationPrContext.workflowRuns: missing head SHA",
          }),
    ]);

  for (const result of [
    filesResult,
    commitsResult,
    commentsResult,
    reviewsResult,
    checkRunsResult,
    statusResult,
    workflowRunsResult,
  ]) {
    if (!result.ok) fetchWarnings.push(result.warning);
  }

  // run id -> stable workflow id, so check-run dedup can tell reruns of one check apart
  // from two distinct checks that share a job name. Empty on fetch failure (fail-closed:
  // dedup then falls back to per-run keys and never hides a distinct check's failure).
  const runIdToWorkflow = new Map<string, string>();
  if (workflowRunsResult.ok) {
    for (const run of workflowRunsResult.value.workflow_runs ?? []) {
      if (typeof run.id === "number" && typeof run.workflow_id === "number") {
        runIdToWorkflow.set(String(run.id), String(run.workflow_id));
      }
    }
  }

  const files = (filesResult.ok ? filesResult.value : []).slice(0, MAX_FILES).map((file) => ({
    path: file.filename ?? "",
    status: file.status ?? "unknown",
    additions: typeof file.additions === "number" ? file.additions : 0,
    deletions: typeof file.deletions === "number" ? file.deletions : 0,
  }));
  const commits = (commitsResult.ok ? commitsResult.value : []).slice(0, MAX_COMMITS).map((commit, index) => ({
    sha: commit.sha ?? "",
    message: truncateText(
      commit.commit?.message ?? "",
      MAX_COMMIT_MESSAGE_CHARS,
      fetchWarnings,
      `commits[${index}].message`,
    ),
    authorLogin: optionalString(commit.author?.login) ?? optionalString(commit.commit?.author?.name),
  }));
  const discussions = [
    ...(commentsResult.ok ? commentsResult.value.map((comment) => ({ kind: "comment" as const, item: comment })) : []),
    ...(reviewsResult.ok ? reviewsResult.value.map((review) => ({ kind: "review" as const, item: review })) : []),
  ]
    // Secondary keys keep ordering and the MAX_DISCUSSION truncation boundary
    // deterministic when comments/reviews share a created_at timestamp.
    .sort(
      (a, b) =>
        String(b.item.created_at ?? "").localeCompare(String(a.item.created_at ?? "")) ||
        a.kind.localeCompare(b.kind) ||
        String(a.item.user?.login ?? "").localeCompare(String(b.item.user?.login ?? "")) ||
        String(a.item.body ?? "").localeCompare(String(b.item.body ?? "")),
    )
    .slice(0, MAX_DISCUSSION)
    .map(({ kind, item }, index) => ({
      kind,
      authorLogin: optionalString(item.user?.login),
      body: truncateText(item.body ?? "", MAX_DISCUSSION_BODY_CHARS, fetchWarnings, `recentDiscussion[${index}].body`),
      createdAt: optionalString(item.created_at),
    }));

  return {
    prUrl: optionalString(pr.html_url) ?? parsed.prUrl,
    owner: parsed.owner,
    repo: parsed.repo,
    number: typeof pr.number === "number" ? pr.number : parsed.number,
    title: pr.title ?? "",
    body: pr.body == null ? null : truncateText(pr.body, MAX_BODY_CHARS, fetchWarnings, "body"),
    state: pr.merged === true ? "merged" : pr.state === "closed" ? "closed" : "open",
    draft: pr.draft === true,
    // GitHub's own merge-gate verdict + applied labels, so the verifier can trust
    // the deduplicated mergeability picture instead of re-deriving it from raw checks.
    // mergeable / mergeable_state may be null while GitHub computes them asynchronously.
    mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null,
    mergeStateStatus: optionalString(pr.mergeable_state),
    labels: Array.isArray(pr.labels)
      ? pr.labels.map((label) => optionalString(label?.name)).filter((name): name is string => name != null)
      : [],
    headRef: optionalString(pr.head?.ref) ?? "",
    headSha,
    headRepoOwner: optionalString(pr.head?.repo?.owner?.login),
    headRepoName: optionalString(pr.head?.repo?.name),
    baseRef: optionalString(pr.base?.ref) ?? "",
    authorLogin: optionalString(pr.user?.login),
    files,
    commits,
    checksSummary: formatChecksSummary(
      checkRunsResult.ok ? checkRunsResult.value : null,
      statusResult.ok ? statusResult.value : null,
      runIdToWorkflow,
      fetchWarnings,
    ),
    vercelDeployPreview: extractVercelDeployPreviewFromCheckRuns(
      checkRunsResult.ok ? latestCheckRunsByName(checkRunsResult.value.check_runs ?? [], runIdToWorkflow) : null,
    ),
    recentDiscussion: discussions,
    fetchWarnings,
  };
}
