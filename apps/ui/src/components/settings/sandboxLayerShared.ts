// Formatting helpers shared by the two sandbox-layer surfaces: the
// workspace-default editor (SandboxEnvironmentSettings, mounted on
// WorkspacePoliciesSettings) and the per-repo resolution view
// (RepositorySandboxSettings, mounted on RepositoriesSettings). Kept identical
// so both surfaces render template IDs and timestamps the same way.

export function shortId(value: string | null | undefined): string {
  if (!value) return "Not available";
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

export function formatRelativeTime(value: number | null | undefined): string {
  if (!value) return "Not available";
  const deltaMs = Date.now() - value;
  const absMs = Math.abs(deltaMs);
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (absMs < minuteMs) return "just now";
  if (absMs < hourMs) return `${Math.max(1, Math.round(absMs / minuteMs))} min ago`;
  if (absMs < dayMs) return `${Math.round(absMs / hourMs)} hr ago`;
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
