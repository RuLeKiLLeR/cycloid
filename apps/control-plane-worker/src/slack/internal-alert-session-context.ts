import { getUserDisplayProfile } from "../auth/db";
import { createLogger } from "../logger";
import { resolvePublicSessionUrl } from "../services/public-url";
import type { Env } from "../types";

const log = createLogger({ bindings: { component: "internal-alert-session-context" } });

type InternalAlertSessionUrlEnv = Pick<Env, "FRONTEND_URL" | "WORKER_ENV">;
type InternalAlertOwnerEnv = { DB?: D1Database | null };

export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function resolveInternalAlertOwnerLabel(
  env: InternalAlertOwnerEnv,
  ownerUserId: string | number | null | undefined,
  context: { sessionId: string },
): Promise<string | null> {
  const normalizedOwnerUserId = ownerUserId == null ? "" : String(ownerUserId).trim();
  if (!normalizedOwnerUserId) return null;
  if (typeof env.DB?.prepare !== "function") return normalizedOwnerUserId;

  try {
    const profile = await getUserDisplayProfile(env.DB, normalizedOwnerUserId);
    return profile?.login?.trim() || normalizedOwnerUserId;
  } catch (error) {
    log.warn(
      { sessionId: context.sessionId, ownerUserId: normalizedOwnerUserId, error: String(error) },
      "Failed to resolve internal alert session owner",
    );
    return normalizedOwnerUserId;
  }
}

export function buildInternalAlertSessionFooter(
  env: InternalAlertSessionUrlEnv,
  input: {
    sessionId: string;
    ownerUserLabel?: string | null;
    extraLink?: { url: string; label: string } | null;
  },
): string {
  const lines: string[] = [];
  if (input.ownerUserLabel?.trim()) {
    lines.push(`User: ${escapeSlackText(input.ownerUserLabel.trim())}`);
  }

  const links = [`Session \`${input.sessionId}\``, `<${resolvePublicSessionUrl(env, input.sessionId)}|View session>`];
  if (input.extraLink?.url && input.extraLink.label) {
    links.push(`<${input.extraLink.url}|${escapeSlackText(input.extraLink.label)}>`);
  }
  lines.push(links.join(" · "));
  return lines.join("\n");
}
