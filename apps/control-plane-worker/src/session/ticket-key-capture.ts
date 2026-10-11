import type { Logger } from "../logger";
import * as doDb from "./do-db.js";
import { normalizeTicketKey, resolveSessionTicketKey } from "./ticket-key.js";

/**
 * Outcome of capturing an agent-created ticket key (`captureAgentCreatedTicketKey`).
 *
 * `set`: this call wrote the key into the empty `ticket_key` slot.
 * `already_present`: a key already resolves for the session (given/LLM/Linear/
 * leading-prompt), or a concurrent writer won the atomic update — either way the
 * agent-created key correctly did NOT override it.
 */
export type CaptureAgentTicketKeyResult =
  | { ok: true; outcome: "set" | "already_present" }
  | { ok: false; outcome: "invalid" | "session_not_found"; error: string };

/**
 * Capture a ticket key an agent minted mid-run (jira/linear `create_issue`) into
 * the session so the publish-time PR title carries it.
 *
 * Precedence: only fills the gap when NO key already resolves. A user-given or
 * LLM-extracted ticket — including a `linearContext.identifier` that
 * `resolveSessionTicketKey` prefers over `ext.ticketKey` but that may leave
 * `ticket_key` empty — always wins, so the agent-created key never overrides it.
 * The final write is an atomic conditional UPDATE (`setTicketKeyIfAbsent`) so it
 * cannot clobber the async title-LLM `ticket_key` write if that lands first.
 */
export function captureAgentCreatedTicketKey(
  sql: SqlStorage,
  log: Logger,
  sessionId: string,
  rawTicketKey: unknown,
): CaptureAgentTicketKeyResult {
  const ticketKey = normalizeTicketKey(typeof rawTicketKey === "string" ? rawTicketKey : null);
  if (!ticketKey) {
    return { ok: false, outcome: "invalid", error: "Ticket key is missing or malformed." };
  }

  const ext = doDb.getSessionExtended(sql, sessionId);
  if (!ext) {
    return { ok: false, outcome: "session_not_found", error: "Session not found." };
  }

  const prompts = doDb.getPrompts(sql, sessionId);
  const existing = resolveSessionTicketKey({
    llmTicketKey: ext.ticketKey ?? null,
    linearIdentifier: ext.linearContext?.identifier ?? null,
    prompts,
  });
  if (existing) {
    return { ok: true, outcome: "already_present" };
  }

  const wrote = doDb.setTicketKeyIfAbsent(sql, sessionId, ticketKey);
  if (!wrote) {
    // Lost the race to a concurrent writer (e.g. the title-LLM); treat as present.
    return { ok: true, outcome: "already_present" };
  }
  log.info(
    { event: "agent_ticket_key_captured", sessionId, ticketKey },
    "Captured agent-created ticket key for PR title",
  );
  return { ok: true, outcome: "set" };
}
