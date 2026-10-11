import { basename } from "path";

import { WEBM_VIDEO_EXTENSION } from "../../../../shared/constants/artifacts.js";
import {
  classifyDesktopPrEvidenceFilename,
  shouldExcludeUnsafeDesktopEvidencePath,
} from "../../../../shared/desktop-evidence.js";
import type { VerificationArtifact } from "../../../../shared/types/sandbox.js";

export function classifyE2EArtifactType(name: string): VerificationArtifact["type"] | null {
  const desktopEvidence = classifyDesktopPrEvidenceFilename(name);
  if (desktopEvidence?.kind === "walkthrough") return "video";
  if (desktopEvidence?.kind === "proof_screenshot") return "screenshot";
  if (shouldExcludeUnsafeDesktopEvidencePath(name)) return null;
  if (/\.(png|jpe?g|webp)$/i.test(name)) return "screenshot";
  if (name.toLowerCase().endsWith(WEBM_VIDEO_EXTENSION)) return "video";
  if (/\.(mp4|m4v|mov|mkv|avi)$/i.test(name)) return null;
  if (/\.(?:html?|xhtml)$/i.test(name)) return "report";
  if (/\.(?:log|txt|json|jsonl|ndjson|out|err|xml|ya?ml|md)$/i.test(name)) return "log";
  return null;
}

export function buildVerificationArtifactLabel(
  name: string,
  type: VerificationArtifact["type"],
  visualAssertion?: string,
): string {
  if (type !== "screenshot" || !visualAssertion) return name;
  if (!hasGenericScreenshotName(name)) return name;
  return `${visualAssertion} (${name})`;
}

function hasGenericScreenshotName(name: string): boolean {
  const base = basename(name)
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
  if (!base) return false;
  if (/^(?:screenshot|screen|shot|image|capture)(?:[-_ ]\d+)?$/.test(base)) return true;
  return /^(?:app|page|screen|view|site|web)(?:[-_](?:home|index|page|login|dashboard|about))?(?:[-_]\d+)?$/.test(base);
}

function isByteStringHeaderValue(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0 || code === 10 || code === 13 || code > 255) return false;
  }
  return true;
}

function sanitizeArtifactHeaderLabel(label: string): string {
  return label.replace(/[\r\n]+/g, " ");
}

export function buildArtifactHeaderValues(
  candidateName: string,
  type: VerificationArtifact["type"],
  visualAssertion?: string,
): { artifactLabel: string; artifactHeaderLabel: string; artifactDisplayLabel?: string } {
  const artifactLabel = buildVerificationArtifactLabel(candidateName, type, visualAssertion);
  if (isByteStringHeaderValue(artifactLabel)) {
    return { artifactLabel, artifactHeaderLabel: artifactLabel };
  }
  return {
    artifactLabel,
    artifactHeaderLabel: sanitizeArtifactHeaderLabel(candidateName),
    artifactDisplayLabel: encodeURIComponent(artifactLabel),
  };
}
