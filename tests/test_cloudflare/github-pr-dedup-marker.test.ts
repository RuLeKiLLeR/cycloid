import { describe, expect, it } from "vitest";

import { appendPrDedupMarker, buildPrDedupMarker } from "../../apps/control-plane-worker/src/github/pr-dedup-marker";

describe("github/pr-dedup-marker", () => {
  describe("buildPrDedupMarker", () => {
    it("encodes the (sessionId, promptId) identity as an HTML comment", () => {
      expect(buildPrDedupMarker("sess-1", "prompt-9")).toBe("<!-- cycloid-dedup: sess-1:prompt-9 -->");
    });

    it("falls back to a stable key when promptId is missing", () => {
      expect(buildPrDedupMarker("sess-1", undefined)).toBe("<!-- cycloid-dedup: sess-1:no_prompt -->");
      expect(buildPrDedupMarker("sess-1", null)).toBe("<!-- cycloid-dedup: sess-1:no_prompt -->");
    });

    it("is deterministic across calls (replay-stable)", () => {
      expect(buildPrDedupMarker("sess-1", "prompt-9")).toBe(buildPrDedupMarker("sess-1", "prompt-9"));
    });

    it("differs per session and per prompt", () => {
      expect(buildPrDedupMarker("sess-1", "p")).not.toBe(buildPrDedupMarker("sess-2", "p"));
      expect(buildPrDedupMarker("sess-1", "p1")).not.toBe(buildPrDedupMarker("sess-1", "p2"));
    });
  });

  describe("appendPrDedupMarker", () => {
    it("appends the marker to the end of the body", () => {
      const out = appendPrDedupMarker("## Summary\n\nwork", "sess-1", "prompt-9");
      expect(out).toContain("## Summary");
      expect(out.endsWith(`${buildPrDedupMarker("sess-1", "prompt-9")}\n`)).toBe(true);
    });

    it("is idempotent — never adds a second marker", () => {
      const once = appendPrDedupMarker("body", "sess-1", "prompt-9");
      const twice = appendPrDedupMarker(once, "sess-1", "prompt-9");
      expect(twice).toBe(once);
      const marker = buildPrDedupMarker("sess-1", "prompt-9");
      expect(twice.split(marker).length - 1).toBe(1);
    });
  });
});
