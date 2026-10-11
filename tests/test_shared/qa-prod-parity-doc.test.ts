import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { INTEGRATION_IDS } from "../../shared/constants/integration-helpers";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = resolve(TEST_DIR, "..", "..", "docs", "qa-prod-parity.md");
const ALLOWED_STATUSES = new Set(["parity", "partial", "missing", "intentionally-prod-only"]);
const EXPECTED_COLUMN_COUNT = 6;

function isMarkdownTableSeparator(line: string): boolean {
  return /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line);
}

function inventoryRows(markdown: string): string[][] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("| ") && !isMarkdownTableSeparator(line))
    .map((line) =>
      // This parser intentionally treats every literal pipe as a delimiter.
      // Use HTML entity &#124; instead of `|` inside table cells so failures
      // point at invalid table content rather than silently accepting ambiguity.
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells[0] !== "Capability");
}

describe("QA production parity doc", () => {
  const markdown = readFileSync(DOC_PATH, "utf8");
  const rows = inventoryRows(markdown);

  it("links back to the QA environment guide", () => {
    expect(markdown).toContain("[docs/qa-environment.md](qa-environment.md)");
  });

  it("covers every registry integration", () => {
    for (const integrationId of INTEGRATION_IDS) {
      const hasEntry = rows.some((cells) => cells[0]?.includes(`\`${integrationId}\``));
      expect(hasEntry, `${integrationId} is missing from docs/qa-prod-parity.md`).toBe(true);
    }
  });

  it("uses only documented status values", () => {
    for (const cells of rows) {
      const statusCell = cells[3];
      expect(statusCell, `${cells[0]} is missing a status cell`).toBeDefined();
      if (!statusCell) continue;
      const status = statusCell.replaceAll("`", "");
      expect(ALLOWED_STATUSES.has(status), `${cells[0]} has invalid status ${cells[3]}`).toBe(true);
    }
  });

  it("keeps every inventory row structurally complete", () => {
    for (const cells of rows) {
      expect(
        cells,
        `${cells[0] ?? "row"} must have ${EXPECTED_COLUMN_COUNT} columns; encode literal table-cell pipes as &#124;`,
      ).toHaveLength(EXPECTED_COLUMN_COUNT);
      expect(cells[4], `${cells[0]} is missing verification`).not.toMatch(/^\s*(?:-|none documented\.?)?\s*$/i);
      expect(cells[5], `${cells[0]} is missing a next action or rationale`).not.toMatch(
        /^\s*(?:-|none documented\.?)?\s*$/i,
      );
    }
  });

  it("requires parity rows to cite real verification", () => {
    for (const cells of rows) {
      const status = cells[3]?.replaceAll("`", "");
      if (status !== "parity") continue;
      expect(cells[4], `${cells[0]} parity row must cite verification`).not.toMatch(/none documented/i);
    }
  });

  it("requires non-parity rows to carry an explicit next action or rationale", () => {
    for (const cells of rows) {
      const status = cells[3]?.replaceAll("`", "");
      if (status === "parity") continue;
      expect(cells[5], `${cells[0]} ${status} row must name the next action or rationale`).not.toMatch(
        /none documented/i,
      );
    }
  });
});
