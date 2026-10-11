import type { VerifierCheck, VerifierCheckStatus, VerifierTerminalResult } from "../types/sandbox.js";

const MAX_RAW_SUMMARY_CHARS = 1000;
const MAX_FIELD_CHARS = 4000;
const MAX_LIST_ITEMS = 20;
const MAX_CHECK_NAME_CHARS = 80;

// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
export type ParsedVerifierTerminalResult = {
  result: VerifierTerminalResult;
  malformed: boolean;
  error?: string;
};

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[truncated]`;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean)
      .slice(0, MAX_LIST_ITEMS)
      .map((entry) => truncate(entry, MAX_FIELD_CHARS));
  }
  if (typeof value === "string" && value.trim()) return [truncate(value.trim(), MAX_FIELD_CHARS)];
  return [];
}

function needsWorkLabel(value: unknown): VerifierTerminalResult["needsWorkLabel"] | undefined {
  return value === "verification-gap" ? value : undefined;
}

function checkStatus(value: unknown): VerifierCheckStatus | null {
  return value === "passed" || value === "failed" || value === "skipped" ? value : null;
}

function checks(value: unknown): VerifierCheck[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const name = stringField(record.name);
      const status = checkStatus(record.status);
      if (!name || !status) return null;
      const detail = stringField(record.detail);
      return {
        name: truncate(name, MAX_CHECK_NAME_CHARS),
        status,
        ...(detail ? { detail: truncate(detail, MAX_FIELD_CHARS) } : {}),
      } satisfies VerifierCheck;
    })
    .filter((entry): entry is VerifierCheck => entry !== null)
    .slice(0, MAX_LIST_ITEMS);
}

function publishableEvidence(value: unknown): VerifierTerminalResult["publishableEvidence"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const record = entry as Record<string, unknown>;
      const path = stringField(record.path);
      if (!path) return null;
      const label = stringField(record.label) || path.split("/").pop() || path;
      const reason = stringField(record.reason) || "Selected by verification judge.";
      return {
        path: truncate(path, MAX_FIELD_CHARS),
        label: truncate(label, 300),
        reason: truncate(reason, MAX_FIELD_CHARS),
      };
    })
    .filter((entry): entry is NonNullable<VerifierTerminalResult["publishableEvidence"]>[number] => entry !== null)
    .slice(0, MAX_LIST_ITEMS);
  return refs.length > 0 ? refs : undefined;
}

function safeRawSummary(rawOutput: string): string {
  return truncate(
    rawOutput
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/```[\s\S]*?```/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 8)
      .join("\n"),
    MAX_RAW_SUMMARY_CHARS,
  );
}

function fallbackResult(rawOutput: string, fallbackHeadSha: string, error: string): ParsedVerifierTerminalResult {
  return {
    malformed: true,
    error,
    result: {
      verdict: "INCONCLUSIVE",
      verifiedHeadSha: fallbackHeadSha,
      summary: safeRawSummary(rawOutput) || "QA Tester output was missing or malformed.",
      evidence: [],
      blockers: [`QA Tester output was malformed: ${error}`],
    },
  };
}

function parseResultObject(
  value: unknown,
  fallbackHeadSha: string,
  rawOutputForFallback: string,
): ParsedVerifierTerminalResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallbackResult(rawOutputForFallback, fallbackHeadSha, "result is not an object");
  }

  const record = value as Record<string, unknown>;
  const verdict = stringField(record.verdict).toUpperCase();
  const summary = stringField(record.summary);
  const verifiedHeadSha =
    stringField(record.verifiedHeadSha) ||
    stringField(record.verified_head_sha) ||
    stringField(record.headSha) ||
    fallbackHeadSha;

  if (verdict !== "CONCLUSIVE" && verdict !== "INCONCLUSIVE") {
    return fallbackResult(rawOutputForFallback, fallbackHeadSha, "verdict must be CONCLUSIVE or INCONCLUSIVE");
  }
  if (!verifiedHeadSha) {
    return fallbackResult(rawOutputForFallback, fallbackHeadSha, "verifiedHeadSha is required");
  }
  if (!summary) {
    return fallbackResult(rawOutputForFallback, fallbackHeadSha, "summary is required");
  }

  return {
    malformed: false,
    result: {
      verdict,
      verifiedHeadSha: truncate(verifiedHeadSha, 80),
      ...(stringField(record.computedAgainstHeadSha ?? record.computed_against_head_sha)
        ? {
            computedAgainstHeadSha: truncate(
              stringField(record.computedAgainstHeadSha ?? record.computed_against_head_sha),
              80,
            ),
          }
        : {}),
      ...(() => {
        const label = needsWorkLabel(record.needsWorkLabel ?? record.needs_work_label);
        return label ? { needsWorkLabel: label } : {};
      })(),
      summary: truncate(summary, MAX_FIELD_CHARS),
      evidence: stringArray(record.evidence),
      ...(() => {
        const refs = publishableEvidence(record.publishableEvidence ?? record.publishable_evidence);
        return refs ? { publishableEvidence: refs } : {};
      })(),
      ...(() => {
        const parsedChecks = checks(record.checks);
        return parsedChecks.length ? { checks: parsedChecks } : {};
      })(),
      blockers: stringArray(record.blockers),
    },
  };
}

function candidateJsonBlocks(rawOutput: string): string[] {
  const blocks: string[] = [];
  const fencePattern = /```(?:json|cycloid-verification-result)?\s*([\s\S]*?)```/gi;
  for (const match of rawOutput.matchAll(fencePattern)) {
    const body = match[1]?.trim();
    if (body) blocks.push(body);
  }
  const trimmed = rawOutput.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) blocks.push(trimmed);
  return blocks;
}

function parseCandidate(candidate: string): unknown {
  return JSON.parse(candidate);
}

export function parseVerifierTerminalResult(rawOutput: string, fallbackHeadSha = ""): ParsedVerifierTerminalResult {
  const candidates = candidateJsonBlocks(rawOutput);
  if (candidates.length === 0) {
    return fallbackResult(rawOutput, fallbackHeadSha, "missing fenced JSON result");
  }

  let lastError = "invalid JSON result";
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = parseCandidate(candidate);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      continue;
    }
    const objectResult = parseResultObject(parsed, fallbackHeadSha, rawOutput);
    if (objectResult.malformed) {
      lastError = objectResult.error ?? lastError;
      continue;
    }
    return objectResult;
  }

  return fallbackResult(rawOutput, fallbackHeadSha, lastError);
}
