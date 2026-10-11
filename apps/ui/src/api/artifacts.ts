import { requestJson } from "./client";

export type SessionArtifactRow = {
  artifactId: string;
  sessionId: string;
  promptId: string | null;
  type: string;
  url: string | null;
  metadata: {
    label?: string;
    filename?: string;
    contentType?: string;
    access?: {
      visibility: "public" | "private";
      expiresAt: number | null;
      revokedAt: number | null;
    };
  } | null;
  createdAt: number;
};

const PUBLIC_ARTIFACT_TOKEN_QUERY_PARAM = "artifactToken";

export async function fetchSessionArtifacts(sessionId: string, signal?: AbortSignal): Promise<SessionArtifactRow[]> {
  const data = await requestJson<{ artifacts?: SessionArtifactRow[] }>(
    `/api/sessions/${sessionId}/artifacts/list`,
    { signal },
    "Failed to load session artifacts",
  );
  return data.artifacts ?? [];
}

/**
 * Pick a URL the browser can use to render a screenshot artifact in an `<img>`.
 *
 * Public-repo screenshots already include a signed `artifactToken` query param
 * so we use the bridge-stored URL as-is. Private-repo screenshots have no
 * token, so the public proxy 404s on them — route through the authenticated
 * view endpoint instead.
 */
export function viewableScreenshotUrl(row: SessionArtifactRow): string {
  if (row.url?.includes(`${PUBLIC_ARTIFACT_TOKEN_QUERY_PARAM}=`)) {
    return row.url;
  }
  const filename = row.metadata?.filename ?? `artifact-${row.artifactId}`;
  return `/api/sessions/${row.sessionId}/artifacts/${row.artifactId}/view?filename=${encodeURIComponent(filename)}`;
}
