import { describe, expect, it } from "vitest";

import {
  entriesFromImport,
  mergeEntryMetaForKeys,
  parseEntryMetaJson,
  pruneEntryMeta,
  serializeEntryMetaJson,
} from "../../apps/control-plane-worker/src/env-blobs/entry-meta";

describe("env blob entry meta", () => {
  it("round-trips JSON and defaults sensitive to true", () => {
    const json = serializeEntryMetaJson({
      API_KEY: { usageNote: "GitHub", sensitive: true },
      PUBLIC_FLAG: { usageNote: null, sensitive: false },
    });
    expect(parseEntryMetaJson(json)).toEqual({
      API_KEY: { usageNote: "GitHub", sensitive: true },
      PUBLIC_FLAG: { usageNote: null, sensitive: false },
    });
    expect(parseEntryMetaJson("{}")).toEqual({});
    expect(parseEntryMetaJson("not-json")).toEqual({});
  });

  it("prunes metadata for removed keys", () => {
    expect(
      pruneEntryMeta(
        {
          KEEP: { usageNote: null, sensitive: true },
          DROP: { usageNote: "gone", sensitive: true },
        },
        ["KEEP"],
      ),
    ).toEqual({ KEEP: { usageNote: null, sensitive: true } });
  });

  it("merges import patches without dropping unrelated keys", () => {
    const merged = entriesFromImport(
      [
        { key: "A", usageNote: "from import" },
        { key: "B", usageNote: null },
      ],
      true,
      { C: { usageNote: "kept", sensitive: false } },
    );
    expect(merged).toEqual({
      C: { usageNote: "kept", sensitive: false },
      A: { usageNote: "from import", sensitive: true },
      B: { usageNote: null, sensitive: true },
    });

    expect(
      mergeEntryMetaForKeys({ A: { usageNote: "old", sensitive: true } }, ["A"], {
        usageNote: "new",
        sensitive: false,
      }),
    ).toEqual({ A: { usageNote: "new", sensitive: false } });
  });
});
