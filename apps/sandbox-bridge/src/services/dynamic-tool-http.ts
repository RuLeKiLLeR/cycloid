export function normalizeControlPlaneUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const withScheme = value.startsWith("http://") || value.startsWith("https://") ? value : `https://${value}`;
  return withScheme.replace(/\/+$/, "");
}
