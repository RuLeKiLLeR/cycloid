import { describe, expect, it } from "vitest";

import { redactSlackBodyForLog } from "../../apps/control-plane-worker/src/slack/notify.js";

describe("redactSlackBodyForLog", () => {
  it("strips message content but keeps routing metadata", () => {
    const redacted = redactSlackBodyForLog({
      channel: "C1",
      text: "secret session details",
      blocks: [{ type: "section" }],
      attachments: [{ x: 1 }],
      unfurl_links: false,
    });
    expect(redacted).toEqual({
      channel: "C1",
      unfurl_links: false,
      text: "[redacted]",
      blocks: "[redacted]",
      attachments: "[redacted]",
    });
  });

  it("leaves bodies without message content untouched", () => {
    expect(redactSlackBodyForLog({ users: "U1" })).toEqual({ users: "U1" });
  });
});
