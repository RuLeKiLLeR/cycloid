import { tracedFetch } from "../observability/wrappers";
import { GITHUB_API } from "./pr";

const GITHUB_UPLOADS_API = "https://uploads.github.com";
const USER_AGENT = "Cycloid-Control-Plane";

export const GITHUB_EVIDENCE_RELEASE_TAG_PREFIX = "cycloid-evidence-";
export const GITHUB_EVIDENCE_RELEASE_NAME_PREFIX = "Cycloid visual evidence ";
export const GITHUB_EVIDENCE_RELEASE_MARKER = "<!-- cycloid:managed-release:v2 -->";
export const GITHUB_EVIDENCE_RELEASE_ASSET_LIMIT = 1000;

export interface GithubRelease {
  id: number;
  tagName: string;
  name: string | null;
  body: string | null;
}

export interface GithubReleaseAsset {
  id: number;
  name: string;
  size: number | null;
  state: string | null;
  digest: string | null;
  browserDownloadUrl: string;
}

export interface UploadGithubReleaseAssetParams {
  name: string;
  contentType: string;
  body: BodyInit | Uint8Array;
}

export type GithubReleaseApiError = Error & { githubStatus?: number };

function githubReleaseApiError(message: string, status: number): GithubReleaseApiError {
  const error = new Error(message) as GithubReleaseApiError;
  error.githubStatus = status;
  return error;
}

function githubJsonHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
}

function githubAssetUploadHeaders(token: string, contentType: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": contentType,
    "User-Agent": USER_AGENT,
  };
}

function managedReleaseBody(): string {
  return `${GITHUB_EVIDENCE_RELEASE_MARKER}

Cycloid manages this prerelease for visual evidence assets referenced by pull request bodies. The assets are customer-repo scoped GitHub release copies of Cycloid session artifacts.`;
}

function parseRelease(data: Record<string, unknown>): GithubRelease {
  return {
    id: typeof data.id === "number" ? data.id : 0,
    tagName: typeof data.tag_name === "string" ? data.tag_name : "",
    name: typeof data.name === "string" ? data.name : null,
    body: typeof data.body === "string" ? data.body : null,
  };
}

function parseReleaseAsset(data: Record<string, unknown>): GithubReleaseAsset {
  return {
    id: typeof data.id === "number" ? data.id : 0,
    name: typeof data.name === "string" ? data.name : "",
    size: typeof data.size === "number" ? data.size : null,
    state: typeof data.state === "string" ? data.state : null,
    digest: typeof data.digest === "string" ? data.digest : null,
    browserDownloadUrl: typeof data.browser_download_url === "string" ? data.browser_download_url : "",
  };
}

export function formatEvidenceReleaseBucket(bucketNumber: number): string {
  return String(bucketNumber).padStart(4, "0");
}

export function formatEvidenceReleaseTag(bucketNumber: number): string {
  return `${GITHUB_EVIDENCE_RELEASE_TAG_PREFIX}${formatEvidenceReleaseBucket(bucketNumber)}`;
}

export function formatEvidenceReleaseName(bucketNumber: number): string {
  return `${GITHUB_EVIDENCE_RELEASE_NAME_PREFIX}${formatEvidenceReleaseBucket(bucketNumber)}`;
}

export function parseEvidenceReleaseBucket(tagName: string): number | null {
  if (!tagName.startsWith(GITHUB_EVIDENCE_RELEASE_TAG_PREFIX)) return null;
  const bucket = tagName.slice(GITHUB_EVIDENCE_RELEASE_TAG_PREFIX.length);
  if (!/^\d{4}$/.test(bucket)) return null;
  const bucketNumber = Number(bucket);
  return Number.isSafeInteger(bucketNumber) && bucketNumber > 0 ? bucketNumber : null;
}

export function isManagedEvidenceRelease(release: GithubRelease): boolean {
  return release.body?.includes(GITHUB_EVIDENCE_RELEASE_MARKER) === true;
}

export function releaseNeedsUpdate(release: GithubRelease, bucketNumber: number): boolean {
  return release.name !== formatEvidenceReleaseName(bucketNumber) || !isManagedEvidenceRelease(release);
}

export async function listReleases(token: string, owner: string, repo: string): Promise<GithubRelease[]> {
  const releases: GithubRelease[] = [];
  let page = 1;

  while (true) {
    const response = await tracedFetch(
      `${GITHUB_API}/repos/${owner}/${repo}/releases?per_page=100&page=${page}`,
      { headers: githubJsonHeaders(token) },
      "github.release.list",
    );
    if (!response.ok) {
      const errorBody = await response.text();
      throw githubReleaseApiError(`GitHub releases lookup failed (${response.status}): ${errorBody}`, response.status);
    }

    const pageReleases = (await response.json()) as Array<Record<string, unknown>>;
    releases.push(...pageReleases.map(parseRelease));
    if (pageReleases.length < 100) break;
    page += 1;
  }

  return releases;
}

export async function getReleaseByTag(
  token: string,
  owner: string,
  repo: string,
  tagName: string,
): Promise<GithubRelease | null> {
  const response = await tracedFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tagName)}`,
    { headers: githubJsonHeaders(token) },
    "github.release.getByTag",
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    const errorBody = await response.text();
    throw githubReleaseApiError(`GitHub release lookup failed (${response.status}): ${errorBody}`, response.status);
  }
  return parseRelease((await response.json()) as Record<string, unknown>);
}

export async function getTagRefSha(
  token: string,
  owner: string,
  repo: string,
  tagName: string,
): Promise<string | null> {
  const response = await tracedFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tagName)}`,
    { headers: githubJsonHeaders(token) },
    "github.release.getTagRef",
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    const errorBody = await response.text();
    throw githubReleaseApiError(`GitHub tag ref lookup failed (${response.status}): ${errorBody}`, response.status);
  }
  const data = (await response.json()) as { object?: { sha?: unknown } };
  return typeof data.object?.sha === "string" ? data.object.sha : null;
}

export async function createManagedEvidenceRelease(
  token: string,
  owner: string,
  repo: string,
  defaultBranchSha: string,
  bucketNumber: number,
): Promise<GithubRelease> {
  const response = await tracedFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/releases`,
    {
      method: "POST",
      headers: githubJsonHeaders(token),
      body: JSON.stringify({
        tag_name: formatEvidenceReleaseTag(bucketNumber),
        target_commitish: defaultBranchSha,
        name: formatEvidenceReleaseName(bucketNumber),
        body: managedReleaseBody(),
        draft: false,
        prerelease: true,
        make_latest: "false",
      }),
    },
    "github.release.createManagedEvidence",
  );
  if (!response.ok) {
    const errorBody = await response.text();
    throw githubReleaseApiError(
      `GitHub managed release creation failed (${response.status}): ${errorBody}`,
      response.status,
    );
  }
  return parseRelease((await response.json()) as Record<string, unknown>);
}

export async function updateManagedEvidenceRelease(
  token: string,
  owner: string,
  repo: string,
  releaseId: number,
  bucketNumber: number,
): Promise<GithubRelease> {
  const response = await tracedFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/releases/${releaseId}`,
    {
      method: "PATCH",
      headers: githubJsonHeaders(token),
      body: JSON.stringify({
        name: formatEvidenceReleaseName(bucketNumber),
        body: managedReleaseBody(),
        draft: false,
        prerelease: true,
        make_latest: "false",
      }),
    },
    "github.release.updateManagedEvidence",
  );
  if (!response.ok) {
    const errorBody = await response.text();
    throw githubReleaseApiError(
      `GitHub managed release update failed (${response.status}): ${errorBody}`,
      response.status,
    );
  }
  return parseRelease((await response.json()) as Record<string, unknown>);
}

export async function listReleaseAssets(
  token: string,
  owner: string,
  repo: string,
  releaseId: number,
): Promise<GithubReleaseAsset[]> {
  const assets: GithubReleaseAsset[] = [];
  let page = 1;

  while (true) {
    const response = await tracedFetch(
      `${GITHUB_API}/repos/${owner}/${repo}/releases/${releaseId}/assets?per_page=100&page=${page}`,
      { headers: githubJsonHeaders(token) },
      "github.release.listAssets",
    );
    if (!response.ok) {
      const errorBody = await response.text();
      throw githubReleaseApiError(
        `GitHub release assets lookup failed (${response.status}): ${errorBody}`,
        response.status,
      );
    }

    const pageAssets = (await response.json()) as Array<Record<string, unknown>>;
    assets.push(...pageAssets.map(parseReleaseAsset));
    if (pageAssets.length < 100) break;
    page += 1;
  }

  return assets;
}

export async function uploadReleaseAsset(
  token: string,
  owner: string,
  repo: string,
  releaseId: number,
  asset: UploadGithubReleaseAssetParams,
): Promise<GithubReleaseAsset> {
  const url = new URL(`${GITHUB_UPLOADS_API}/repos/${owner}/${repo}/releases/${releaseId}/assets`);
  url.searchParams.set("name", asset.name);
  const response = await tracedFetch(
    url.toString(),
    {
      method: "POST",
      headers: githubAssetUploadHeaders(token, asset.contentType),
      body: asset.body as BodyInit,
    },
    "github.release.uploadAsset",
  );
  if (!response.ok) {
    const errorBody = await response.text();
    throw githubReleaseApiError(
      `GitHub release asset upload failed (${response.status}): ${errorBody}`,
      response.status,
    );
  }
  return parseReleaseAsset((await response.json()) as Record<string, unknown>);
}

export async function deleteReleaseAsset(token: string, owner: string, repo: string, assetId: number): Promise<void> {
  const response = await tracedFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/releases/assets/${assetId}`,
    {
      method: "DELETE",
      headers: githubJsonHeaders(token),
    },
    "github.release.deleteAsset",
  );
  if (!response.ok && response.status !== 404) {
    const errorBody = await response.text();
    throw githubReleaseApiError(
      `GitHub release asset deletion failed (${response.status}): ${errorBody}`,
      response.status,
    );
  }
}
