import {
  classifyDesktopPrEvidencePath,
  type DesktopPrEvidenceDescriptor,
  shouldExcludeUnsafeDesktopEvidencePath,
} from "../../../../shared/desktop-evidence.js";
import type { VerificationArtifact } from "../../../../shared/types/sandbox.js";
import { createInstallationToken } from "../github/octokit";
import { getBranchHeadSha, getDefaultBranch, updatePullRequest } from "../github/pr";
import {
  createManagedEvidenceRelease,
  deleteReleaseAsset,
  formatEvidenceReleaseTag,
  getReleaseByTag,
  getTagRefSha,
  GITHUB_EVIDENCE_RELEASE_ASSET_LIMIT,
  type GithubRelease,
  type GithubReleaseApiError,
  type GithubReleaseAsset,
  isManagedEvidenceRelease,
  listReleaseAssets,
  listReleases,
  parseEvidenceReleaseBucket,
  releaseNeedsUpdate,
  updateManagedEvidenceRelease,
  uploadReleaseAsset,
} from "../github/releases";
import type { Logger } from "../logger";
import { getFileContent, listDirectoryContents } from "../memory/github";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { storePrBodyRegionAndReconcile } from "../services/pr-body-reconciler";
import type { Env } from "../types";
import { normalizeArtifactContentType } from "./artifacts";
import * as doDb from "./do-db.js";
import { SESSION_INTERNAL_ORIGIN } from "./internal-routes";
import {
  type GithubReleaseVisualEvidenceAsset,
  renderCycloidVisualEvidenceFallbackSection,
  renderGithubReleaseVisualEvidenceSection,
  upsertVisualEvidenceSection,
} from "./pr-body.js";
import { LATEST_PR_BODY_STORAGE_KEY } from "./pr-body-assembler.js";
import type { ResolvedPrRepoAuth } from "./pr-github-ops.js";

const MAX_GITHUB_RELEASE_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

const IMAGE_CONTENT_TYPE_TO_EXT: Record<string, string> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const VIDEO_CONTENT_TYPE_TO_EXT: Record<string, string> = {
  "video/webm": "webm",
};

type EvidenceFallbackReason =
  | "no_pr_target"
  | "no_visual_artifacts"
  | "github_token_missing"
  | "contents_write_missing"
  | "pull_requests_write_missing"
  | "unmanaged_release_conflict"
  | "tag_conflict"
  | "workflow_risk_detected"
  | "release_create_failed"
  | "release_asset_list_failed"
  | "asset_upload_failed"
  | "asset_duplicate_conflict"
  | "artifact_fetch_failed"
  | "unsupported_artifact_type"
  | "pr_body_patch_failed"
  | "pr_body_rejected"
  | "github_rate_limited";

type EvidenceLogFields = {
  businessId: string | null;
  sessionId: string | null;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  bucketNumber?: number;
  releaseId?: number;
  releaseTag?: string;
  assetId?: number;
  artifactId?: string;
  githubStatus?: number;
  operation?: string;
  totalReleaseCount?: number;
  managedReleaseCount?: number;
  visualArtifactCount?: number;
  preparedArtifactCount?: number;
  fallbackArtifactCount?: number;
  publishedArtifactCount?: number;
};

type VisualArtifactType = "screenshot" | "video";

type VisualArtifactRow = doDb.SessionArtifactRow & {
  type: VisualArtifactType;
  filename: string;
  label: string;
  originalUrl: string;
  desktopEvidence: DesktopPrEvidenceDescriptor | null;
};

type PreparedVisualArtifact = {
  artifactId: string;
  type: VisualArtifactType;
  label: string;
  desktopEvidence: DesktopPrEvidenceDescriptor | null;
  contentType: string;
  byteLength: number;
  sha256: string;
  assetName: string;
  openUploadBody(): Promise<BodyInit | Uint8Array>;
};

type PreparedVisualArtifactsResult = {
  artifacts: PreparedVisualArtifact[];
  fallbackReason: EvidenceFallbackReason | null;
  fallbackArtifacts: VerificationArtifact[];
};

type PreparedArtifactBody =
  | { kind: "buffer"; byteLength: number; sha256: string; uploadBody: Uint8Array }
  | { kind: "stream"; byteLength: number; sha256: string };

type ReleaseBucket = {
  bucketNumber: number;
  release: GithubRelease;
  assets: GithubReleaseAsset[];
};

type UploadAssetResult = {
  asset: GithubReleaseAsset;
  release: GithubRelease;
  uploaded: boolean;
};

type EvidenceError = Error & {
  reason?: EvidenceFallbackReason;
  githubStatus?: number;
};

interface GithubReleaseEvidenceHost {
  readonly env: Env;
  readonly log: Logger;
  readonly state?: DurableObjectState;
  waitUntil?(promise: Promise<unknown>): void;
  fetchInternal(request: Request): Promise<Response>;
}

export function hasObviousReleaseOrTagWorkflowTrigger(workflowContent: string): boolean {
  const lines = workflowContent.split(/\r?\n/).map(stripYamlLineComment);

  for (let index = 0; index < lines.length; index += 1) {
    const entry = parseYamlKeyLine(lines[index]);
    if (!entry || entry.indent !== 0 || entry.key !== "on") continue;

    if (entry.value) {
      if (/\brelease\b/i.test(entry.value)) return true;
      if (/\bpush\b/i.test(entry.value) && /\btags(?:-ignore)?\b/i.test(entry.value)) return true;
      continue;
    }

    let directChildIndent: number | null = null;
    for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
      const line = lines[childIndex];
      if (!line.trim()) continue;

      const child = parseYamlKeyLine(line);
      if (child && child.indent === 0) break;
      const sequence = parseYamlSequenceScalar(line);
      const lineIndent = child?.indent ?? sequence?.indent ?? null;
      if (lineIndent === null) continue;
      directChildIndent = directChildIndent ?? lineIndent;

      if (sequence?.indent === directChildIndent && sequence.value === "release") return true;
      if (sequence?.indent === directChildIndent && sequence.value === "push") {
        if (onPushBlockHasTagTrigger(lines, childIndex, sequence.indent)) return true;
      }
      if (!child || child.indent !== directChildIndent) continue;

      if (child.key === "release") return true;
      if (child.key === "push" && onPushBlockHasTagTrigger(lines, childIndex, child.indent)) return true;
    }
  }

  return false;
}

function stripYamlLineComment(line: string): string {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === "'" || char === '"') && line[index - 1] !== "\\") {
      quote = quote === char ? null : (quote ?? char);
      continue;
    }
    if (char === "#" && !quote && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseYamlKeyLine(line: string): { indent: number; key: string; value: string } | null {
  const match = line.match(/^(\s*)(["']?[A-Za-z0-9_.-]+["']?)\s*:\s*(.*)$/);
  if (!match) return null;
  return {
    indent: match[1].length,
    key: match[2].replace(/^["']|["']$/g, "").toLowerCase(),
    value: match[3].trim(),
  };
}

function parseYamlSequenceScalar(line: string): { indent: number; value: string } | null {
  const match = line.match(/^(\s*)-\s*(["']?[A-Za-z0-9_.-]+["']?)\s*:?\s*$/);
  if (!match) return null;
  return {
    indent: match[1].length,
    value: match[2].replace(/^["']|["']$/g, "").toLowerCase(),
  };
}

function onPushBlockHasTagTrigger(lines: string[], pushIndex: number, pushIndent: number): boolean {
  const pushEntry = parseYamlKeyLine(lines[pushIndex]);
  if (pushEntry?.value && /\btags(?:-ignore)?\b/i.test(pushEntry.value)) return true;

  for (let index = pushIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const entry = parseYamlKeyLine(line);
    const sequence = parseYamlSequenceScalar(line);
    if (sequence && sequence.indent <= pushIndent) break;
    if (entry && entry.indent <= pushIndent) break;
    if (entry && /^tags(?:-ignore)?$/.test(entry.key)) return true;
  }
  return false;
}

function githubStatus(error: unknown): number | undefined {
  const explicitStatus = (error as GithubReleaseApiError | EvidenceError | undefined)?.githubStatus;
  if (typeof explicitStatus === "number") return explicitStatus;
  const match = String(error).match(/\((\d{3})\)/);
  return match ? Number(match[1]) : undefined;
}

function evidenceError(reason: EvidenceFallbackReason, message: string, error?: unknown): EvidenceError {
  const next = new Error(message) as EvidenceError;
  next.reason = reason;
  next.githubStatus = githubStatus(error);
  return next;
}

function fallbackReason(error: unknown, defaultReason: EvidenceFallbackReason): EvidenceFallbackReason {
  const reason = (error as EvidenceError | undefined)?.reason;
  if (reason) return reason;
  const status = githubStatus(error);
  if (status === 429) return "github_rate_limited";
  return defaultReason;
}

function logInfo(log: Logger, event: string, fields: EvidenceLogFields): void {
  log.info({ event, ...fields }, event);
}

function logWarn(log: Logger, event: string, fields: EvidenceLogFields, error?: unknown): void {
  log.warn(
    {
      event,
      ...fields,
      githubStatus: fields.githubStatus ?? githubStatus(error),
      errorMessage: error ? String(error) : undefined,
    },
    event,
  );
}

function postEvidenceEvent(
  host: GithubReleaseEvidenceHost,
  event: string,
  fields: EvidenceLogFields,
  error?: unknown,
): void {
  const payload = {
    event,
    ...fields,
    githubStatus: fields.githubStatus ?? githubStatus(error),
    errorKind: error ? "github_release_error" : undefined,
  };
  const postPromise = postStructuredEventToDd(host.env, payload).catch((postError) => {
    host.log.warn(
      {
        event: "github_evidence.observability.post_failed",
        sourceEvent: event,
        sessionId: fields.sessionId,
        repoOwner: fields.repoOwner,
        repoName: fields.repoName,
        prNumber: fields.prNumber,
        errorMessage: String(postError),
      },
      "Failed to post GitHub evidence observability event",
    );
  });
  if (host.waitUntil) {
    host.waitUntil(postPromise);
  } else {
    void postPromise;
  }
}

function safeIdFragment(value: string): string {
  const fragment = value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
  return fragment.padEnd(8, "0");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
] as const;

function rotr32(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

class StreamingSha256 {
  private readonly block = new Uint8Array(64);
  private readonly words = new Uint32Array(64);
  private blockLength = 0;
  private bytesHashed = 0;
  private h0 = 0x6a09e667;
  private h1 = 0xbb67ae85;
  private h2 = 0x3c6ef372;
  private h3 = 0xa54ff53a;
  private h4 = 0x510e527f;
  private h5 = 0x9b05688c;
  private h6 = 0x1f83d9ab;
  private h7 = 0x5be0cd19;

  update(chunk: Uint8Array): void {
    let offset = 0;
    this.bytesHashed += chunk.byteLength;

    if (this.blockLength > 0) {
      const needed = 64 - this.blockLength;
      const copied = Math.min(needed, chunk.byteLength);
      this.block.set(chunk.subarray(0, copied), this.blockLength);
      this.blockLength += copied;
      offset += copied;
      if (this.blockLength === 64) {
        this.processBlock(this.block, 0);
        this.blockLength = 0;
      }
    }

    while (offset + 64 <= chunk.byteLength) {
      this.processBlock(chunk, offset);
      offset += 64;
    }

    if (offset < chunk.byteLength) {
      this.block.set(chunk.subarray(offset), 0);
      this.blockLength = chunk.byteLength - offset;
    }
  }

  digestHex(): string {
    const bitLengthHigh = Math.floor(this.bytesHashed / 0x20000000);
    const bitLengthLow = (this.bytesHashed << 3) >>> 0;
    const paddingLength = this.blockLength < 56 ? 56 - this.blockLength : 120 - this.blockLength;
    const padding = new Uint8Array(paddingLength + 8);
    padding[0] = 0x80;
    const view = new DataView(padding.buffer);
    view.setUint32(paddingLength, bitLengthHigh);
    view.setUint32(paddingLength + 4, bitLengthLow);
    this.update(padding);

    const output = new Uint8Array(32);
    const outputView = new DataView(output.buffer);
    [this.h0, this.h1, this.h2, this.h3, this.h4, this.h5, this.h6, this.h7].forEach((word, index) => {
      outputView.setUint32(index * 4, word);
    });
    return Array.from(output, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private processBlock(chunk: Uint8Array, offset: number): void {
    for (let index = 0; index < 16; index += 1) {
      const cursor = offset + index * 4;
      this.words[index] =
        ((chunk[cursor] << 24) | (chunk[cursor + 1] << 16) | (chunk[cursor + 2] << 8) | chunk[cursor + 3]) >>> 0;
    }

    for (let index = 16; index < 64; index += 1) {
      const s0 =
        rotr32(this.words[index - 15], 7) ^ rotr32(this.words[index - 15], 18) ^ (this.words[index - 15] >>> 3);
      const s1 = rotr32(this.words[index - 2], 17) ^ rotr32(this.words[index - 2], 19) ^ (this.words[index - 2] >>> 10);
      this.words[index] = (this.words[index - 16] + s0 + this.words[index - 7] + s1) >>> 0;
    }

    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;
    let f = this.h5;
    let g = this.h6;
    let h = this.h7;

    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[index] + this.words[index]) >>> 0;
      const s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.h0 = (this.h0 + a) >>> 0;
    this.h1 = (this.h1 + b) >>> 0;
    this.h2 = (this.h2 + c) >>> 0;
    this.h3 = (this.h3 + d) >>> 0;
    this.h4 = (this.h4 + e) >>> 0;
    this.h5 = (this.h5 + f) >>> 0;
    this.h6 = (this.h6 + g) >>> 0;
    this.h7 = (this.h7 + h) >>> 0;
  }
}

async function sha256HexFromStream(
  stream: ReadableStream<Uint8Array>,
): Promise<{ sha256: string; byteLength: number }> {
  const hasher = new StreamingSha256();
  let byteLength = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      byteLength += chunk.byteLength;
      hasher.update(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return { sha256: hasher.digestHex(), byteLength };
}

function metadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function filenameFromArtifactUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split("/");
    const artifactsIndex = parts.findIndex((part) => part === "artifacts");
    if (artifactsIndex === -1 || parts.length <= artifactsIndex + 2) return null;
    const encoded = parts.slice(artifactsIndex + 2).join("/");
    const decoded = decodeURIComponent(encoded);
    return decoded.trim() ? decoded : null;
  } catch {
    return null;
  }
}

function visualArtifactType(type: string): VisualArtifactType | null {
  if (type === "screenshot" || type === "video") return type;
  return null;
}

function extensionForContentType(type: VisualArtifactType, contentType: string): string | null {
  return type === "screenshot"
    ? (IMAGE_CONTENT_TYPE_TO_EXT[contentType] ?? null)
    : (VIDEO_CONTENT_TYPE_TO_EXT[contentType] ?? null);
}

function assetNameForVisualArtifact(args: {
  sessionId: string;
  prNumber: number;
  artifactId: string;
  sha256: string;
  ext: string;
}): string {
  return `pr-${args.prNumber}-sess-${safeIdFragment(args.sessionId)}-art-${safeIdFragment(args.artifactId)}-${args.sha256.slice(0, 12)}.${args.ext}`;
}

function sameAsset(asset: GithubReleaseAsset, selected: PreparedVisualArtifact): boolean {
  if (asset.state === "starter") return false;
  const sizeMatches = asset.size === null || asset.size === selected.byteLength;
  const digestMatches = asset.digest === null || asset.digest === `sha256:${selected.sha256}`;
  return sizeMatches && digestMatches;
}

function toFallbackArtifacts(rows: VisualArtifactRow[]): VerificationArtifact[] {
  return rows.map((row) => ({
    type: row.type,
    label: row.label,
    url: row.originalUrl,
    renderMode: "link",
  }));
}

async function resolveEvidenceToken(env: Env, auth: ResolvedPrRepoAuth): Promise<string | null> {
  if (auth.tokenSource === "installation") return auth.token;
  if (auth.installationToken) return auth.installationToken;
  if (auth.installationId) {
    try {
      return await createInstallationToken(env, auth.installationId);
    } catch {
      return auth.token || null;
    }
  }
  return auth.token || null;
}

const WORKFLOW_CONTENT_FETCH_CONCURRENCY = 10;

async function repoHasWorkflowRisk(token: string, owner: string, repo: string, ref: string): Promise<boolean> {
  const entries = await listDirectoryContents(token, owner, repo, ".github/workflows", ref);
  const workflowFiles = entries.filter((entry) => entry.type === "file" && /\.(?:ya?ml)$/i.test(entry.path));
  // Fetch in bounded waves and stop scheduling once a risky workflow is found.
  for (let index = 0; index < workflowFiles.length; index += WORKFLOW_CONTENT_FETCH_CONCURRENCY) {
    const wave = workflowFiles.slice(index, index + WORKFLOW_CONTENT_FETCH_CONCURRENCY);
    const contents = await Promise.all(wave.map((file) => getFileContent(token, owner, repo, file.path, ref)));
    if (contents.some((content) => content && hasObviousReleaseOrTagWorkflowTrigger(content))) return true;
  }
  return false;
}

export class GithubReleaseEvidenceService {
  constructor(
    private readonly sql: SqlStorage,
    private readonly host: GithubReleaseEvidenceHost,
  ) {}

  async publishForPr(args: {
    sessionId: string;
    auth: ResolvedPrRepoAuth;
    prNumber: number;
    body: string;
  }): Promise<void> {
    const session = doDb.getSession(this.sql, args.sessionId);
    const ext = doDb.getSessionExtended(this.sql, args.sessionId);
    const repoOwner = args.auth.repoOwner;
    const repoName = args.auth.repoName;
    const fields = {
      businessId: session?.businessId ?? null,
      sessionId: args.sessionId,
      repoOwner,
      repoName,
      prNumber: args.prNumber,
    };

    if (!session || !ext || ext.repoOwner !== repoOwner || ext.repoName !== repoName) {
      this.fallback(fields, "no_pr_target");
      return;
    }

    const visualRows = this.listVisualArtifacts(args.sessionId);
    if (visualRows.length === 0) {
      this.fallback(fields, "no_visual_artifacts");
      return;
    }
    const fallbackArtifacts = toFallbackArtifacts(visualRows);

    const token = await resolveEvidenceToken(this.host.env, args.auth);
    if (!token) {
      this.fallback(fields, "github_token_missing");
      return;
    }

    const newlyUploadedAssetIds: Array<{ assetId: number; releaseId: number }> = [];

    try {
      const prepared = await this.prepareVisualArtifacts(args.sessionId, args.prNumber, visualRows, fields);
      if (prepared.artifacts.length === 0) {
        await this.patchFallbackBody(
          token,
          args,
          prepared.fallbackArtifacts.length > 0 ? prepared.fallbackArtifacts : fallbackArtifacts,
          fields,
          prepared.fallbackReason ?? "unsupported_artifact_type",
        );
        return;
      }
      if (prepared.fallbackReason) this.fallback(fields, prepared.fallbackReason);

      const buckets = await this.ensureManagedBuckets(token, args.auth, fields);
      const renderedAssets: GithubReleaseVisualEvidenceAsset[] = [];

      for (const artifact of prepared.artifacts) {
        try {
          const result = await this.uploadOrReuseAsset(token, args.auth, buckets, artifact, fields);
          if (result.uploaded) {
            newlyUploadedAssetIds.push({ assetId: result.asset.id, releaseId: result.release.id });
          }
          renderedAssets.push({
            type: artifact.type,
            label: artifact.label,
            desktopEvidence: artifact.desktopEvidence,
            browserDownloadUrl: result.asset.browserDownloadUrl,
          });
        } catch (error) {
          logWarn(
            this.host.log,
            "github_evidence.asset.upload.failed",
            { ...fields, artifactId: artifact.artifactId, githubStatus: githubStatus(error) },
            error,
          );
          throw error;
        }
      }

      await this.patchPrVisualEvidenceSection(
        token,
        args,
        renderGithubReleaseVisualEvidenceSection(renderedAssets, prepared.fallbackArtifacts),
        fields,
      );
      logInfo(this.host.log, "github_evidence.pr_body.update.succeeded", fields);
    } catch (error) {
      await this.deleteUnreferencedUploadedAssets(token, args.auth, newlyUploadedAssetIds, fields);
      const reason = fallbackReason(error, "asset_upload_failed");
      await this.patchFallbackBody(token, args, fallbackArtifacts, fields, reason);
    }
  }

  async publishArtifactsForVerificationComment(args: {
    sessionId: string;
    auth: ResolvedPrRepoAuth;
    prNumber: number;
  }): Promise<VerificationArtifact[]> {
    const session = doDb.getSession(this.sql, args.sessionId);
    const ext = doDb.getSessionExtended(this.sql, args.sessionId);
    const repoOwner = args.auth.repoOwner;
    const repoName = args.auth.repoName;
    const fields = {
      businessId: session?.businessId ?? null,
      sessionId: args.sessionId,
      repoOwner,
      repoName,
      prNumber: args.prNumber,
    };

    if (!session || !ext || ext.repoOwner !== repoOwner || ext.repoName !== repoName) {
      this.fallback(fields, "no_pr_target");
      return [];
    }

    const visualRows = this.listVisualArtifacts(args.sessionId);
    if (visualRows.length === 0) {
      this.fallback(fields, "no_visual_artifacts");
      return [];
    }

    const token = await resolveEvidenceToken(this.host.env, args.auth);
    if (!token) {
      this.fallback(fields, "github_token_missing");
      return [];
    }

    const newlyUploadedAssetIds: Array<{ assetId: number; releaseId: number }> = [];
    let preparedArtifactCount = 0;
    let fallbackArtifactCount = 0;

    try {
      const prepared = await this.prepareVisualArtifacts(args.sessionId, args.prNumber, visualRows, fields);
      preparedArtifactCount = prepared.artifacts.length;
      fallbackArtifactCount = prepared.fallbackArtifacts.length;
      if (prepared.artifacts.length === 0) {
        const reason = prepared.fallbackReason ?? "unsupported_artifact_type";
        logWarn(this.host.log, "github_evidence.verification_comment_assets.fallback", {
          ...fields,
          operation: reason,
          visualArtifactCount: visualRows.length,
          preparedArtifactCount,
          fallbackArtifactCount,
        });
        this.fallback(fields, reason);
        return prepared.fallbackArtifacts.length > 0 ? prepared.fallbackArtifacts : toFallbackArtifacts(visualRows);
      }
      if (prepared.fallbackReason) {
        logWarn(this.host.log, "github_evidence.verification_comment_assets.fallback", {
          ...fields,
          operation: prepared.fallbackReason,
          visualArtifactCount: visualRows.length,
          preparedArtifactCount,
          fallbackArtifactCount,
        });
        this.fallback(fields, prepared.fallbackReason);
      }

      const buckets = await this.ensureManagedBuckets(token, args.auth, fields);
      const releaseArtifacts: VerificationArtifact[] = [];

      for (const artifact of prepared.artifacts) {
        try {
          const result = await this.uploadOrReuseAsset(token, args.auth, buckets, artifact, fields);
          if (result.uploaded) {
            newlyUploadedAssetIds.push({ assetId: result.asset.id, releaseId: result.release.id });
          }
          releaseArtifacts.push({
            type: artifact.type,
            label: artifact.label,
            url: result.asset.browserDownloadUrl,
          });
        } catch (error) {
          logWarn(
            this.host.log,
            "github_evidence.asset.upload.failed",
            { ...fields, artifactId: artifact.artifactId, githubStatus: githubStatus(error) },
            error,
          );
          throw error;
        }
      }

      const artifacts = [...releaseArtifacts, ...prepared.fallbackArtifacts];

      logInfo(this.host.log, "github_evidence.verification_comment_assets.succeeded", {
        ...fields,
        visualArtifactCount: visualRows.length,
        preparedArtifactCount,
        fallbackArtifactCount,
        publishedArtifactCount: releaseArtifacts.length,
      });
      return artifacts;
    } catch (error) {
      await this.deleteUnreferencedUploadedAssets(token, args.auth, newlyUploadedAssetIds, fields);
      const reason = fallbackReason(error, "asset_upload_failed");
      const fallbackArtifacts = toFallbackArtifacts(visualRows);
      logWarn(
        this.host.log,
        "github_evidence.verification_comment_assets.fallback",
        {
          ...fields,
          operation: reason,
          visualArtifactCount: visualRows.length,
          preparedArtifactCount,
          fallbackArtifactCount,
        },
        error,
      );
      this.fallback(fields, reason);
      return fallbackArtifacts;
    }
  }

  private listVisualArtifacts(sessionId: string): VisualArtifactRow[] {
    const rows = doDb.listSessionArtifacts(this.sql, sessionId).flatMap((artifact): VisualArtifactRow[] => {
      if (artifact.metadata?.kind === "desktop_action_screenshot") return [];
      const type = visualArtifactType(artifact.type);
      const originalUrl = artifact.url?.trim();
      if (!type || !originalUrl) return [];
      const filename = metadataString(artifact.metadata, "filename") ?? filenameFromArtifactUrl(originalUrl);
      if (!filename) return [];
      if (shouldExcludeUnsafeDesktopEvidencePath(filename)) return [];
      const label = metadataString(artifact.metadata, "label") ?? filename;
      return [
        { ...artifact, type, filename, label, originalUrl, desktopEvidence: classifyDesktopPrEvidencePath(filename) },
      ];
    });
    return rows;
  }

  private async prepareVisualArtifacts(
    sessionId: string,
    prNumber: number,
    artifacts: VisualArtifactRow[],
    fields: EvidenceLogFields,
  ): Promise<PreparedVisualArtifactsResult> {
    const prepared: PreparedVisualArtifact[] = [];
    const fallbackArtifacts: VerificationArtifact[] = [];
    let fallbackReason: EvidenceFallbackReason | null = null;

    for (const artifact of artifacts) {
      const response = await this.host.fetchInternal(
        new Request(
          `${SESSION_INTERNAL_ORIGIN}/session/artifacts/view/${artifact.artifactId}/${encodeURIComponent(artifact.filename)}`,
        ),
      );
      if (!response.ok) {
        fallbackReason = fallbackReason ?? "artifact_fetch_failed";
        fallbackArtifacts.push(...toFallbackArtifacts([artifact]));
        logWarn(this.host.log, "github_evidence.asset.upload.failed", {
          ...fields,
          artifactId: artifact.artifactId,
          githubStatus: response.status,
          operation: "artifact_fetch_failed",
        });
        continue;
      }

      const contentType = normalizeArtifactContentType(response.headers.get("content-type"), artifact.type);
      const ext = contentType ? extensionForContentType(artifact.type, contentType) : null;
      if (!contentType || !ext) {
        fallbackReason = fallbackReason ?? "unsupported_artifact_type";
        fallbackArtifacts.push(...toFallbackArtifacts([artifact]));
        this.fallback({ ...fields, artifactId: artifact.artifactId }, "unsupported_artifact_type");
        continue;
      }

      const body =
        artifact.type === "screenshot"
          ? await this.prepareScreenshotBody(response)
          : await this.prepareVideoBody(response);
      if (!body) {
        fallbackReason = fallbackReason ?? "artifact_fetch_failed";
        fallbackArtifacts.push(...toFallbackArtifacts([artifact]));
        logWarn(this.host.log, "github_evidence.asset.upload.failed", {
          ...fields,
          artifactId: artifact.artifactId,
          operation: "artifact_fetch_failed",
        });
        continue;
      }

      if (body.byteLength > MAX_GITHUB_RELEASE_ASSET_BYTES) {
        fallbackReason = fallbackReason ?? "unsupported_artifact_type";
        fallbackArtifacts.push(...toFallbackArtifacts([artifact]));
        this.fallback({ ...fields, artifactId: artifact.artifactId }, "unsupported_artifact_type");
        continue;
      }

      const openUploadBody: () => Promise<BodyInit | Uint8Array> =
        body.kind === "buffer"
          ? async () => body.uploadBody
          : () => this.openArtifactUploadStream(artifact, contentType);

      prepared.push({
        artifactId: artifact.artifactId,
        type: artifact.type,
        label: artifact.label,
        desktopEvidence: artifact.desktopEvidence,
        contentType,
        byteLength: body.byteLength,
        sha256: body.sha256,
        assetName: assetNameForVisualArtifact({
          sessionId,
          prNumber,
          artifactId: artifact.artifactId,
          sha256: body.sha256,
          ext,
        }),
        openUploadBody,
      });
    }

    return { artifacts: prepared, fallbackReason, fallbackArtifacts };
  }

  private async prepareScreenshotBody(response: Response): Promise<PreparedArtifactBody | null> {
    const uploadBody = new Uint8Array(await response.arrayBuffer());
    return {
      kind: "buffer",
      byteLength: uploadBody.byteLength,
      sha256: await sha256Hex(uploadBody),
      uploadBody,
    };
  }

  private async prepareVideoBody(response: Response): Promise<PreparedArtifactBody | null> {
    if (!response.body) return null;
    return { kind: "stream", ...(await sha256HexFromStream(response.body)) };
  }

  private async openArtifactUploadStream(artifact: VisualArtifactRow, expectedContentType: string): Promise<BodyInit> {
    const response = await this.host.fetchInternal(
      new Request(
        `${SESSION_INTERNAL_ORIGIN}/session/artifacts/view/${artifact.artifactId}/${encodeURIComponent(artifact.filename)}`,
      ),
    );
    if (!response.ok || !response.body) {
      throw evidenceError("artifact_fetch_failed", `Failed to fetch artifact ${artifact.artifactId} for upload`);
    }
    const contentType = normalizeArtifactContentType(response.headers.get("content-type"), artifact.type);
    if (contentType !== expectedContentType) {
      throw evidenceError("unsupported_artifact_type", `Artifact ${artifact.artifactId} content type changed`);
    }
    return response.body as unknown as BodyInit;
  }

  private async ensureManagedBuckets(
    token: string,
    auth: ResolvedPrRepoAuth,
    fields: EvidenceLogFields,
  ): Promise<ReleaseBucket[]> {
    logInfo(this.host.log, "github_evidence.release.ensure.started", fields);
    try {
      const releases = await listReleases(token, auth.repoOwner, auth.repoName);
      const managedReleases: Array<{ bucketNumber: number; release: GithubRelease }> = [];

      for (const release of releases) {
        const bucketNumber = parseEvidenceReleaseBucket(release.tagName);
        if (!bucketNumber) continue;
        if (!isManagedEvidenceRelease(release)) {
          throw evidenceError("unmanaged_release_conflict", `Unmanaged GitHub evidence release ${release.tagName}`);
        }
        const nextRelease = releaseNeedsUpdate(release, bucketNumber)
          ? await updateManagedEvidenceRelease(token, auth.repoOwner, auth.repoName, release.id, bucketNumber)
          : release;
        managedReleases.push({ bucketNumber, release: nextRelease });
      }

      logInfo(this.host.log, "github_evidence.release.ensure.listed", {
        ...fields,
        totalReleaseCount: releases.length,
        managedReleaseCount: managedReleases.length,
      });

      managedReleases.sort((a, b) => a.bucketNumber - b.bucketNumber);
      const buckets: ReleaseBucket[] = [];
      for (const managed of managedReleases) {
        try {
          buckets.push({
            ...managed,
            assets: await listReleaseAssets(token, auth.repoOwner, auth.repoName, managed.release.id),
          });
        } catch (error) {
          throw evidenceError("release_asset_list_failed", "GitHub release asset listing failed", error);
        }
      }

      if (buckets.length === 0) {
        buckets.push(await this.createBucket(token, auth, 1, fields));
      }

      logInfo(this.host.log, "github_evidence.release.ensure.succeeded", {
        ...fields,
        totalReleaseCount: releases.length,
        managedReleaseCount: managedReleases.length,
        releaseId: buckets[0]?.release.id,
        releaseTag: buckets[0]?.release.tagName,
      });
      return buckets;
    } catch (error) {
      const reason = fallbackReason(error, "release_create_failed");
      const failureFields = { ...fields, operation: reason };
      logWarn(this.host.log, "github_evidence.release.ensure.failed", failureFields, error);
      postEvidenceEvent(this.host, "github_evidence.release.ensure.failed", failureFields, error);
      if (reason === "workflow_risk_detected") {
        logInfo(this.host.log, "github_evidence.workflow_risk_detected", fields);
      }
      throw error;
    }
  }

  private async createBucket(
    token: string,
    auth: ResolvedPrRepoAuth,
    bucketNumber: number,
    fields: EvidenceLogFields,
  ): Promise<ReleaseBucket> {
    const tagName = formatEvidenceReleaseTag(bucketNumber);
    logInfo(this.host.log, "github_evidence.release.bucket.create.started", {
      ...fields,
      bucketNumber,
      releaseTag: tagName,
    });

    try {
      const existingRelease = await getReleaseByTag(token, auth.repoOwner, auth.repoName, tagName);
      if (existingRelease) {
        if (!isManagedEvidenceRelease(existingRelease)) {
          throw evidenceError("unmanaged_release_conflict", `Unmanaged GitHub evidence release ${tagName}`);
        }
        const release = releaseNeedsUpdate(existingRelease, bucketNumber)
          ? await updateManagedEvidenceRelease(token, auth.repoOwner, auth.repoName, existingRelease.id, bucketNumber)
          : existingRelease;
        let assets: GithubReleaseAsset[];
        try {
          assets = await listReleaseAssets(token, auth.repoOwner, auth.repoName, release.id);
        } catch (error) {
          throw evidenceError("release_asset_list_failed", "GitHub release asset listing failed", error);
        }
        logInfo(this.host.log, "github_evidence.release.bucket.create.reused", {
          ...fields,
          bucketNumber,
          releaseId: release.id,
          releaseTag: release.tagName,
        });
        return {
          bucketNumber,
          release,
          assets,
        };
      }

      const existingTagSha = await getTagRefSha(token, auth.repoOwner, auth.repoName, tagName);
      if (existingTagSha) {
        throw evidenceError("tag_conflict", `GitHub tag ${tagName} already exists without a managed release`);
      }

      const defaultBranch = await getDefaultBranch(token, auth.repoOwner, auth.repoName);
      const riskyWorkflows = await repoHasWorkflowRisk(token, auth.repoOwner, auth.repoName, defaultBranch);
      if (riskyWorkflows) {
        throw evidenceError("workflow_risk_detected", "GitHub release/tag workflow risk detected");
      }

      const defaultBranchSha = await getBranchHeadSha(token, auth.repoOwner, auth.repoName, defaultBranch);
      if (!defaultBranchSha) {
        throw evidenceError("release_create_failed", "Default branch SHA is unavailable");
      }

      let release: GithubRelease;
      try {
        release = await createManagedEvidenceRelease(
          token,
          auth.repoOwner,
          auth.repoName,
          defaultBranchSha,
          bucketNumber,
        );
      } catch (error) {
        const status = githubStatus(error);
        if (status === 403)
          throw evidenceError("contents_write_missing", "GitHub contents write is unavailable", error);
        if (status === 429)
          throw evidenceError("github_rate_limited", "GitHub release creation was rate limited", error);
        throw evidenceError("release_create_failed", "GitHub managed evidence release creation failed", error);
      }

      logInfo(this.host.log, "github_evidence.release.bucket.create.succeeded", {
        ...fields,
        bucketNumber,
        releaseId: release.id,
        releaseTag: release.tagName,
      });
      return { bucketNumber, release, assets: [] };
    } catch (error) {
      const failureFields = {
        ...fields,
        bucketNumber,
        releaseTag: tagName,
        operation: fallbackReason(error, "release_create_failed"),
      };
      logWarn(this.host.log, "github_evidence.release.bucket.create.failed", failureFields, error);
      postEvidenceEvent(this.host, "github_evidence.release.bucket.create.failed", failureFields, error);
      throw error;
    }
  }

  private async findUploadBucket(
    token: string,
    auth: ResolvedPrRepoAuth,
    buckets: ReleaseBucket[],
    fields: EvidenceLogFields,
  ): Promise<ReleaseBucket> {
    const available = buckets.find((bucket) => bucket.assets.length < GITHUB_EVIDENCE_RELEASE_ASSET_LIMIT);
    if (available) return available;

    const highestBucketNumber = Math.max(0, ...buckets.map((bucket) => bucket.bucketNumber));
    const nextBucket = await this.createBucket(token, auth, highestBucketNumber + 1, fields);
    buckets.push(nextBucket);
    buckets.sort((a, b) => a.bucketNumber - b.bucketNumber);
    return nextBucket;
  }

  private async uploadOrReuseAsset(
    token: string,
    auth: ResolvedPrRepoAuth,
    buckets: ReleaseBucket[],
    artifact: PreparedVisualArtifact,
    fields: EvidenceLogFields,
  ): Promise<UploadAssetResult> {
    for (const bucket of buckets) {
      const existing = bucket.assets.find((asset) => asset.name === artifact.assetName);
      if (!existing) continue;
      if (existing.state === "starter") {
        await deleteReleaseAsset(token, auth.repoOwner, auth.repoName, existing.id);
        bucket.assets = bucket.assets.filter((asset) => asset.id !== existing.id);
        break;
      }
      if (!sameAsset(existing, artifact)) {
        throw evidenceError("asset_duplicate_conflict", `Conflicting GitHub release asset ${artifact.assetName}`);
      }
      return { asset: existing, release: bucket.release, uploaded: false };
    }

    const bucket = await this.findUploadBucket(token, auth, buckets, fields);
    const uploaded = await this.tryUploadAsset(token, auth, bucket, artifact, fields);
    bucket.assets.push(uploaded);
    return { asset: uploaded, release: bucket.release, uploaded: true };
  }

  private async tryUploadAsset(
    token: string,
    auth: ResolvedPrRepoAuth,
    bucket: ReleaseBucket,
    artifact: PreparedVisualArtifact,
    fields: EvidenceLogFields,
  ): Promise<GithubReleaseAsset> {
    try {
      const uploaded = await uploadReleaseAsset(token, auth.repoOwner, auth.repoName, bucket.release.id, {
        name: artifact.assetName,
        contentType: artifact.contentType,
        body: await artifact.openUploadBody(),
      });
      logInfo(this.host.log, "github_evidence.asset.upload.succeeded", {
        ...fields,
        releaseId: bucket.release.id,
        releaseTag: bucket.release.tagName,
        assetId: uploaded.id,
        artifactId: artifact.artifactId,
      });
      return uploaded;
    } catch (error) {
      const status = githubStatus(error);
      if (status !== 422 && status !== 502) {
        if (status === 429)
          throw evidenceError("github_rate_limited", "GitHub release asset upload was rate limited", error);
        throw evidenceError("asset_upload_failed", "GitHub release asset upload failed", error);
      }

      const refreshedAssets = await listReleaseAssets(token, auth.repoOwner, auth.repoName, bucket.release.id);
      bucket.assets = refreshedAssets;
      const conflict = refreshedAssets.find((asset) => asset.name === artifact.assetName);
      if (status === 422 && conflict && sameAsset(conflict, artifact)) {
        return conflict;
      }
      if (status === 502 && conflict?.state === "starter") {
        await deleteReleaseAsset(token, auth.repoOwner, auth.repoName, conflict.id);
        bucket.assets = bucket.assets.filter((asset) => asset.id !== conflict.id);
        const retry = await uploadReleaseAsset(token, auth.repoOwner, auth.repoName, bucket.release.id, {
          name: artifact.assetName,
          contentType: artifact.contentType,
          body: await artifact.openUploadBody(),
        });
        logInfo(this.host.log, "github_evidence.asset.upload.succeeded", {
          ...fields,
          releaseId: bucket.release.id,
          releaseTag: bucket.release.tagName,
          assetId: retry.id,
          artifactId: artifact.artifactId,
        });
        return retry;
      }
      if (status === 422) {
        throw evidenceError(
          "asset_duplicate_conflict",
          `GitHub release asset ${artifact.assetName} already exists`,
          error,
        );
      }
      throw evidenceError("asset_upload_failed", "GitHub release asset upload failed", error);
    }
  }

  private async patchFallbackBody(
    token: string,
    args: { auth: ResolvedPrRepoAuth; prNumber: number; body: string; sessionId: string },
    artifacts: VerificationArtifact[],
    fields: EvidenceLogFields,
    reason: EvidenceFallbackReason,
  ): Promise<void> {
    this.fallback(fields, reason);
    if (artifacts.length === 0) return;
    try {
      await this.patchPrVisualEvidenceSection(
        token,
        args,
        renderCycloidVisualEvidenceFallbackSection(artifacts),
        fields,
      );
    } catch (error) {
      const patchReason = fallbackReason(error, "pr_body_patch_failed");
      logWarn(this.host.log, "github_evidence.pr_body.update.failed", { ...fields, operation: patchReason }, error);
      this.fallback(fields, patchReason);
    }
  }

  private async patchPrVisualEvidenceSection(
    token: string,
    args: { auth: ResolvedPrRepoAuth; prNumber: number; body: string; sessionId: string },
    section: string,
    fields: EvidenceLogFields,
  ): Promise<void> {
    try {
      const installationId = args.auth.installationId ?? 0;
      if (installationId <= 0) {
        const body = upsertVisualEvidenceSection(args.body, section);
        await updatePullRequest(token, args.auth.repoOwner, args.auth.repoName, args.prNumber, { body });
        await this.rememberPrBody(args.sessionId, body);
        return;
      }
      const body = await storePrBodyRegionAndReconcile(this.host.env, {
        identity: {
          repoOwner: args.auth.repoOwner,
          repoName: args.auth.repoName,
          installationId,
          prNumber: args.prNumber,
          prUrl: `https://github.com/${args.auth.repoOwner}/${args.auth.repoName}/pull/${args.prNumber}`,
        },
        region: "visualEvidence",
        body: section,
        tokenHint: token,
        logger: this.host.log,
        rememberBody: (nextBody) => this.rememberPrBody(args.sessionId, nextBody),
      });
    } catch (error) {
      const status = githubStatus(error);
      if (status === 403) {
        throw evidenceError("pull_requests_write_missing", "GitHub pull request body update is unavailable", error);
      }
      if (status === 422) {
        throw evidenceError("pr_body_rejected", "GitHub rejected the visual evidence PR body", error);
      }
      if (status === 429) {
        throw evidenceError("github_rate_limited", "GitHub PR body update was rate limited", error);
      }
      logWarn(this.host.log, "github_evidence.pr_body.update.failed", fields, error);
      throw evidenceError("pr_body_patch_failed", "GitHub PR body update failed", error);
    }
  }

  private async deleteUnreferencedUploadedAssets(
    token: string,
    auth: ResolvedPrRepoAuth,
    assets: Array<{ assetId: number; releaseId: number }>,
    fields: EvidenceLogFields,
  ): Promise<void> {
    for (const asset of assets) {
      try {
        await deleteReleaseAsset(token, auth.repoOwner, auth.repoName, asset.assetId);
      } catch (error) {
        logWarn(
          this.host.log,
          "github_evidence.cleanup.failed",
          { ...fields, releaseId: asset.releaseId, assetId: asset.assetId },
          error,
        );
      }
    }
  }

  private async rememberPrBody(sessionId: string, body: string): Promise<void> {
    try {
      await this.host.state?.storage.put(LATEST_PR_BODY_STORAGE_KEY, body);
    } catch (error) {
      this.host.log.warn({ sessionId, errorMessage: String(error) }, "Failed to remember latest PR body");
    }
  }

  private fallback(fields: EvidenceLogFields, operation: EvidenceFallbackReason): void {
    logInfo(this.host.log, "github_evidence.fallback_to_links", { ...fields, operation });
  }
}
