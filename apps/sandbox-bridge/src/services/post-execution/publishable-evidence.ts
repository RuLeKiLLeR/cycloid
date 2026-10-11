import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync } from "fs";
import { basename, extname, join, sep } from "path";

import type { PublishableEvidenceRef, VerifierTerminalResult } from "../../../../../shared/types/sandbox.js";
import { stringifyError } from "../../../../../shared/utils/errors.js";
import { PHASE_EVIDENCE_DIR, RUNTIME_EVIDENCE_DIR } from "../../constants/bridge.js";
import { classifyE2EArtifactType } from "../../utils/artifact-classification.js";

export type PublishableEvidencePromotionFailure = {
  path: string;
  reason: string;
};

export type PublishableEvidencePromotionResult = {
  promotedPaths: string[];
  promotedRefs: PublishableEvidenceRef[];
  failures: PublishableEvidencePromotionFailure[];
};

function isWithinRoot(path: string, root: string): boolean {
  try {
    const realPath = realpathSync(path);
    const realRoot = realpathSync(root);
    return realPath === realRoot || realPath.startsWith(realRoot + sep);
  } catch {
    return false;
  }
}

function safeLabelForSource(label: string, sourcePath: string): string | null {
  const trimmed = label.trim();
  if (!trimmed || trimmed !== basename(trimmed)) return null;
  if (trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\")) return null;
  const sourceExt = extname(sourcePath).toLowerCase();
  if (!sourceExt || extname(trimmed).toLowerCase() !== sourceExt) return null;
  if (!classifyE2EArtifactType(trimmed)) return null;
  return trimmed;
}

function uniqueDestinationPath(filename: string, usedDestinations: Set<string>): string {
  const ext = extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  let candidate = filename;
  let index = 2;
  while (
    usedDestinations.has(join(RUNTIME_EVIDENCE_DIR, candidate)) ||
    existsSync(join(RUNTIME_EVIDENCE_DIR, candidate))
  ) {
    candidate = `${stem}-${index}${ext}`;
    index += 1;
  }
  const destination = join(RUNTIME_EVIDENCE_DIR, candidate);
  usedDestinations.add(destination);
  return destination;
}

function validatePublishableEvidenceSource(
  ref: PublishableEvidenceRef,
): { ok: true; sourcePath: string } | { ok: false; reason: string } {
  const sourcePath = ref.path.trim();
  if (!sourcePath) return { ok: false, reason: "path is empty" };
  if (!existsSync(sourcePath)) return { ok: false, reason: "file is missing" };
  let stats;
  try {
    stats = lstatSync(sourcePath);
  } catch {
    return { ok: false, reason: "file could not be inspected" };
  }
  if (stats.isSymbolicLink()) return { ok: false, reason: "symlinks are not supported" };
  if (!isWithinRoot(sourcePath, PHASE_EVIDENCE_DIR) && !isWithinRoot(sourcePath, RUNTIME_EVIDENCE_DIR)) {
    return { ok: false, reason: "path is outside allowed evidence roots" };
  }
  if (stats.isDirectory()) return { ok: false, reason: "directories are not supported" };
  if (!stats.isFile()) return { ok: false, reason: "path is not a regular file" };
  if (stats.size === 0) return { ok: false, reason: "file is empty" };
  if (!classifyE2EArtifactType(sourcePath)) return { ok: false, reason: "unsupported artifact extension" };
  return { ok: true, sourcePath };
}

export function promotePublishableEvidence(
  refs: readonly PublishableEvidenceRef[] | undefined,
): PublishableEvidencePromotionResult {
  if (!refs?.length) return { promotedPaths: [], promotedRefs: [], failures: [] };
  mkdirSync(RUNTIME_EVIDENCE_DIR, { recursive: true });

  const promotedPaths: string[] = [];
  const promotedRefs: PublishableEvidenceRef[] = [];
  const failures: PublishableEvidencePromotionFailure[] = [];
  const usedDestinations = new Set<string>();

  for (const ref of refs) {
    const validation = validatePublishableEvidenceSource(ref);
    if (!validation.ok) {
      failures.push({ path: ref.path, reason: validation.reason });
      continue;
    }

    const { sourcePath } = validation;
    if (isWithinRoot(sourcePath, RUNTIME_EVIDENCE_DIR)) {
      promotedPaths.push(sourcePath);
      promotedRefs.push({ ...ref, path: sourcePath });
      continue;
    }

    const label = safeLabelForSource(ref.label, sourcePath);
    const filename = label ?? basename(sourcePath);
    const destination = uniqueDestinationPath(filename, usedDestinations);
    try {
      copyFileSync(sourcePath, destination);
      promotedPaths.push(destination);
      promotedRefs.push({ ...ref, path: destination });
    } catch (error) {
      failures.push({ path: ref.path, reason: stringifyError(error) });
    }
  }

  return { promotedPaths, promotedRefs, failures };
}

export function applyPublishableEvidencePromotionResult(
  result: VerifierTerminalResult,
  promotion: PublishableEvidencePromotionResult,
): VerifierTerminalResult {
  const publishableEvidence = promotion.promotedRefs.length > 0 ? promotion.promotedRefs : undefined;
  if (publishableEvidence) {
    return {
      ...result,
      publishableEvidence,
    };
  }
  if (!result.publishableEvidence?.length) {
    if (!result.publishableEvidence) return result;
    const { publishableEvidence: _emptyPublishableEvidence, ...resultWithoutPublishableEvidence } = result;
    return resultWithoutPublishableEvidence;
  }

  const { publishableEvidence: _unpromotedPublishableEvidence, ...resultWithoutPublishableEvidence } = result;
  return resultWithoutPublishableEvidence;
}
