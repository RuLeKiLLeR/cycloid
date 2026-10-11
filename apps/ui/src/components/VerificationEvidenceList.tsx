import type { VerificationEvidenceRef } from "../../../../shared/types/sandbox";

const EVIDENCE_TYPES = new Set<VerificationEvidenceRef["type"]>([
  "screenshot",
  "video",
  "command",
  "log",
  "report",
  "artifact",
]);

const EVIDENCE_STATUSES = new Set<NonNullable<VerificationEvidenceRef["status"]>>([
  "passed",
  "failed",
  "skipped",
  "uploaded",
  "partial",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeEvidenceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function verificationEvidenceFromMetadata(
  metadata: Record<string, unknown> | undefined,
): VerificationEvidenceRef[] {
  const rawEvidence = metadata?.evidence;
  if (!Array.isArray(rawEvidence)) return [];

  return rawEvidence
    .map((entry): VerificationEvidenceRef | null => {
      if (!isRecord(entry)) return null;
      const rawType = stringField(entry, "type");
      if (!rawType || !EVIDENCE_TYPES.has(rawType as VerificationEvidenceRef["type"])) return null;
      const type = rawType as VerificationEvidenceRef["type"];
      const label = stringField(entry, "label") ?? type;
      const rawStatus = stringField(entry, "status");
      const status =
        rawStatus && EVIDENCE_STATUSES.has(rawStatus as NonNullable<VerificationEvidenceRef["status"]>)
          ? (rawStatus as NonNullable<VerificationEvidenceRef["status"]>)
          : undefined;
      return {
        type,
        label,
        ...(stringField(entry, "artifactId") ? { artifactId: stringField(entry, "artifactId") } : {}),
        ...(status ? { status } : {}),
        ...(safeEvidenceUrl(stringField(entry, "url")) ? { url: safeEvidenceUrl(stringField(entry, "url")) } : {}),
        ...(stringField(entry, "command") ? { command: stringField(entry, "command") } : {}),
        ...(stringField(entry, "summary") ? { summary: stringField(entry, "summary") } : {}),
        ...(stringField(entry, "failureOutput") ? { failureOutput: stringField(entry, "failureOutput") } : {}),
      };
    })
    .filter((entry): entry is VerificationEvidenceRef => entry !== null);
}

function statusLabel(status: VerificationEvidenceRef["status"]): string {
  if (status === "uploaded") return "captured";
  return status ?? "recorded";
}

function EvidenceReference({ evidence }: { evidence: VerificationEvidenceRef }) {
  if (evidence.url) {
    return (
      <a
        href={evidence.url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 break-all text-text-primary underline decoration-border underline-offset-2 hover:decoration-border-hover"
      >
        {evidence.label}
      </a>
    );
  }

  return <span className="min-w-0 break-words text-text-primary">{evidence.label}</span>;
}

export function VerificationEvidenceList({ evidence }: { evidence: VerificationEvidenceRef[] }) {
  if (evidence.length === 0) return null;

  return (
    <ul className="mt-2 space-y-1 text-xs text-text-secondary">
      {evidence.map((entry, index) => (
        <li key={`${entry.type}-${entry.artifactId ?? entry.url ?? entry.label}-${index}`} className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-2xs text-text-muted">{entry.type}</span>
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-2xs text-text-muted">
              {statusLabel(entry.status)}
            </span>
            <EvidenceReference evidence={entry} />
          </div>
          {entry.summary ? <div className="break-words pl-0.5">{entry.summary}</div> : null}
          {entry.command ? (
            <code className="block min-w-0 break-all rounded bg-surface-2 px-1.5 py-0.5 text-xs">{entry.command}</code>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
