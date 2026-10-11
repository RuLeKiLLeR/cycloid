import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SessionListStatusChip } from "./SessionListStatusChip";

const statuses = ["checks-failing", "waiting", "running", "verifying", "pr-open", "done", "failed"] as const;

describe("SessionListStatusChip", () => {
  it.each(statuses)("renders %s without a fixed-width slab", (status) => {
    const html = renderToStaticMarkup(<SessionListStatusChip status={status} />);
    expect(html).toContain("status-pill");
    expect(html).not.toContain("w-36");
    expect(html).toContain("justify-center");
    expect(html).toContain("whitespace-nowrap");
  });

  it("renders PR open in the same grayscale family as other statuses", () => {
    const prOpen = renderToStaticMarkup(<SessionListStatusChip status="pr-open" />);
    const done = renderToStaticMarkup(<SessionListStatusChip status="done" />);
    expect(prOpen).not.toContain("emerald");
    expect(done).not.toContain("emerald");
  });
});
