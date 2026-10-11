import { describe, expect, it } from "vitest";

import { SLACK_LINK_TOKEN_TTL_MS } from "../../apps/control-plane-worker/src/constants/slack.js";
import { createSlackLinkToken, verifySlackLinkToken } from "../../apps/control-plane-worker/src/slack/link-token.js";

const SECRET = "test-slack-link-signing-key";
const NOW = 1_700_000_000_000;

describe("slack/link-token", () => {
  it("round-trips a freshly minted token", async () => {
    const token = await createSlackLinkToken({ slackUserId: "U_ABC", slackTeamId: "T_XYZ" }, SECRET, NOW);
    const payload = await verifySlackLinkToken(token, SECRET, NOW);
    expect(payload).not.toBeNull();
    expect(payload!.slackUserId).toBe("U_ABC");
    expect(payload!.slackTeamId).toBe("T_XYZ");
    expect(payload!.expiresAt).toBe(NOW + SLACK_LINK_TOKEN_TTL_MS);
    expect(payload!.jti).toMatch(/^[0-9a-f]+$/);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSlackLinkToken({ slackUserId: "U_ABC", slackTeamId: "T_XYZ" }, SECRET, NOW);
    await expect(verifySlackLinkToken(token, "other-secret", NOW)).resolves.toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await createSlackLinkToken({ slackUserId: "U_ABC", slackTeamId: "T_XYZ" }, SECRET, NOW);
    const [payload, sig] = token.split(".");
    const forged = `${payload}x.${sig}`;
    await expect(verifySlackLinkToken(forged, SECRET, NOW)).resolves.toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await createSlackLinkToken({ slackUserId: "U_ABC", slackTeamId: "T_XYZ" }, SECRET, NOW);
    const afterExpiry = NOW + SLACK_LINK_TOKEN_TTL_MS + 1;
    await expect(verifySlackLinkToken(token, SECRET, afterExpiry)).resolves.toBeNull();
  });

  it("rejects a structurally malformed token", async () => {
    await expect(verifySlackLinkToken("not-a-real-token", SECRET, NOW)).resolves.toBeNull();
  });
});
