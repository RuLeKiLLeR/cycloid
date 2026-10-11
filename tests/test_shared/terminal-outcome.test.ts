import { describe, expect, it } from "vitest";

import { normalizeTerminalOutcome } from "../../shared/types/terminal-outcome.js";

describe("normalizeTerminalOutcome", () => {
  it("coerces error details without an error message to a failed terminal", () => {
    expect(
      normalizeTerminalOutcome({
        success: true,
        errorDetails: { message: "Tool is unsupported", name: "CodexStreamError" },
      }),
    ).toEqual({
      success: false,
      error: "Tool is unsupported",
      errorCode: "unknown",
      errorDetails: { message: "Tool is unsupported", name: "CodexStreamError" },
      coerced: true,
      rawErrorCode: null,
    });
  });

  it("uses a valid terminal error code when the message is absent", () => {
    const outcome = normalizeTerminalOutcome({ success: true, errorCode: "api_error" });

    expect(outcome.success).toBe(false);
    expect(outcome.errorCode).toBe("api_error");
    expect(outcome.error).toBeTruthy();
    expect(outcome.rawErrorCode).toBeNull();
  });

  it("preserves the raw code when a terminal error code outside the union is coerced to unknown", () => {
    const outcome = normalizeTerminalOutcome({
      success: false,
      error: "backend exploded",
      errorCode: "some_new_backend_code",
    });

    expect(outcome.success).toBe(false);
    expect(outcome.errorCode).toBe("unknown");
    expect(outcome.rawErrorCode).toBe("some_new_backend_code");
  });

  it("does not report a raw code when the error code is absent or empty", () => {
    expect(normalizeTerminalOutcome({ success: false, error: "boom" }).rawErrorCode).toBeNull();
    expect(normalizeTerminalOutcome({ success: false, error: "boom", errorCode: "" }).rawErrorCode).toBeNull();
  });

  it("keeps a recovered prompt and the next clean prompt successful", () => {
    const recovered = normalizeTerminalOutcome({ success: true });
    const nextPrompt = normalizeTerminalOutcome({ success: true });

    expect(recovered).toMatchObject({
      success: true,
      error: null,
      errorCode: null,
      coerced: false,
      rawErrorCode: null,
    });
    expect(nextPrompt).toMatchObject({
      success: true,
      error: null,
      errorCode: null,
      coerced: false,
      rawErrorCode: null,
    });
  });

  it("preserves an explicitly failed terminal with missing telemetry", () => {
    expect(normalizeTerminalOutcome({ success: false })).toMatchObject({
      success: false,
      errorCode: "unknown",
      coerced: false,
    });
  });
});
