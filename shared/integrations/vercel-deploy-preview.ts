export type VercelDeployPreviewStatus = "ready" | "building" | "error" | "queued" | "canceled" | "unknown";

export type VercelDeployPreview = {
  provider: "vercel";
  status: VercelDeployPreviewStatus;
  previewUrl: string | null;
  dashboardUrl: string | null;
  checkName: string | null;
  conclusion: string | null;
};

type GithubCheckRunLike = {
  id?: number | null;
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  details_url?: string | null;
  html_url?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  app?: { slug?: string | null; name?: string | null } | null;
  output?: { title?: string | null; summary?: string | null; text?: string | null } | null;
};

const VERCEL_APP_SLUGS = new Set(["vercel", "vercel-protected"]);
const VERCEL_PREVIEW_URL_PATTERN = /https?:\/\/(?:[a-z0-9-]+\.)+(?:vercel\.app|vercel\.sh)(?:\/[^\s)\]"']*)?/gi;

function isVercelCheckRun(checkRun: GithubCheckRunLike): boolean {
  const slug = checkRun.app?.slug?.trim().toLowerCase() ?? "";
  if (slug && VERCEL_APP_SLUGS.has(slug)) return true;
  const name = checkRun.name?.trim().toLowerCase() ?? "";
  return name === "vercel" || name.startsWith("vercel ");
}

function mapVercelDeployStatus(
  status: string | null | undefined,
  conclusion: string | null | undefined,
): VercelDeployPreviewStatus {
  const normalizedConclusion = conclusion?.trim().toLowerCase() ?? "";
  if (normalizedConclusion === "success") return "ready";
  if (normalizedConclusion === "failure") return "error";
  if (normalizedConclusion === "cancelled" || normalizedConclusion === "canceled") return "canceled";
  const normalizedStatus = status?.trim().toLowerCase() ?? "";
  if (normalizedStatus === "queued") return "queued";
  if (normalizedStatus === "in_progress") return "building";
  return "unknown";
}

function extractPreviewUrlFromText(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  if (!text) return null;
  const matches = [...text.matchAll(VERCEL_PREVIEW_URL_PATTERN)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1]?.[0] ?? null;
}

function extractPreviewUrlFromCheckRun(checkRun: GithubCheckRunLike): string | null {
  const output = checkRun.output;
  return (
    extractPreviewUrlFromText(output?.summary) ??
    extractPreviewUrlFromText(output?.text) ??
    extractPreviewUrlFromText(output?.title) ??
    null
  );
}

function dashboardUrlFromCheckRun(checkRun: GithubCheckRunLike): string | null {
  const detailsUrl = checkRun.details_url?.trim() ?? "";
  if (detailsUrl) return detailsUrl;
  const htmlUrl = checkRun.html_url?.trim() ?? "";
  return htmlUrl || null;
}

function latestVercelCheckRunPerIdentity(checkRuns: readonly GithubCheckRunLike[]): GithubCheckRunLike[] {
  const latest = new Map<string, { run: GithubCheckRunLike; recency: string; id: number }>();
  for (const run of checkRuns) {
    if (!isVercelCheckRun(run)) continue;
    const identity = JSON.stringify([run.app?.slug ?? run.app?.name ?? "", run.name ?? ""]);
    const recency = run.started_at ?? run.completed_at ?? "";
    const id = typeof run.id === "number" ? run.id : 0;
    const existing = latest.get(identity);
    if (!existing || recency > existing.recency || (recency === existing.recency && id > existing.id)) {
      latest.set(identity, { run, recency, id });
    }
  }
  return [...latest.values()].map((entry) => entry.run);
}

export function extractVercelDeployPreviewFromCheckRuns(
  checkRuns: readonly GithubCheckRunLike[] | null | undefined,
): VercelDeployPreview | null {
  if (!Array.isArray(checkRuns) || checkRuns.length === 0) return null;

  const vercelRuns = latestVercelCheckRunPerIdentity(checkRuns);
  if (vercelRuns.length === 0) return null;

  const preferred =
    vercelRuns.find((run) => run.conclusion === "success") ??
    vercelRuns.find((run) => run.status === "completed") ??
    vercelRuns[0];
  if (!preferred) return null;

  return {
    provider: "vercel",
    status: mapVercelDeployStatus(preferred.status, preferred.conclusion),
    previewUrl: extractPreviewUrlFromCheckRun(preferred),
    dashboardUrl: dashboardUrlFromCheckRun(preferred),
    checkName: preferred.name?.trim() || null,
    conclusion: preferred.conclusion?.trim() || preferred.status?.trim() || null,
  };
}
