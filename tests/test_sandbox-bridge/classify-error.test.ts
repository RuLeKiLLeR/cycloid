import { describe, expect, it } from "vitest";

import { classifyError } from "../../apps/sandbox-bridge/src/utils/classify.ts";

describe("classifyError", () => {
  it("maps git fetch timeout checkout failures to api_error", () => {
    expect(
      classifyError(
        "Could not prepare the current PR head for verification: failed to fetch current PR head after 2 attempts: Error: git fetch timed out or was killed after 120000ms (signal=SIGTERM, killed=true)",
      ),
    ).toBe("api_error");
  });

  it("does not treat external git fetch kills as timeout retries", () => {
    expect(classifyError("Error: git fetch was killed externally (signal=SIGKILL)")).toBe("unknown");
  });
});
