import { describe, expect, it } from "vitest";

import {
  isSyntheticPrCoordinatorSessionId,
  SYNTHETIC_PR_COORDINATOR_SESSION_ID_PREFIX,
  syntheticPrCoordinatorSessionId,
} from "../../apps/control-plane-worker/src/session/pr-coordination-db";

describe("synthetic PR coordinator ids", () => {
  it("derive a deterministic session_id from the normalized PR URL", () => {
    const prUrl = "https://github.com/acme/widgets/pull/123";

    const sessionId = syntheticPrCoordinatorSessionId(prUrl);

    expect(sessionId).toBe(`${SYNTHETIC_PR_COORDINATOR_SESSION_ID_PREFIX}${encodeURIComponent(prUrl)}`);
    expect(isSyntheticPrCoordinatorSessionId(sessionId)).toBe(true);
    expect(isSyntheticPrCoordinatorSessionId("real-session-id")).toBe(false);
  });

  it("normalizes scheme, host, and trailing slashes", () => {
    expect(syntheticPrCoordinatorSessionId(" HTTPS://GitHub.com/acme/widgets/pull/123/ ")).toBe(
      syntheticPrCoordinatorSessionId("https://github.com/acme/widgets/pull/123"),
    );
  });
});
