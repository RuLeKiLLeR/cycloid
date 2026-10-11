import { describe, expect, it } from "vitest";

import {
  appendRecoveryGuidance,
  createDynamicToolFailure,
  createDynamicToolJsonSuccess,
  createDynamicToolTextSuccess,
  DynamicToolError,
} from "../../apps/sandbox-bridge/src/services/dynamic-tool-results.js";

describe("dynamic tool result constructors", () => {
  it("builds failure results with the expected content envelope", () => {
    expect(createDynamicToolFailure("invalid_input", "Bad input")).toEqual({
      success: false,
      errorCode: "invalid_input",
      contentItems: [{ type: "inputText", text: "Bad input" }],
    });
  });

  it("stores dynamic tool error code and status metadata", () => {
    const error = new DynamicToolError("Unauthorized", "upstream_http_error", 401);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DynamicToolError");
    expect(error.message).toBe("Unauthorized");
    expect(error.code).toBe("upstream_http_error");
    expect(error.status).toBe(401);
  });

  it("appends recovery guidance for mapped failure codes", () => {
    expect(appendRecoveryGuidance(createDynamicToolFailure("invalid_input", "Bad input"))).toEqual({
      success: false,
      errorCode: "invalid_input",
      contentItems: [
        {
          type: "inputText",
          text: "Bad input\n\nRecovery: Fix the arguments to match the tool schema and retry.",
        },
      ],
    });
  });

  it("does not duplicate recovery guidance when called more than once", () => {
    const guidedResult = appendRecoveryGuidance(createDynamicToolFailure("invalid_input", "Bad input"));

    expect(appendRecoveryGuidance(guidedResult)).toBe(guidedResult);
    expect(guidedResult.contentItems[0]?.text).toBe(
      "Bad input\n\nRecovery: Fix the arguments to match the tool schema and retry.",
    );
  });

  it("leaves unmapped failure codes without recovery guidance", () => {
    expect(appendRecoveryGuidance(createDynamicToolFailure("execution_failed", "Tool execution failed"))).toEqual({
      success: false,
      errorCode: "execution_failed",
      contentItems: [{ type: "inputText", text: "Tool execution failed" }],
    });
  });

  it("preserves retry metadata when appending recovery guidance", () => {
    expect(appendRecoveryGuidance(createDynamicToolFailure("upstream_rate_limited", "Rate limited", 2500))).toEqual({
      success: false,
      errorCode: "upstream_rate_limited",
      contentItems: [
        {
          type: "inputText",
          text:
            "Rate limited\n\nRecovery: " +
            "Automatic retries were already attempted. Continue other work and try again later; do not immediately retry.",
        },
      ],
      retryAfterMs: 2500,
    });
  });

  it("preserves text success payloads as raw text", () => {
    expect(createDynamicToolTextSuccess("plain text")).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "plain text" }],
    });
  });

  it("serializes JSON success payloads without truncation by default", () => {
    expect(createDynamicToolJsonSuccess({ ok: true, count: 2 })).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: '{"ok":true,"count":2}' }],
    });
  });

  it("truncates JSON success payloads when requested", () => {
    const result = createDynamicToolJsonSuccess({ value: "x".repeat(70 * 1024) }, { truncateText: true });
    const text = result.contentItems[0]?.text ?? "";

    expect(text).toHaveLength(64 * 1024);
    expect(text.endsWith("\n\n[truncated]")).toBe(true);
  });
});
