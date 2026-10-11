export type PrPersona = {
  id: string;
  name: string;
  tagline: string;
  accentEmoji: string;
  avatarUrl: string | null;
};

export const PR_PERSONAS = {
  zeus: {
    id: "zeus",
    name: "Zeus",
    tagline: "Code review — correctness, security, reuse",
    accentEmoji: "⚡",
    avatarUrl: null,
  },
  cycloidQa: {
    id: "cycloidQa",
    name: "Cycloid QA",
    tagline: "End-to-end verification",
    accentEmoji: "🔎",
    avatarUrl: null,
  },
} satisfies Record<string, PrPersona>;

function escapeInlineMarkdown(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safeAvatarUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname ? value : null;
  } catch {
    return null;
  }
}

export function renderPersonaHeader(persona: PrPersona): string {
  const avatarUrl = safeAvatarUrl(persona.avatarUrl);
  const avatar = avatarUrl
    ? `<img src="${escapeHtmlAttribute(avatarUrl)}" width="20" alt="${escapeHtmlAttribute(persona.name)}" /> `
    : "";
  return `## ${avatar}${escapeInlineMarkdown(persona.accentEmoji)} ${escapeInlineMarkdown(persona.name)}\n_${escapeInlineMarkdown(persona.tagline)}_`;
}
