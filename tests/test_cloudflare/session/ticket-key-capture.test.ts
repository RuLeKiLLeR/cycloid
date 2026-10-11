/**
 * Service + DAO tests for capturing an agent-created ticket key into the
 * session so the publish-time PR title carries it.
 */
import { describe, expect, it, vi } from "vitest";

import type { Logger } from "../../../apps/control-plane-worker/src/logger";
import * as doDb from "../../../apps/control-plane-worker/src/session/do-db.ts";
import { captureAgentCreatedTicketKey } from "../../../apps/control-plane-worker/src/session/ticket-key-capture.ts";
import { FakeStorage, mockCloudflareWorkers, seedPrompt, seedSession } from "./helpers.ts";

mockCloudflareWorkers();

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const SID = "sess-1";

function sqlOf(storage: FakeStorage): SqlStorage {
  return storage.sql as unknown as SqlStorage;
}

function ticketKeyOf(storage: FakeStorage): string | null {
  return doDb.getSessionExtended(sqlOf(storage), SID)?.ticketKey ?? null;
}

/** Seed a session (optionally with a first prompt) ready for capture. */
function seed(opts: { linearContextJson?: string; promptText?: string } = {}): FakeStorage {
  const storage = new FakeStorage();
  seedSession(storage, { sessionId: SID, ownerUserId: "u1", linearContextJson: opts.linearContextJson });
  seedPrompt(storage, { promptId: "p-1", sessionId: SID, promptText: opts.promptText ?? "Add a duration formatter" });
  return storage;
}

describe("captureAgentCreatedTicketKey", () => {
  it("sets ticket_key when no key resolves for the session", () => {
    const storage = seed();
    const result = captureAgentCreatedTicketKey(sqlOf(storage), log, SID, "ENG-5790");
    expect(result).toEqual({ ok: true, outcome: "set" });
    expect(ticketKeyOf(storage)).toBe("ENG-5790");
  });

  it("does not override an LLM-extracted ticket key already present", () => {
    const storage = seed();
    doDb.updateSessionFields(sqlOf(storage), SID, { ticketKey: "ABC-1" });
    const result = captureAgentCreatedTicketKey(sqlOf(storage), log, SID, "ENG-5790");
    expect(result).toEqual({ ok: true, outcome: "already_present" });
    expect(ticketKeyOf(storage)).toBe("ABC-1");
  });

  it("does not override a given Linear ticket whose identifier leaves ticket_key empty", () => {
    // The precedence guard: resolveSessionTicketKey prefers ext.ticketKey over
    // linearContext.identifier, so a naive set-if-ticket_key-empty would wrongly
    // override the Linear identifier. Capture must gate on the resolved key.
    const storage = seed({ linearContextJson: JSON.stringify({ identifier: "LIN-9" }) });
    const result = captureAgentCreatedTicketKey(sqlOf(storage), log, SID, "ENG-5790");
    expect(result).toEqual({ ok: true, outcome: "already_present" });
    expect(ticketKeyOf(storage)).toBeNull();
  });

  it("does not override a leading ticket key in the first prompt", () => {
    const storage = seed({ promptText: "ENG-1 wire up the thing" });
    const result = captureAgentCreatedTicketKey(sqlOf(storage), log, SID, "ENG-5790");
    expect(result).toEqual({ ok: true, outcome: "already_present" });
    expect(ticketKeyOf(storage)).toBeNull();
  });

  it("rejects a malformed key without writing", () => {
    const storage = seed();
    const result = captureAgentCreatedTicketKey(sqlOf(storage), log, SID, "not-a-key");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.outcome).toBe("invalid");
    expect(ticketKeyOf(storage)).toBeNull();
  });

  it("rejects a missing/non-string key", () => {
    const storage = seed();
    const result = captureAgentCreatedTicketKey(sqlOf(storage), log, SID, undefined);
    expect(result.ok === false && result.outcome).toBe("invalid");
  });

  it("returns session_not_found for an unknown session", () => {
    const storage = seed();
    const result = captureAgentCreatedTicketKey(sqlOf(storage), log, "missing", "ENG-5790");
    expect(result.ok === false && result.outcome).toBe("session_not_found");
  });

  it("is idempotent: a second capture after a set reports already_present", () => {
    const storage = seed();
    expect(captureAgentCreatedTicketKey(sqlOf(storage), log, SID, "ENG-5790").outcome).toBe("set");
    const second = captureAgentCreatedTicketKey(sqlOf(storage), log, SID, "ENG-6000");
    expect(second).toEqual({ ok: true, outcome: "already_present" });
    expect(ticketKeyOf(storage)).toBe("ENG-5790");
  });
});

describe("setTicketKeyIfAbsent (DAO)", () => {
  it("writes when ticket_key is empty and is a no-op once present (atomic guard)", () => {
    const storage = new FakeStorage();
    seedSession(storage, { sessionId: SID, ownerUserId: "u1" });
    expect(doDb.setTicketKeyIfAbsent(sqlOf(storage), SID, "ENG-5790")).toBe(true);
    expect(ticketKeyOf(storage)).toBe("ENG-5790");
    // A concurrent second writer (e.g. the title-LLM) must not clobber it.
    expect(doDb.setTicketKeyIfAbsent(sqlOf(storage), SID, "ENG-6000")).toBe(false);
    expect(ticketKeyOf(storage)).toBe("ENG-5790");
  });
});
