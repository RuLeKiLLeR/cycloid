import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../../scripts/deploy-slack-mention.sh");
const FALLBACK = " cc <@U0AHT782S65> <@U0AHJCUSM70>"; // Shivam + Josiah

function mention(actor: string | undefined): string {
  return execFileSync("bash", [SCRIPT, ...(actor === undefined ? [] : [actor])], {
    encoding: "utf8",
  }).replace(/\n$/, "");
}

describe("deploy-slack-mention.sh", () => {
  it.each([
    ["josiah-arcanist", " cc <@U0AHJCUSM70>"],
    ["shiv-cycloid", " cc <@U0AHT782S65>"],
    ["jag-arcanist", " cc <@U0B1HH898LQ>"],
    ["vrn21-arcanist", " cc <@U0B4P7UE04X>"],
    ["jeman-arcanist", " cc <@U0B8V7UJLM9>"],
  ])("pings the responsible person for %s", (actor, expected) => {
    expect(mention(actor)).toBe(expected);
  });

  it("falls back to Shivam + Josiah for an unmapped actor", () => {
    expect(mention("dependabot[bot]")).toBe(FALLBACK);
    expect(mention("github-actions[bot]")).toBe(FALLBACK);
  });

  it("falls back when no actor is given", () => {
    expect(mention(undefined)).toBe(FALLBACK);
    expect(mention("")).toBe(FALLBACK);
  });
});
