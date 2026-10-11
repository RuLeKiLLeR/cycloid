import { WEBM_VIDEO_MIME_TYPE } from "../../../../shared/constants/artifacts.js";
import { createSignedToken, verifySignedToken } from "../signed-token";

const ALLOWED_ARTIFACT_CONTENT_TYPES = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);
const ALLOWED_REPORT_CONTENT_TYPES = new Set(["text/html"]);
const ALLOWED_LOG_CONTENT_TYPES = new Set([
  "application/json",
  "application/x-ndjson",
  "text/markdown",
  "text/plain",
  "text/xml",
]);

const ARTIFACT_CONTENT_TYPE_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
};

export const SAFE_FALLBACK_ARTIFACT_CONTENT_TYPE = "application/octet-stream";
export const PUBLIC_ARTIFACT_TOKEN_QUERY_PARAM = "artifactToken";
export const PUBLIC_ARTIFACT_CACHE_CONTROL = "public, max-age=300";
export const PUBLIC_ARTIFACT_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type ArtifactAccessVisibility = "private" | "public";

export interface ArtifactAccessMetadata {
  visibility: ArtifactAccessVisibility;
  expiresAt: number | null;
  revokedAt: number | null;
}

export function normalizeArtifactContentType(value: string | null | undefined, artifactType: string): string | null {
  if (!value) return null;
  const rawMime = value.split(";")[0]?.trim().toLowerCase();
  if (!rawMime) return null;
  const mime = ARTIFACT_CONTENT_TYPE_ALIASES[rawMime] ?? rawMime;
  if (artifactType === "video") return mime === WEBM_VIDEO_MIME_TYPE ? WEBM_VIDEO_MIME_TYPE : null;
  if (artifactType === "report") return ALLOWED_REPORT_CONTENT_TYPES.has(mime) ? mime : null;
  if (artifactType === "log") return ALLOWED_LOG_CONTENT_TYPES.has(mime) ? mime : null;
  if (mime === WEBM_VIDEO_MIME_TYPE) return null;
  return ALLOWED_ARTIFACT_CONTENT_TYPES.has(mime) ? mime : null;
}

export function decodeArtifactPathSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Artifact filenames must remain a single path segment end-to-end.
 *
 * Allowing separators or bare dot-segments lets callers smuggle traversal into
 * internal DO paths and S3 object URLs.
 */
export function normalizeRequestedArtifactFilename(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value === "." || value === "..") return null;
  if (value.includes("/") || value.includes("\\")) return null;
  return value;
}

/**
 * Decide an artifact's access metadata at upload time.
 *
 * Default visibility is "private" (URL requires the user's session cookie and
 * access to the parent session). Screenshots and videos from sessions targeting a
 * **public** repo get the "public" treatment — a signed URL with TTL — so the
 * agent can drop the link into a PR / Slack message. For private repos, we
 * never issue public signed URLs because a leaked URL would expose the
 * customer's authenticated UI. `repoPrivate === null` (not yet resolved) is
 * treated as private to fail safe.
 */
export function createArtifactAccessMetadata(
  artifactType: string,
  repoPrivate: boolean | null | undefined,
  now = Date.now(),
  options: { forcePrivate?: boolean } = {},
): ArtifactAccessMetadata {
  if (options.forcePrivate) {
    return {
      visibility: "private",
      expiresAt: null,
      revokedAt: null,
    };
  }

  if ((artifactType === "screenshot" || artifactType === "video") && repoPrivate === false) {
    return {
      visibility: "public",
      expiresAt: now + PUBLIC_ARTIFACT_URL_TTL_MS,
      revokedAt: null,
    };
  }

  return {
    visibility: "private",
    expiresAt: null,
    revokedAt: null,
  };
}

export function isPrSafeArtifactType(artifactType: string): boolean {
  return artifactType === "screenshot" || artifactType === "video";
}

export function isAuthedReadableArtifactType(artifactType: string): boolean {
  return isPrSafeArtifactType(artifactType) || artifactType === "report" || artifactType === "log";
}

export function parseArtifactAccessMetadata(
  metadata: Record<string, unknown> | null | undefined,
): ArtifactAccessMetadata {
  const rawAccess = metadata?.access;
  if (!rawAccess || typeof rawAccess !== "object" || Array.isArray(rawAccess)) {
    return { visibility: "private", expiresAt: null, revokedAt: null };
  }

  const access = rawAccess as Record<string, unknown>;
  const visibility = access.visibility === "public" ? "public" : "private";
  const expiresAt = typeof access.expiresAt === "number" && Number.isFinite(access.expiresAt) ? access.expiresAt : null;
  const revokedAt = typeof access.revokedAt === "number" && Number.isFinite(access.revokedAt) ? access.revokedAt : null;

  if (visibility === "public" && expiresAt === null) {
    return { visibility: "private", expiresAt: null, revokedAt };
  }

  return { visibility, expiresAt, revokedAt };
}

export function canServePublicArtifact(access: ArtifactAccessMetadata, now = Date.now()): boolean {
  if (access.visibility !== "public") return false;
  if (access.revokedAt !== null) return false;
  if (access.expiresAt === null || access.expiresAt <= now) return false;
  return true;
}

interface ArtifactTokenPayload {
  sessionId: string;
  artifactId: string;
  filename: string;
  expiresAt: number;
}

const artifactTokenCodec = {
  encode(payload: ArtifactTokenPayload): string {
    return `${payload.sessionId}:${payload.artifactId}:${payload.filename}:${payload.expiresAt}`;
  },
  decode(raw: string): ArtifactTokenPayload | null {
    const parts = raw.split(":");
    if (parts.length !== 4) return null;
    const [sessionId, artifactId, filename, rawExpiresAt] = parts;
    const expiresAt = Number(rawExpiresAt);
    if (!Number.isFinite(expiresAt)) return null;
    return { sessionId, artifactId, filename, expiresAt };
  },
};

async function generateArtifactAccessToken(args: ArtifactTokenPayload, secret: string): Promise<string> {
  return createSignedToken(args, secret, artifactTokenCodec);
}

export async function verifyArtifactAccessToken(
  args: {
    sessionId: string;
    artifactId: string;
    filename: string;
  },
  token: string,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  const payload = await verifySignedToken(token, secret, artifactTokenCodec);
  if (!payload) return false;
  if (
    payload.sessionId !== args.sessionId ||
    payload.artifactId !== args.artifactId ||
    payload.filename !== args.filename
  ) {
    return false;
  }
  if (payload.expiresAt <= now) return false;
  return true;
}

export async function buildPublicArtifactUrl(
  baseUrl: string,
  args: {
    sessionId: string;
    artifactId: string;
    filename: string;
    expiresAt: number;
  },
  secret: string,
): Promise<string> {
  const url = new URL(
    `/api/sessions/${args.sessionId}/artifacts/${args.artifactId}/${encodeURIComponent(args.filename)}`,
    baseUrl,
  );
  const token = await generateArtifactAccessToken(args, secret);
  url.searchParams.set(PUBLIC_ARTIFACT_TOKEN_QUERY_PARAM, token);
  return url.toString();
}
