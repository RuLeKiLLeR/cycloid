import { describe, expect, it } from "vitest";

import { TERMINAL_ERROR_PRECEDENCE } from "../../apps/control-plane-worker/src/session/lifecycle/terminal-decision";
import {
  datadogErrorCodeTag,
  ERROR_CODE_LABELS,
  ERROR_CODES,
  errorCodeHint,
  errorCodeLabel,
  formatSessionErrorMessage,
  isErrorCode,
} from "../../shared/types/error-codes";

describe("ErrorCode coverage", () => {
  it("keeps terminal precedence exhaustive for core error codes", () => {
    expect(new Set(TERMINAL_ERROR_PRECEDENCE)).toEqual(new Set(ERROR_CODES));
  });

  it("keeps presentation and Datadog mappings exhaustive", () => {
    for (const code of ERROR_CODES) {
      expect(errorCodeLabel(code)).toBe(ERROR_CODE_LABELS[code]);
      expect(datadogErrorCodeTag(code)).toBe(code === "spawn_modal_error" ? "spawn_provider_error" : code);
    }
    expect(datadogErrorCodeTag("future_code")).toBe("unknown");
    expect(formatSessionErrorMessage("bridge stopped", "sandbox_terminated")).toBe(
      "Sandbox terminated: bridge stopped",
    );
  });

  it("keeps internal failure terms out of customer-facing labels", () => {
    const forbiddenTerms = ["Codex", "bridge", "Provider"] as const;

    for (const label of Object.values(ERROR_CODE_LABELS)) {
      for (const term of forbiddenTerms) {
        expect(label).not.toContain(term);
      }
    }
  });

  it("registers sandbox_never_started across the union, precedence, and presentation maps", () => {
    expect(isErrorCode("sandbox_never_started")).toBe(true);
    expect(ERROR_CODES).toContain("sandbox_never_started");
    expect(TERMINAL_ERROR_PRECEDENCE).toContain("sandbox_never_started");
    expect(errorCodeLabel("sandbox_never_started")).toBe("Sandbox never started the prompt");
    expect(errorCodeHint("sandbox_never_started")).not.toBeNull();
  });

  it.each(["question_delivery_failed", "malformed_search_command", "memory_enforcement_failed"] as const)(
    "registers the named transport error %s across the union, precedence, and presentation maps",
    (code) => {
      expect(isErrorCode(code)).toBe(true);
      expect(ERROR_CODES).toContain(code);
      expect(TERMINAL_ERROR_PRECEDENCE).toContain(code);
      expect(errorCodeLabel(code)).toBe(ERROR_CODE_LABELS[code]);
      expect(errorCodeHint(code)).not.toBeNull();
    },
  );
});
