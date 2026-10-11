// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { describe, expect, it } from "vitest";

import {
  type ExtendedEvent,
  getEventProperties,
  isQuestionAskedEvent,
  type QuestionAskedEvent,
} from "../../apps/sandbox-bridge/src/utils/event-guards.js";

describe("event-guards", () => {
  const questionAsked: QuestionAskedEvent = {
    type: "question.asked",
    properties: {
      id: "q-1",
      sessionID: "sess-1",
      questions: [{ question: "Should I continue?" }],
    },
  };

  const sessionCreated = {
    type: "session.created" as const,
    properties: {
      info: {
        id: "sess-1",
        projectID: "proj-1",
        directory: "/tmp",
        title: "Test",
        version: "1",
        time: { created: Date.now(), updated: Date.now() },
      },
    },
  };

  describe("isQuestionAskedEvent", () => {
    it("returns true for question.asked events", () => {
      expect(isQuestionAskedEvent(questionAsked)).toBe(true);
    });

    it("returns false for other event types", () => {
      expect(isQuestionAskedEvent(sessionCreated as unknown as ExtendedEvent)).toBe(false);
    });
  });

  describe("getEventProperties", () => {
    it("extracts properties as a record from known events", () => {
      const result = getEventProperties(sessionCreated as unknown as ExtendedEvent);
      expect(result).toHaveProperty("info");
    });

    it("extracts properties from undocumented events", () => {
      const result = getEventProperties({
        type: "some.event",
        properties: { id: "evt-1", sessionID: "sess-1" },
      } as unknown as ExtendedEvent);

      expect(result).toHaveProperty("id", "evt-1");
      expect(result).toHaveProperty("sessionID", "sess-1");
    });

    it("returns empty object when properties is missing", () => {
      const noProps = { type: "some.event" } as unknown as ExtendedEvent;
      expect(getEventProperties(noProps)).toEqual({});
    });

    it("returns empty object when properties is not an object", () => {
      const badProps = { type: "some.event", properties: "string" } as unknown as ExtendedEvent;
      expect(getEventProperties(badProps)).toEqual({});
    });

    it("returns empty object when properties is an array", () => {
      const arrayProps = { type: "some.event", properties: [1, 2, 3] } as unknown as ExtendedEvent;
      expect(getEventProperties(arrayProps)).toEqual({});
    });
  });
});
