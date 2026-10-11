import type { SessionMetadata } from "../types";
import { sessionEntrypointSearchTokens } from "./session-entrypoint";

export function buildSessionFilterText(
  session: Pick<
    SessionMetadata,
    | "sessionId"
    | "title"
    | "repoOwner"
    | "repoName"
    | "initiationMode"
    | "entrypoint"
    | "ruleNameSnapshot"
    | "cronSnapshot"
  >,
): string {
  const repoFullName = session.repoOwner && session.repoName ? `${session.repoOwner}/${session.repoName}` : null;
  // Surfaced so typing "scheduled" / the cron / the rule name narrows the list
  // without a dedicated chip — keeps the filter UI flat for V1.
  const sourceTokens = sessionEntrypointSearchTokens(session.entrypoint);

  return [
    session.title,
    session.sessionId,
    session.repoOwner,
    session.repoName,
    repoFullName,
    session.ruleNameSnapshot ?? null,
    session.cronSnapshot ?? null,
    ...sourceTokens,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}
