import { describe, expect, it } from "vitest";

import { parseApiErrorBody } from "../../apps/cli/src/utils/api-error.js";
import { clampPollInterval } from "../../apps/cli/src/utils/poll-interval.js";
import { unwrapSessionState } from "../../apps/cli/src/utils/session-payload.js";

describe("CLI shared utilities", () => {
  it.each([
    ['{"error":"invalid_model"}', { message: "invalid_model", serverCode: "invalid_model", rawError: "invalid_model" }],
    [
      '{"error":{"code":"invalid_model","message":"Unsupported model"}}',
      { message: "Unsupported model", serverCode: "invalid_model", rawError: "invalid_model" },
    ],
    ['{"message":"Unsupported model"}', { message: "Unsupported model" }],
    ["not json", null],
  ])("parses API error body %s", (body, expected) => {
    expect(parseApiErrorBody(body)).toEqual(expected);
  });

  it("preserves a string error for automation hints when a distinct code is present", () => {
    expect(parseApiErrorBody('{"error":"invalid_cron","code":"validation_failed"}')).toEqual({
      message: "invalid_cron",
      rawError: "invalid_cron",
      serverCode: "validation_failed",
    });
  });

  it("unwraps a session payload and clamps a polling interval", () => {
    expect(unwrapSessionState({ session: { id: "s_1" } })).toEqual({ id: "s_1" });
    expect(unwrapSessionState({ id: "s_1" })).toEqual({ id: "s_1" });
    expect(clampPollInterval(100, 250)).toBe(250);
    expect(clampPollInterval(500, 250)).toBe(500);
  });
});
