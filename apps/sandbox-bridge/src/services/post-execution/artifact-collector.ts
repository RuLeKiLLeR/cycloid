import { createHash } from "crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "fs";
import { readFile } from "fs/promises";
import { join, sep } from "path";

import { WEBM_VIDEO_SIZE_LIMIT_BYTES } from "../../../../../shared/constants/artifacts.js";
import {
  classifyDesktopPrEvidencePath,
  shouldExcludeUnsafeDesktopEvidencePath,
} from "../../../../../shared/desktop-evidence.js";
import { redact } from "../../../../../shared/observability/redact.js";
import type { VerificationArtifact } from "../../../../../shared/types/sandbox.js";
import { stringifyError } from "../../../../../shared/utils/errors.js";
import { ARTIFACT_UPLOAD_TIMEOUT_MS, MAX_VERIFICATION_ARTIFACTS } from "../../constants/bridge.js";
import type { BridgeLogger } from "../../logger.js";
import { buildArtifactHeaderValues, classifyE2EArtifactType } from "../../utils/artifact-classification.js";

const INLINE_TEXT_ARTIFACT_MAX_BYTES = 2_048;
const INLINE_TEXT_ARTIFACT_TOTAL_BYTES = 12_000;

export interface ArtifactFailure {
  type: VerificationArtifact["type"];
  filename: string;
  reason: string;
}

/**
 * Full-surface port for {@link collectVerificationArtifacts}. The bridge owns
 * the evidence-root location, the control-plane upload URL/token, the
 * content-type sniffing, and the (spy-able) `fetch` so this module stays a pure
 * filesystem-walk + upload pipeline with no bridge coupling.
 *
 * `logFailure` is invoked only with the candidate `{ type, filename, reason }`;
 * it MUST NOT receive the bearer token.
 */
export interface ArtifactCollectorPort {
  evidenceDir: string;
  sessionId: string;
  repoSlug?: string;
  businessId?: string;
  agentRuntimeBackend?: string;
  model?: string;
  e2eRuntimeConfigured: boolean;
  buildUploadUrl: () => string;
  detectContentType: (filename: string) => string;
  getSandboxToken: () => string;
  fetch: typeof fetch;
}

type ArtifactCandidate = {
  name: string;
  path: string;
  type: VerificationArtifact["type"];
  size: number;
};

export async function collectVerificationArtifacts(
  port: ArtifactCollectorPort,
  promptLog: BridgeLogger,
  messageId: string,
  visualAssertion?: string,
  options?: {
    onArtifactFailure?: (failure: ArtifactFailure) => void;
  },
): Promise<VerificationArtifact[]> {
  const { evidenceDir } = port;
  if (!existsSync(evidenceDir)) return [];

  // Resolve the evidence root once and reuse it for every containment check
  // (both the top-level scan and the recursive walk), rather than re-running
  // realpathSync(evidenceDir) per candidate.
  let evidenceRoot: string | undefined;
  try {
    evidenceRoot = realpathSync(evidenceDir);
  } catch {
    evidenceRoot = undefined;
  }

  // Outcome counters for the unconditional artifact-count telemetry. `oversized`
  // is incremented at the two WebM size-limit skips (top-level scan + recursive
  // e2e walk); the rest are derived from the candidate/upload set sizes below.
  const scanCounters = { oversized: 0 };

  const candidates: ArtifactCandidate[] = readdirSync(evidenceDir)
    .sort()
    .flatMap((name): ArtifactCandidate[] => {
      const path = join(evidenceDir, name);
      try {
        // lstatSync (NOT statSync) so a top-level symlink is detected WITHOUT
        // following it. statSync would resolve a link like
        // `leak.png -> /tmp/cycloid-auth/state.json` and read+upload the
        // out-of-tree secret as evidence. Runtime auth state must never enter
        // uploads. This mirrors the symlink-skip already applied in walkE2EDir.
        const lstats = lstatSync(path);
        if (lstats.isSymbolicLink() || !lstats.isFile()) {
          if (lstats.isSymbolicLink()) {
            promptLog.warn({ filename: name }, "Skipping symlinked verification artifact");
          }
          return [];
        }
        // Defense-in-depth: reject any candidate whose realpath escapes the
        // evidence root (e.g. via a symlinked ancestor directory).
        if (!isWithinEvidenceRoot(evidenceDir, path, evidenceRoot)) {
          promptLog.warn({ filename: name }, "Skipping verification artifact outside evidence root");
          return [];
        }
        const size = lstats.size;
        if (size === 0) {
          promptLog.warn({ filename: name }, "Skipping empty verification artifact");
          return [];
        }
        const type = classifyE2EArtifactType(name);
        if (!type) return [];
        if (type === "video" && size > WEBM_VIDEO_SIZE_LIMIT_BYTES) {
          scanCounters.oversized += 1;
          promptLog.warn(
            { filename: name, sizeBytes: size, limitBytes: WEBM_VIDEO_SIZE_LIMIT_BYTES },
            "Skipping oversized WebM verification artifact",
          );
          return [];
        }
        return [{ name, path, type, size }];
      } catch (err) {
        promptLog.warn({ filename: name, error: String(err) }, "Failed to inspect verification artifact");
        return [];
      }
    });

  candidates.push(...collectE2EArtifactCandidates(evidenceDir, promptLog, scanCounters, evidenceRoot));
  const dedupedCandidates = sortVerificationArtifactCandidates(
    deduplicateVerificationArtifactCandidates(candidates, promptLog),
  );
  const publishableCandidates = dedupedCandidates.filter((candidate) => {
    if (!shouldExcludeUnsafeDesktopEvidencePath(candidate.name)) return true;
    promptLog.info({ filename: candidate.name }, "Skipping unsafe desktop verification artifact");
    return false;
  });
  // Duplicates are the only candidates dropped between the raw scan and the
  // deduped set (sort does not drop), so this difference is the duplicate count.
  const duplicateCount = candidates.length - dedupedCandidates.length;
  const typeCounts = dedupedCandidates.reduce(
    (acc, c) => {
      acc[c.type] = (acc[c.type] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const uploadCandidates =
    publishableCandidates.length === 0 ? [] : selectVerificationArtifactUploadCandidates(publishableCandidates);
  const inlineTextByPath = buildInlineTextArtifactPreviews(uploadCandidates, promptLog);
  // Candidates dropped by the per-type upload cap (screenshots are always kept).
  const desktopFilteredCount = dedupedCandidates.length - publishableCandidates.length;
  const skippedCount = publishableCandidates.length - uploadCandidates.length;

  if (uploadCandidates.length < publishableCandidates.length) {
    promptLog.warn(
      {
        total: publishableCandidates.length,
        selected: uploadCandidates.length,
        screenshotCount: publishableCandidates.filter((candidate) => candidate.type === "screenshot").length,
        limit: MAX_VERIFICATION_ARTIFACTS,
      },
      "Verification artifact count exceeds limit; preserving all screenshots and truncating non-screenshot uploads",
    );
  }

  const results = await Promise.all(
    uploadCandidates.map(async (candidate): Promise<VerificationArtifact | null> => {
      const { artifactLabel, artifactHeaderLabel, artifactDisplayLabel } = buildArtifactHeaderValues(
        candidate.name,
        candidate.type,
        visualAssertion,
      );
      const maxAttempts = candidate.type === "screenshot" ? 2 : 1;
      let lastFailureReason = "artifact upload failed";
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const body = await readFile(candidate.path);
          const response = await port.fetch(port.buildUploadUrl(), {
            method: "POST",
            headers: {
              Authorization: `Bearer ${port.getSandboxToken()}`,
              "Content-Type": port.detectContentType(candidate.name),
              "X-Artifact-Type": candidate.type,
              "X-Artifact-Label": artifactHeaderLabel,
              ...(artifactDisplayLabel ? { "X-Artifact-Display-Label": artifactDisplayLabel } : {}),
              "X-Prompt-Id": messageId,
            },
            body,
            signal: AbortSignal.timeout(ARTIFACT_UPLOAD_TIMEOUT_MS),
          });
          if (!response.ok) {
            lastFailureReason = `artifact upload returned HTTP ${response.status}`;
            if (attempt < maxAttempts && response.status >= 500) {
              promptLog.warn(
                {
                  filename: candidate.name,
                  artifactType: candidate.type,
                  status: response.status,
                  attempt,
                  maxAttempts,
                  timeoutMs: ARTIFACT_UPLOAD_TIMEOUT_MS,
                },
                "Verification screenshot artifact upload failed; retrying",
              );
              continue;
            }
            options?.onArtifactFailure?.({
              type: candidate.type,
              filename: candidate.name,
              reason: lastFailureReason,
            });
            promptLog.warn(
              {
                filename: candidate.name,
                artifactType: candidate.type,
                status: response.status,
                attempt,
                maxAttempts,
                timeoutMs: ARTIFACT_UPLOAD_TIMEOUT_MS,
              },
              "Verification artifact upload failed",
            );
            return null;
          }
          const payload = (await response.json()) as { artifact?: { id?: string; url?: string; label?: string } };
          const url = payload.artifact?.url;
          if (!url) {
            lastFailureReason = "artifact upload response did not include a URL";
            if (attempt < maxAttempts) {
              promptLog.warn(
                {
                  filename: candidate.name,
                  artifactType: candidate.type,
                  attempt,
                  maxAttempts,
                },
                "Verification screenshot artifact upload returned no URL; retrying",
              );
              continue;
            }
            options?.onArtifactFailure?.({
              type: candidate.type,
              filename: candidate.name,
              reason: lastFailureReason,
            });
            return null;
          }
          const inlineText = inlineTextByPath.get(candidate.path);
          const artifact: VerificationArtifact = {
            ...(payload.artifact?.id ? { artifactId: payload.artifact.id } : {}),
            type: candidate.type,
            label: payload.artifact?.label || artifactLabel,
            url,
            ...(inlineText ? { inlineText } : {}),
          };
          Object.defineProperty(artifact, "filename", {
            value: candidate.name,
            enumerable: false,
            configurable: true,
          });
          return artifact;
        } catch (err) {
          lastFailureReason = stringifyError(err);
          if (attempt < maxAttempts) {
            promptLog.warn(
              {
                filename: candidate.name,
                artifactType: candidate.type,
                error: String(err),
                attempt,
                maxAttempts,
                timeoutMs: ARTIFACT_UPLOAD_TIMEOUT_MS,
              },
              "Verification screenshot artifact upload failed; retrying",
            );
            continue;
          }
          options?.onArtifactFailure?.({
            type: candidate.type,
            filename: candidate.name,
            reason: lastFailureReason,
          });
          promptLog.warn(
            {
              filename: candidate.name,
              artifactType: candidate.type,
              error: String(err),
              attempt,
              maxAttempts,
              timeoutMs: ARTIFACT_UPLOAD_TIMEOUT_MS,
            },
            "Failed to upload verification artifact",
          );
          return null;
        }
      }
      options?.onArtifactFailure?.({
        type: candidate.type,
        filename: candidate.name,
        reason: lastFailureReason,
      });
      return null;
    }),
  );

  const uploaded = results.filter((a): a is VerificationArtifact => a !== null);
  uploadCandidates.forEach((candidate, index) => {
    const desktopEvidence = classifyDesktopPrEvidencePath(candidate.name);
    if (!desktopEvidence) return;
    promptLog.info(
      {
        event: "desktop.artifact_publish",
        artifactType: candidate.type,
        bytes: candidate.size,
        renderMode: desktopEvidence.kind,
        success: results[index] !== null,
        fallbackMode: results[index] === null ? "upload_failed" : "none",
      },
      "Desktop PR evidence artifact publish attempted",
    );
  });

  // Post-execution artifact-count telemetry. Emitted UNCONDITIONALLY (previously
  // gated on `e2eRuntimeConfigured`); non-E2E sessions also produce screenshots
  // via cycloid-verify-ui, and the outcome breakdown is useful everywhere. The
  // `e2e_runtime` flag still reflects the actual config so dashboards filtering
  // on it keep working. Per-type counts are retained alongside the new outcome
  // counts (uploaded/failed/skipped/duplicate/oversized).
  promptLog.info(
    {
      event: "e2e_post_exec_artifacts",
      e2e_runtime: port.e2eRuntimeConfigured,
      prompt_id: messageId,
      sessionId: port.sessionId,
      ...(port.repoSlug ? { repo: port.repoSlug } : {}),
      ...(port.businessId ? { businessId: port.businessId } : {}),
      agent_runtime_backend: port.agentRuntimeBackend ?? "unknown",
      model: port.model ?? "unknown",
      screenshot_count: typeCounts.screenshot ?? 0,
      log_count: typeCounts.log ?? 0,
      report_count: typeCounts.report ?? 0,
      video_count: typeCounts.video ?? 0,
      total: dedupedCandidates.length,
      uploaded: uploaded.length,
      failed: uploadCandidates.length - uploaded.length,
      skipped: skippedCount,
      desktop_filtered: desktopFilteredCount,
      duplicate: duplicateCount,
      oversized: scanCounters.oversized,
    },
    "E2E post-execution artifacts collected",
  );

  return uploaded;
}

function sortVerificationArtifactCandidates<T extends { name: string; type: VerificationArtifact["type"] }>(
  candidates: T[],
): T[] {
  const priority = (candidate: T): number => {
    switch (candidate.type) {
      case "screenshot":
        return 0;
      case "video":
        return 1;
      case "report":
        return 2;
      case "log":
        return 3;
      default:
        return 4;
    }
  };
  return [...candidates].sort((a, b) => priority(a) - priority(b) || a.name.localeCompare(b.name));
}

function selectVerificationArtifactUploadCandidates<T extends { type: VerificationArtifact["type"] }>(
  candidates: T[],
): T[] {
  const screenshots = candidates.filter((candidate) => candidate.type === "screenshot");
  const remainingSlots = Math.max(0, MAX_VERIFICATION_ARTIFACTS - screenshots.length);
  return [
    ...screenshots,
    ...candidates.filter((candidate) => candidate.type !== "screenshot").slice(0, remainingSlots),
  ];
}

function deduplicateVerificationArtifactCandidates<T extends { name: string; path: string; type: string }>(
  candidates: T[],
  promptLog: BridgeLogger,
): T[] {
  const seen = new Map<string, string>();
  const deduped: T[] = [];
  for (const candidate of candidates) {
    try {
      const fingerprint = `${candidate.type}:${createHash("sha256").update(readFileSync(candidate.path)).digest("hex")}`;
      const duplicateOf = seen.get(fingerprint);
      if (duplicateOf && !shouldPreserveDuplicateVerificationArtifact(candidate)) {
        promptLog.info(
          { filename: candidate.name, duplicateOf, artifactType: candidate.type },
          "Skipping duplicate verification artifact",
        );
        continue;
      }
      seen.set(fingerprint, candidate.name);
      deduped.push(candidate);
    } catch (err) {
      promptLog.warn({ filename: candidate.name, error: String(err) }, "Failed to fingerprint verification artifact");
      deduped.push(candidate);
    }
  }
  return deduped;
}

function buildInlineTextArtifactPreviews(
  candidates: ArtifactCandidate[],
  promptLog: BridgeLogger,
): Map<string, NonNullable<VerificationArtifact["inlineText"]>> {
  const previews = new Map<string, NonNullable<VerificationArtifact["inlineText"]>>();
  let remainingBytes = INLINE_TEXT_ARTIFACT_TOTAL_BYTES;
  for (const candidate of candidates) {
    if (candidate.type !== "log") continue;
    if (remainingBytes <= 0) {
      previews.set(candidate.path, {
        content: `[omitted because inline evidence preview budget of ${INLINE_TEXT_ARTIFACT_TOTAL_BYTES} bytes was exhausted]`,
        truncated: true,
        originalBytes: candidate.size,
      });
      continue;
    }
    const maxBytes = Math.min(INLINE_TEXT_ARTIFACT_MAX_BYTES, remainingBytes);
    try {
      const body = readFileSync(candidate.path);
      const truncated = body.length > maxBytes;
      let sliceStart = truncated ? body.length - maxBytes : 0;
      while (sliceStart < body.length && (body[sliceStart]! & 0xc0) === 0x80) sliceStart += 1;
      const previewBytes = truncated ? body.subarray(sliceStart) : body;
      const omittedPrefix = truncated ? `[truncated ${body.length - previewBytes.length} bytes]\n` : "";
      const content = redact(`${omittedPrefix}${new TextDecoder().decode(previewBytes)}`);
      previews.set(candidate.path, {
        content,
        truncated,
        originalBytes: candidate.size,
      });
      remainingBytes -= previewBytes.length;
    } catch (err) {
      promptLog.warn(
        { filename: candidate.name, artifactType: candidate.type, error: String(err) },
        "Failed to read inline verification text artifact preview",
      );
    }
  }
  return previews;
}

function shouldPreserveDuplicateVerificationArtifact(candidate: { name: string; type: string }): boolean {
  if (candidate.type !== "screenshot") return false;
  if (/^before-after\/(?:before|after)-[^/]+\.png$/i.test(candidate.name)) return true;
  return /^e2e-[^/]+\/.+\.(?:png|jpe?g|webp)$/i.test(candidate.name);
}

// Resolve `path` and confirm it stays inside `evidenceDir` after fully
// following symlinks. Used as a path-containment guard so no verification
// artifact can resolve to an out-of-tree file (e.g. runtime auth state under
// /tmp/cycloid-auth/). Returns false on any realpath error (broken link / race).
// `resolvedRoot` lets callers resolve the evidence root once per
// collectVerificationArtifacts call and reuse it across every candidate,
// instead of re-running realpathSync(evidenceDir) inside each loop.
function isWithinEvidenceRoot(evidenceDir: string, path: string, resolvedRoot?: string): boolean {
  try {
    const real = realpathSync(path);
    const root = resolvedRoot ?? realpathSync(evidenceDir);
    return real === root || real.startsWith(root + sep);
  } catch {
    return false;
  }
}

function collectE2EArtifactCandidates(
  evidenceDir: string,
  promptLog: BridgeLogger,
  scanCounters: { oversized: number },
  evidenceRoot?: string,
): ArtifactCandidate[] {
  if (!existsSync(evidenceDir)) return [];
  const candidates: ArtifactCandidate[] = [];
  let entries: string[];
  try {
    // Walk every subdirectory under evidenceDir. Originally we only
    // walked dirs prefixed `e2e-` (per the design doc) but agents reasonably
    // pick descriptive names like `color-input/` or `login-about/` and the
    // narrow filter caused real screenshots to disappear. The non-directory
    // top-level files are still picked up by the earlier sibling walk in
    // `collectVerificationArtifacts`.
    entries = readdirSync(evidenceDir);
  } catch (err) {
    promptLog.warn({ error: String(err) }, "Failed to list runtime evidence directories");
    return [];
  }
  for (const dir of entries.sort()) {
    const dirPath = join(evidenceDir, dir);
    try {
      // lstatSync (NOT statSync) to detect symlinks at the e2e-* level
      // without following them. A symlink like `e2e-traces -> /workspace/repo`
      // would otherwise resolve as a directory and trigger walkE2EDir on
      // the repo root, uploading source files as artifacts. This mirrors
      // the symlink-skip already applied inside walkE2EDir.
      const lstats = lstatSync(dirPath);
      if (lstats.isSymbolicLink() || !lstats.isDirectory()) continue;
    } catch {
      continue;
    }
    walkE2EDir(evidenceDir, dirPath, dir, candidates, promptLog, scanCounters, evidenceRoot);
  }
  return candidates;
}

function walkE2EDir(
  evidenceDir: string,
  dirPath: string,
  relativePrefix: string,
  candidates: ArtifactCandidate[],
  promptLog: BridgeLogger,
  scanCounters: { oversized: number },
  evidenceRoot?: string,
): void {
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch (err) {
    promptLog.warn({ dirPath, error: String(err) }, "Failed to read e2e evidence directory");
    return;
  }
  for (const entry of entries.sort()) {
    const path = join(dirPath, entry);
    const label = `${relativePrefix}/${entry}`;
    try {
      // Use lstatSync to detect symlinks WITHOUT following them. statSync
      // would resolve a symlink that points back to an ancestor directory
      // and recurse forever (test-runner output trees can contain such
      // links — Playwright's trace viewer occasionally produces them).
      // We skip symlinks entirely rather than risk loops or upload arbitrary
      // file content the agent didn't intend to capture.
      const lstats = lstatSync(path);
      if (lstats.isSymbolicLink()) {
        continue;
      }
      if (lstats.isDirectory()) {
        walkE2EDir(evidenceDir, path, label, candidates, promptLog, scanCounters, evidenceRoot);
        continue;
      }
      if (lstats.size === 0) continue;
      // Defense-in-depth: reject any candidate whose realpath escapes the
      // evidence root (e.g. via a symlinked ancestor directory).
      if (!isWithinEvidenceRoot(evidenceDir, path, evidenceRoot)) {
        promptLog.warn({ path: label }, "Skipping verification artifact outside evidence root");
        continue;
      }
      const type = classifyE2EArtifactType(entry);
      if (!type) continue;
      if (type === "video" && lstats.size > WEBM_VIDEO_SIZE_LIMIT_BYTES) {
        scanCounters.oversized += 1;
        promptLog.warn(
          { filename: label, sizeBytes: lstats.size, limitBytes: WEBM_VIDEO_SIZE_LIMIT_BYTES },
          "Skipping oversized WebM verification artifact",
        );
        continue;
      }
      candidates.push({ name: label, path, type, size: lstats.size });
    } catch (err) {
      promptLog.warn({ path, error: String(err) }, "Failed to stat e2e evidence entry");
    }
  }
}
