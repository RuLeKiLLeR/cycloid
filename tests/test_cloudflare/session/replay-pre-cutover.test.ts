import { describe, expect, it } from "vitest";

import { flattenSessionEvents } from "../../../shared/transcript/projector";

describe("pre-cutover replay compatibility", () => {
  it("treats historical prompt_heartbeat replay events as no-op activity", () => {
    expect(
      flattenSessionEvents([
        { type: "prompt_processing", sequence: 1, data: { promptId: "p-1" } },
        { type: "prompt_heartbeat", sequence: 2, data: { messageId: "p-1" } },
        { type: "text", sequence: 3, data: { promptId: "p-1", id: "t-1", text: "done" } },
      ]),
    ).toEqual([{ type: "text", id: "t-1", text: "done", promptId: "p-1" }]);
  });
});
