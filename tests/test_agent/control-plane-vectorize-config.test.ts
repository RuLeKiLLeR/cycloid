import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const WRANGLER_CONFIG = join(__dirname, "../../apps/control-plane-worker/wrangler.toml");

function sectionAfter(config: string, marker: string): string {
  const start = config.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = config.slice(start);
  const nextSection = rest.indexOf("\n[[", marker.length);
  return nextSection === -1 ? rest : rest.slice(0, nextSection);
}

describe("control-plane Vectorize config", () => {
  it("binds the memory context Vectorize index in production and QA", () => {
    const config = readFileSync(WRANGLER_CONFIG, "utf8");
    const prod = sectionAfter(config, "[[vectorize]]");
    const qa = sectionAfter(config, "[[env.qa.vectorize]]");

    expect(prod).toContain('binding = "MEMORY_VECTOR_INDEX"');
    expect(prod).toContain('index_name = "cycloid-memory-context-production"');
    expect(qa).toContain('binding = "MEMORY_VECTOR_INDEX"');
    expect(qa).toContain('index_name = "cycloid-memory-context-qa"');
  });

  it("documents the required metadata indexes for filtered memory queries", () => {
    const config = readFileSync(WRANGLER_CONFIG, "utf8");

    for (const property of ["tenant_key", "repo_key", "scope_key", "source_kind"]) {
      expect(config).toContain(`--property-name=${property} --type=string`);
    }
    expect(config).toContain("--property-name=active --type=boolean");
    expect(config).toContain(
      "wrangler vectorize create cycloid-memory-context-production --dimensions=1536 --metric=cosine",
    );
    expect(config).toContain("wrangler vectorize create cycloid-memory-context-qa --dimensions=1536 --metric=cosine");
  });
});
