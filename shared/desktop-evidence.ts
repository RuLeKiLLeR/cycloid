const DESKTOP_EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;
const DESKTOP_WALKTHROUGH_PATTERN = /^desktop-(.+)-walkthrough\.webm$/i;
const DESKTOP_PROOF_SCREENSHOT_PATTERN = /^desktop-(.+)-proof-([1-9]\d*)\.(?:webp|png|jpe?g)$/i;
const DESKTOP_UNSAFE_BYPRODUCT_FILENAME_PATTERN = /^desktop-.+-(?:action-trace|manifest|partial|click-\d+)\.[^.]+$/i;

const UNSAFE_DESKTOP_EVIDENCE_SEGMENTS = new Set([
  "action-trace",
  "action-traces",
  "action_trace",
  "action_traces",
  "cycloid-auth",
  "auth-state",
  "auth_state",
  "partial-recordings",
  "partial_recordings",
  "raw-frames",
  "raw_frames",
]);

const UNSAFE_AUTH_STATE_FILENAMES = new Set([
  "auth-state.json",
  "cookies.json",
  "storage-state.json",
  "storage_state.json",
]);

export type DesktopPrEvidenceDescriptor =
  { kind: "walkthrough"; scenarioId: string } | { kind: "proof_screenshot"; scenarioId: string; index: number };

function normalizeEvidencePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function pathSegments(value: string): string[] {
  return normalizeEvidencePath(value)
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function isValidScenarioId(value: string): boolean {
  return DESKTOP_EVIDENCE_ID_PATTERN.test(value) && value !== "." && value !== "..";
}

export function classifyDesktopPrEvidenceFilename(filename: string): DesktopPrEvidenceDescriptor | null {
  const trimmed = filename.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\")) return null;

  const walkthrough = trimmed.match(DESKTOP_WALKTHROUGH_PATTERN);
  if (walkthrough?.[1] && isValidScenarioId(walkthrough[1])) {
    return { kind: "walkthrough", scenarioId: walkthrough[1] };
  }

  const proof = trimmed.match(DESKTOP_PROOF_SCREENSHOT_PATTERN);
  if (proof?.[1] && proof[2] && isValidScenarioId(proof[1])) {
    return { kind: "proof_screenshot", scenarioId: proof[1], index: Number(proof[2]) };
  }

  return null;
}

export function classifyDesktopPrEvidencePath(relativePath: string): DesktopPrEvidenceDescriptor | null {
  const segments = pathSegments(relativePath);
  if (segments.length !== 1) return null;
  return classifyDesktopPrEvidenceFilename(segments[0]);
}

export function shouldExcludeUnsafeDesktopEvidencePath(relativePath: string): boolean {
  if (classifyDesktopPrEvidencePath(relativePath)) return false;

  const segments = pathSegments(relativePath).map((segment) => segment.toLowerCase());
  const filename = segments[segments.length - 1] ?? "";
  if (UNSAFE_AUTH_STATE_FILENAMES.has(filename)) return true;
  if (DESKTOP_UNSAFE_BYPRODUCT_FILENAME_PATTERN.test(filename)) return true;
  if (segments.some((segment) => UNSAFE_DESKTOP_EVIDENCE_SEGMENTS.has(segment))) return true;
  return segments.some(
    (segment) => segment === "desktop" || segment === "cycloid-desktop" || segment.startsWith("desktop-"),
  );
}

export function desktopEvidenceScenarioLabel(scenarioId: string): string {
  const label = scenarioId.replace(/[._-]+/g, " ").trim();
  if (!label) return "Desktop verification flow";
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}
