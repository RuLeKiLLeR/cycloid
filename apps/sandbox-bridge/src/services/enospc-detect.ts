// Pure ENOSPC (disk-full) signature detection, split out so the match logic is
// unit-testable without a live sandbox (mirrors undersize-detect.ts for OOM).
//
// A full sandbox disk breaks the operations a session depends on — git
// commit/push can't write objects or the pack — with an ENOSPC error. That
// FAILURE is the disk equivalent of the kernel OOM-kill: the real outcome, not a
// proxy. We alert on it rather than on a disk-usage threshold because a repo can
// sit at ~97% disk and still succeed (openevidence/xyla does), so only the actual
// ENOSPC failure is actionable.

const ENOSPC_TEXT = /\bENOSPC\b|no space left on device/i;

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

// True when `err` (an Error, a raw string, or an exec-style error object) carries
// a disk-full signature: `code === 'ENOSPC'`, `errno` 28/-28, or an ENOSPC / "No
// space left on device" message on message/stderr/stdout/error. Never throws.
export function hasEnospcSignature(err: unknown): boolean {
  if (err == null) return false;
  if (typeof err === "string") return ENOSPC_TEXT.test(err);
  if (typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (e.code === "ENOSPC") return true;
  if (e.errno === 28 || e.errno === -28) return true;
  for (const field of ["message", "stderr", "stdout", "error"] as const) {
    if (ENOSPC_TEXT.test(asText(e[field]))) return true;
  }
  return false;
}
