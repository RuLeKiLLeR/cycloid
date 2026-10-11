import { classifyDesktopPrEvidencePath } from "../../../../shared/desktop-evidence.js";
import { resolvePublishVerdict } from "../../../../shared/publish-decision.js";
import type {
  ExecutionVerification,
  PreviewContract,
  PrReadinessCommand,
  PublishableEvidenceRef,
  VerificationArtifact,
  VerificationEvidenceRef,
  VerificationVerdict,
} from "../../../../shared/types/sandbox.js";

const MAX_VISUAL_ASSERTION_LENGTH = 300;
const VISUAL_ASSERTION_PREFIX_PATTERN =
  /^\s*(?:[-*]\s*)?(?:visual|screenshot)\s+(?:assertion|verification)(?:\s*\([^)]{1,40}\))?\s*:\s*(.+)$/i;
const RUNTIME_EVIDENCE_PATH_MARKERS = ["/cycloid-evidence/", "/runtime-evidence/"];

export type RuntimeEvidenceRequirement = {
  required: boolean;
};

function uniqueTrimmed(items: string[] | undefined): string[] {
  return Array.from(new Set((items ?? []).map((item) => item.trim()).filter(Boolean)));
}

function artifactEvidenceStatus(type: VerificationArtifact["type"]): VerificationEvidenceRef["status"] {
  return type === "screenshot" || type === "video" ? "uploaded" : "partial";
}

function artifactToEvidenceRef(artifact: VerificationArtifact): VerificationEvidenceRef {
  return {
    type: artifact.type,
    label: artifact.label,
    ...(artifact.artifactId ? { artifactId: artifact.artifactId } : {}),
    status: artifactEvidenceStatus(artifact.type),
    url: artifact.url,
  };
}

function artifactFilename(artifact: VerificationArtifact): string {
  if (artifact.filename?.trim()) return artifact.filename.trim();
  try {
    const url = new URL(artifact.url);
    const pathSegment = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
    if (pathSegment) return pathSegment;
  } catch {
    // Fall back to the display label below.
  }
  return artifact.label;
}

export function normalizeEvidencePathKey(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
}

function pathBasename(value: string): string {
  return normalizeEvidencePathKey(value).split("/").filter(Boolean).at(-1) ?? "";
}

function runtimeEvidenceRelativePath(value: string): string | undefined {
  const normalized = normalizeEvidencePathKey(value);
  for (const marker of RUNTIME_EVIDENCE_PATH_MARKERS) {
    const markerIndex = normalized.lastIndexOf(marker);
    if (markerIndex >= 0) {
      return normalized.slice(markerIndex + marker.length);
    }
  }
  return normalized.startsWith("/") ? undefined : normalized;
}

export function publishableEvidencePathKeys(ref: PublishableEvidenceRef): string[] {
  const keys = [
    runtimeEvidenceRelativePath(ref.path),
    pathBasename(ref.path),
    normalizeEvidencePathKey(ref.label),
    pathBasename(ref.label),
  ];
  return Array.from(new Set(keys.filter((key): key is string => Boolean(key))));
}

function publishableArtifactEvidenceRef(
  ref: PublishableEvidenceRef,
  artifact: VerificationArtifact,
): VerificationEvidenceRef {
  const reason = ref.reason.trim();
  return {
    type: artifact.type,
    label: ref.label.trim() || artifact.label,
    ...(artifact.artifactId ? { artifactId: artifact.artifactId } : {}),
    status: artifactEvidenceStatus(artifact.type),
    url: artifact.url,
    ...(reason ? { summary: reason } : {}),
  };
}

function addArtifactLookup(
  map: Map<string, VerificationArtifact[]>,
  key: string | undefined,
  artifact: VerificationArtifact,
) {
  const normalizedKey = key ? normalizeEvidencePathKey(key) : "";
  if (!normalizedKey) return;
  map.set(normalizedKey, [...(map.get(normalizedKey) ?? []), artifact]);
}

function firstArtifactMatch(
  map: Map<string, VerificationArtifact[]>,
  keys: readonly string[],
): VerificationArtifact | undefined {
  for (const key of keys) {
    const artifact = map.get(normalizeEvidencePathKey(key))?.[0];
    if (artifact) return artifact;
  }
  return undefined;
}

function removeArtifactFromMap(map: Map<string, VerificationArtifact[]>, artifact: VerificationArtifact) {
  for (const matches of map.values()) {
    const index = matches.indexOf(artifact);
    if (index >= 0) matches.splice(index, 1);
  }
}

export function bindPublishableEvidenceToArtifacts(
  refs: readonly PublishableEvidenceRef[],
  artifacts: readonly VerificationArtifact[],
): { artifacts: VerificationArtifact[]; evidence: VerificationEvidenceRef[]; missingRefs: PublishableEvidenceRef[] } {
  const artifactsByFilename = new Map<string, VerificationArtifact[]>();
  const artifactsByLabel = new Map<string, VerificationArtifact[]>();
  for (const artifact of artifacts) {
    addArtifactLookup(artifactsByFilename, artifactFilename(artifact), artifact);
    addArtifactLookup(artifactsByLabel, artifact.label, artifact);
  }

  const boundArtifacts: VerificationArtifact[] = [];
  const evidence: VerificationEvidenceRef[] = [];
  const missingRefs: PublishableEvidenceRef[] = [];

  for (const ref of refs) {
    const keys = publishableEvidencePathKeys(ref);
    const artifact = firstArtifactMatch(artifactsByFilename, keys) ?? firstArtifactMatch(artifactsByLabel, keys);
    if (!artifact) {
      missingRefs.push(ref);
      continue;
    }
    removeArtifactFromMap(artifactsByFilename, artifact);
    removeArtifactFromMap(artifactsByLabel, artifact);
    boundArtifacts.push(artifact);
    evidence.push(publishableArtifactEvidenceRef(ref, artifact));
  }

  // Desktop screenshots and recordings are staged automatically by the
  // first-party tools. Keep them publishable even when the judge also selects
  // non-desktop evidence from a phase directory.
  for (const artifact of artifacts) {
    if (boundArtifacts.includes(artifact) || !classifyDesktopPrEvidencePath(artifactFilename(artifact))) continue;
    boundArtifacts.push(artifact);
    evidence.push(artifactToEvidenceRef(artifact));
  }

  return { artifacts: boundArtifacts, evidence, missingRefs };
}

function commandStatusToEvidenceStatus(status: PrReadinessCommand["status"]): VerificationEvidenceRef["status"] {
  if (status === "completed") return "passed";
  if (status === "error") return "failed";
  return "skipped";
}

export function buildCommandVerificationEvidence(
  commands: ReadonlyArray<
    Pick<PrReadinessCommand, "command" | "status" | "check" | "source" | "summary" | "failureOutput" | "skipReason">
  >,
): VerificationEvidenceRef[] {
  return commands
    .filter((command) => command.command.trim().length > 0)
    .map((command) => ({
      type: "command",
      label: command.check ? `${command.check} (${command.source})` : `command (${command.source})`,
      status: commandStatusToEvidenceStatus(command.status),
      command: command.command,
      ...((command.summary ?? command.skipReason) ? { summary: command.summary ?? command.skipReason } : {}),
      ...(command.failureOutput?.trim() ? { failureOutput: command.failureOutput.trim() } : {}),
    }));
}

function clampExtractedText(value: string, maxLength: number): string | undefined {
  if (!value) return undefined;
  return value.length > maxLength ? `${value.slice(0, maxLength - 3).trimEnd()}...` : value;
}

function normalizeVisualAssertion(value: string): string | undefined {
  const normalized = value
    .replace(/\s+/g, " ")
    .replace(/^\s*["'`]+|["'`]+\s*$/g, "")
    .trim();
  return clampExtractedText(normalized, MAX_VISUAL_ASSERTION_LENGTH);
}

export function extractVisualAssertion(responseText: string): string | undefined {
  for (const line of responseText.split(/\r?\n/)) {
    const match = VISUAL_ASSERTION_PREFIX_PATTERN.exec(line);
    const assertion = match ? normalizeVisualAssertion(match[1]) : undefined;
    if (assertion) return assertion;
  }

  return undefined;
}

export function buildExecutionVerificationPayload({
  runtimeEvidenceRequirement,
  publishMode,
  publishWarnReasons,
  manualReviewReason,
  artifacts,
  previewContract,
  visualAssertion,
  verdict,
  claim,
  caveats,
  notes,
  explanationOverride,
  commandEvidence,
  artifactEvidence,
}: {
  runtimeEvidenceRequirement: RuntimeEvidenceRequirement;
  publishMode?: ExecutionVerification["publishMode"];
  publishWarnReasons?: string[];
  manualReviewReason?: string;
  artifacts: VerificationArtifact[];
  previewContract?: PreviewContract;
  visualAssertion?: string;
  verdict?: VerificationVerdict;
  claim?: string;
  caveats?: string[];
  notes?: string[];
  explanationOverride?: string;
  commandEvidence?: VerificationEvidenceRef[];
  artifactEvidence?: VerificationEvidenceRef[];
}): ExecutionVerification | undefined {
  const runtimeEvidenceSatisfied = artifacts.some((artifact) => artifact.type === "screenshot");
  const normalizedPublishWarnReasons = uniqueTrimmed(publishWarnReasons);
  const normalizedManualReviewReason = manualReviewReason?.trim();
  const resolvedArtifactEvidence = artifactEvidence ?? artifacts.map(artifactToEvidenceRef);
  const normalizedCommandEvidence = commandEvidence ?? [];
  const structuredEvidence = [...resolvedArtifactEvidence, ...normalizedCommandEvidence];

  // The bridge passes required:false; required:true remains for custom callers
  // that still model the former mandatory evidence policy.
  if (
    artifacts.length === 0 &&
    !previewContract &&
    !runtimeEvidenceRequirement.required &&
    (publishMode ?? "normal") === "normal" &&
    normalizedPublishWarnReasons.length === 0 &&
    !normalizedManualReviewReason &&
    !claim?.trim() &&
    !(caveats ?? []).some((value) => value.trim().length > 0) &&
    verdict !== "REFUTED" &&
    verdict !== "INCONCLUSIVE" &&
    !explanationOverride?.trim() &&
    structuredEvidence.length === 0
  ) {
    return undefined;
  }

  // Caveats are advisory under the optimistic default: they render as PR-body
  // context but no longer flip the verdict. Only forced / warn / manual-review
  // signals do.
  const normalizedCaveats = uniqueTrimmed([
    ...(caveats ?? []),
    ...normalizedPublishWarnReasons,
    ...(normalizedManualReviewReason ? [normalizedManualReviewReason] : []),
  ]);
  const normalizedNotes = uniqueTrimmed(notes);
  const resolvedVerdict = resolvePublishVerdict({
    warnReasons: normalizedPublishWarnReasons,
    manualReviewReason: normalizedManualReviewReason,
    // A caller-supplied CONFIRMED is not a force; let the optimistic default
    // decide. Only a non-success verdict forces.
    forcedVerdict: verdict === "REFUTED" || verdict === "INCONCLUSIVE" ? verdict : undefined,
  });
  const requestedPublishMode = publishMode ?? "normal";
  const resolvedPublishMode: NonNullable<ExecutionVerification["publishMode"]> =
    resolvedVerdict === "CONFIRMED" ? requestedPublishMode : "draft";

  const verified = resolvedVerdict === "CONFIRMED";
  const explanation =
    normalizedPublishWarnReasons[0] ??
    normalizedManualReviewReason ??
    explanationOverride?.trim() ??
    (runtimeEvidenceRequirement.required && !runtimeEvidenceSatisfied
      ? "Runtime verification evidence was not captured; PR publication was not blocked."
      : undefined) ??
    normalizedCaveats[0] ??
    (normalizedCommandEvidence.some((entry) => entry.type === "command" && entry.status === "passed")
      ? "Command verification completed in the sandbox."
      : undefined);
  return {
    verified,
    verdict: resolvedVerdict,
    ...(explanation ? { explanation } : {}),
    status:
      normalizedPublishWarnReasons.length > 0
        ? "warn"
        : resolvedPublishMode === "draft" || normalizedManualReviewReason || resolvedVerdict !== "CONFIRMED"
          ? "manual_review_required"
          : "passed",
    mode: runtimeEvidenceRequirement.required || artifacts.length > 0 ? "browser" : undefined,
    publishMode: resolvedPublishMode,
    runtimeEvidenceRequired: runtimeEvidenceRequirement.required,
    runtimeEvidenceSatisfied,
    ...(claim?.trim() ? { claim: claim.trim() } : {}),
    ...(structuredEvidence.length > 0 ? { evidence: structuredEvidence } : {}),
    ...(normalizedCaveats.length > 0 ? { caveats: normalizedCaveats } : {}),
    ...(normalizedNotes.length > 0 ? { notes: normalizedNotes } : {}),
    ...(normalizedManualReviewReason ? { manualReviewReason: normalizedManualReviewReason } : {}),
    ...(normalizedPublishWarnReasons.length > 0 ? { publishWarnReasons: normalizedPublishWarnReasons } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(previewContract ? { previewContract } : {}),
    ...(runtimeEvidenceSatisfied && visualAssertion ? { visualAssertion } : {}),
  };
}
