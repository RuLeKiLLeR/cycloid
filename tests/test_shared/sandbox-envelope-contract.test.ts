import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { type CycloidEvent, validateCycloidEvent } from "../../shared/events/schema.js";
import {
  flattenSessionEvents,
  getRawSessionEventData,
  getRawSessionEventKind,
  type RawSessionEvent,
} from "../../shared/transcript/projector.js";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/envelope", import.meta.url));

function readEnvelopeFixtures(): CycloidEvent[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as unknown)
    .map((fixture) => validateCycloidEvent(fixture));
}

describe("sandbox envelope contract", () => {
  it("validates committed bridge-to-DO canonical fixtures with the shared schema", () => {
    const fixtures = readEnvelopeFixtures();

    expect(fixtures.map((event) => event.phase)).toEqual([
      "agent.session.create",
      "error",
      "pr.open",
      "prompt.complete",
      "prompt.dispatch",
      "text.delta",
      "timeline",
      "tool.call",
      "tool.result",
      "user_question",
    ]);
  });

  it("keeps canonical DO broadcast frames consumable by transcript readers", () => {
    const fixtures = readEnvelopeFixtures();

    expect(fixtures.map((event) => getRawSessionEventKind(event))).toEqual([
      "agent_session_created",
      "session_error",
      "pr_opened",
      "prompt_completed",
      "prompt_processing",
      "text",
      "agent_timeline",
      "tool_call",
      "tool_update",
      "question",
    ]);

    for (const fixture of fixtures) {
      expect(getRawSessionEventData(fixture)).toEqual(expect.objectContaining({ promptId: "prompt-envelope" }));
    }

    expect(flattenSessionEvents(fixtures)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "I updated the guardrail test." }),
        expect.objectContaining({ type: "tool_call", id: "tool-1", tool: "exec_command" }),
        expect.objectContaining({ type: "question", id: "question-1" }),
        expect.objectContaining({ type: "agent_timeline", eventType: "files.edited" }),
        expect.objectContaining({ type: "session_error", code: "agent_runtime_error" }),
      ]),
    );
  });

  it("keeps the legacy raw event arm working while replay still accepts it", () => {
    const legacyFrame: RawSessionEvent = {
      type: "text",
      sequence: 1,
      data: {
        id: "legacy-text-1",
        promptId: "prompt-envelope",
        text: "Legacy replay row",
      },
    };

    expect(getRawSessionEventKind(legacyFrame)).toBe("text");
    expect(getRawSessionEventData(legacyFrame)).toEqual(legacyFrame.data);
    expect(flattenSessionEvents([legacyFrame])).toEqual([
      expect.objectContaining({ type: "text", id: "legacy-text-1", text: "Legacy replay row" }),
    ]);
  });
});
