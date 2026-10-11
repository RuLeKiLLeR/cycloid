import { describe, expect, it } from "vitest";

import { describeSessionError } from "../../apps/sandbox-bridge/src/services/opencode-event-translator.js";

// Opencode `session.error` carries `properties.error` as a structured object
// ({ name, data: { message, statusCode?, responseBody? } }). The translator
// must surface that instead of falling back to a generic string, or real
// failure causes (model-not-found, auth) are lost in probe evidence.
describe("describeSessionError", () => {
  it("extracts name, status, and message from an APIError object", () => {
    const msg = describeSessionError({
      error: {
        name: "APIError",
        data: { message: "please check the model you provided", statusCode: 404, isRetryable: false },
      },
    });
    expect(msg).toBe("APIError status=404 please check the model you provided");
  });

  it("extracts name and message from a ProviderAuthError object", () => {
    const msg = describeSessionError({
      error: { name: "ProviderAuthError", data: { providerID: "baseten", message: "invalid key" } },
    });
    expect(msg).toBe("ProviderAuthError invalid key");
  });

  it("falls back to responseBody when data.message is absent", () => {
    const msg = describeSessionError({
      error: { name: "APIError", data: { statusCode: 500, responseBody: "upstream boom" } },
    });
    expect(msg).toBe("APIError status=500 upstream boom");
  });

  it("prefers a direct string message/error when present", () => {
    expect(describeSessionError({ message: "boom" })).toBe("boom");
    expect(describeSessionError({ error: "explicit error" })).toBe("explicit error");
  });

  it("returns undefined when nothing usable is present", () => {
    expect(describeSessionError({})).toBeUndefined();
    expect(describeSessionError({ error: { name: "UnknownError", data: {} } })).toBe("UnknownError");
  });
});
