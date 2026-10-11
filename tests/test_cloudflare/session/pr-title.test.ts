import { describe, expect, it } from "vitest";

import { resolvePrTitle } from "../../../apps/control-plane-worker/src/session/pr-body.js";
import {
  applyTicketKeyPrefix,
  decidePrTitleReconcileAction,
  MAX_PR_TITLE_LENGTH,
  normalizeSessionPrTitle,
  validateProposedPrTitle,
} from "../../../apps/control-plane-worker/src/session/pr-title.js";

describe("decidePrTitleReconcileAction", () => {
  it("adopts the live title as the baseline for a legacy/untracked PR (lastApplied null)", () => {
    // Even when the resolved title differs, a never-tracked PR must not be
    // overwritten — it may have been renamed by a human before tracking existed.
    const action = decidePrTitleReconcileAction("Human picked this", null, "Cycloid would set this");
    expect(action).toEqual({ kind: "adopt_baseline", baseline: "Human picked this" });
  });

  it("skips when the live title diverged from the last applied title (human rename)", () => {
    const action = decidePrTitleReconcileAction("Human renamed it", "Cycloid last set this", "New Cycloid title");
    expect(action).toEqual({ kind: "skip_manual_rename" });
  });

  it("self-heals a stale baseline when the live title already equals the resolved title", () => {
    // Models a crash between a successful title PATCH and persisting the
    // baseline: GitHub already holds the resolved title but lastApplied is
    // stale. Without re-adopting, this would read as a human rename forever and
    // freeze all future title updates. Adopt the baseline; do not PATCH.
    const action = decidePrTitleReconcileAction("New Cycloid title", "Old Cycloid title", "New Cycloid title");
    expect(action).toEqual({ kind: "adopt_baseline", baseline: "New Cycloid title" });
  });

  it("applies the resolved title when tracked, unchanged by humans, and the title differs", () => {
    const action = decidePrTitleReconcileAction("Old Cycloid title", "Old Cycloid title", "New Cycloid title");
    expect(action).toEqual({ kind: "apply", title: "New Cycloid title" });
  });

  it("is a no-op when the live title already equals the resolved title", () => {
    const action = decidePrTitleReconcileAction("Same title", "Same title", "Same title");
    expect(action).toEqual({ kind: "noop" });
  });

  it("treats an empty-string baseline as tracked, not legacy", () => {
    // "" is a real (if unusual) applied value, distinct from null. A human
    // setting a non-empty title is a rename and must be respected.
    const action = decidePrTitleReconcileAction("Human set this", "", "Cycloid title");
    expect(action).toEqual({ kind: "skip_manual_rename" });
  });
});

describe("normalizeSessionPrTitle", () => {
  it("trims and strips the [ARC] prefix", () => {
    expect(normalizeSessionPrTitle("  [ARC] Fix the bug  ")).toBe("Fix the bug");
  });

  it("falls back to a default for empty/prefix-only input", () => {
    expect(normalizeSessionPrTitle("   ")).toBe("Changes from Cycloid");
    expect(normalizeSessionPrTitle("[ARC] ")).toBe("Changes from Cycloid");
  });

  it("does not enforce a length cap (length is bounded upstream in the bridge)", () => {
    const long = "x".repeat(200);
    expect(normalizeSessionPrTitle(long)).toBe(long);
  });
});

describe("applyTicketKeyPrefix", () => {
  it("returns the title unchanged when no key is provided", () => {
    expect(applyTicketKeyPrefix("Fix the dashboard", null)).toBe("Fix the dashboard");
  });

  it("prefixes a bare title with `KEY description`", () => {
    expect(applyTicketKeyPrefix("Fix the dashboard", "ENG-9001")).toBe("ENG-9001 Fix the dashboard");
  });

  it("is idempotent when the title already leads with the key", () => {
    expect(applyTicketKeyPrefix("ENG-9001 Fix the dashboard", "ENG-9001")).toBe("ENG-9001 Fix the dashboard");
  });

  it("normalizes a `KEY:` colon separator to the bare `KEY ` form the title check requires", () => {
    // The mia-copy-2 check is `^(ENG|TS|DATA|IT)-[0-9]+\ ` — a colon after the
    // digits FAILS it, so `ENG-9001: ...` must collapse to `ENG-9001 ...`.
    expect(applyTicketKeyPrefix("ENG-9001: Fix the dashboard", "ENG-9001")).toBe("ENG-9001 Fix the dashboard");
  });

  it("normalizes a `KEY - ` dash separator to bare form", () => {
    expect(applyTicketKeyPrefix("ENG-9001 - Fix the dashboard", "ENG-9001")).toBe("ENG-9001 Fix the dashboard");
  });

  it("does not double the key when it appears mid-string (extraction may find it mid-sentence)", () => {
    expect(applyTicketKeyPrefix("work on ENG-9001", "ENG-9001")).toBe("ENG-9001 work on");
    expect(applyTicketKeyPrefix("Fix ENG-9001 in the auth module", "ENG-9001")).toBe("ENG-9001 Fix in the auth module");
  });

  it("preserves a `-qualifier` after the key without leaving a dangling hyphen", () => {
    // `-rc1` is part of a longer token, not a ` - ` separator: its `rc1` survives,
    // and the leading hyphen left by the strip is cleaned off (no `-rc1` fragment).
    expect(applyTicketKeyPrefix("ENG-9001-rc1 Fix", "ENG-9001")).toBe("ENG-9001 rc1 Fix");
  });

  it("clamps the prefixed title to GitHub's title length limit", () => {
    const result = applyTicketKeyPrefix("x".repeat(300), "ENG-9001");
    expect(result.length).toBeLessThanOrEqual(MAX_PR_TITLE_LENGTH);
    expect(result.startsWith("ENG-9001 ")).toBe(true);
  });

  it("uppercases the existing leading key form via the canonical key (case-insensitive match)", () => {
    expect(applyTicketKeyPrefix("eng-9001 fix the dashboard", "ENG-9001")).toBe("ENG-9001 fix the dashboard");
  });

  it("falls back to a description when the title is only the key", () => {
    expect(applyTicketKeyPrefix("ENG-9001", "ENG-9001")).toBe("ENG-9001 Changes from Cycloid");
  });
});

describe("resolvePrTitle", () => {
  it("extracts an embedded ticket key from the selected title when no key was resolved", () => {
    expect(resolvePrTitle(undefined, "Fix ARC-1543: DM owner notification", [], null)).toBe(
      "ARC-1543 Fix DM owner notification",
    );
  });

  it("normalizes embedded title-key casing through the existing prefix helper", () => {
    expect(resolvePrTitle(undefined, "Fix arc-1543: DM owner notification", [], "ARC-1543")).toBe(
      "ARC-1543 Fix DM owner notification",
    );
  });

  it("does not treat common uppercase lookalikes as ticket keys", () => {
    expect(resolvePrTitle(undefined, "Support UTF-8 filenames in uploads", [], null)).toBe(
      "Support UTF-8 filenames in uploads",
    );
    expect(resolvePrTitle(undefined, "Patch CVE-2024-1234 handling", [], null)).toBe("Patch CVE-2024-1234 handling");
    expect(resolvePrTitle(undefined, "Support TLS-1 handshakes", [], null)).toBe("Support TLS-1 handshakes");
    expect(resolvePrTitle(undefined, "Enable GZIP-9 compression", [], null)).toBe("Enable GZIP-9 compression");
  });
});

describe("validateProposedPrTitle", () => {
  it("accepts a normal title and returns it normalized (prefix stripped)", () => {
    expect(validateProposedPrTitle("ENG-1234 Fix the thing")).toEqual({ ok: true, title: "ENG-1234 Fix the thing" });
    expect(validateProposedPrTitle("[ARC] ENG-1234 Fix")).toEqual({ ok: true, title: "ENG-1234 Fix" });
  });

  it("strips control characters and collapses whitespace before validating", () => {
    expect(validateProposedPrTitle("ENG-1\n\tfix   spaced")).toEqual({ ok: true, title: "ENG-1 fix spaced" });
  });

  it("rejects a non-string", () => {
    expect(validateProposedPrTitle(42)).toEqual({ ok: false, error: expect.stringContaining("string") });
    expect(validateProposedPrTitle(undefined)).toMatchObject({ ok: false });
  });

  it("rejects empty / whitespace-only / control-only input (not silently the fallback)", () => {
    expect(validateProposedPrTitle("")).toMatchObject({ ok: false });
    expect(validateProposedPrTitle("    ")).toMatchObject({ ok: false });
    expect(validateProposedPrTitle("\n\t\r")).toMatchObject({ ok: false });
  });

  it("rejects an [ARC]-prefix-only title instead of collapsing it to the fallback", () => {
    expect(validateProposedPrTitle("[ARC]")).toMatchObject({ ok: false });
    expect(validateProposedPrTitle("[ARC] ")).toMatchObject({ ok: false });
  });

  it("allows the literal fallback string when an agent proposes it explicitly", () => {
    expect(validateProposedPrTitle("Changes from Cycloid")).toEqual({ ok: true, title: "Changes from Cycloid" });
  });

  it("allows a real title that merely carries the [ARC] prefix", () => {
    // Only prefix-with-no-content is rejected; `[ARC] <content>` keeps its content.
    expect(validateProposedPrTitle("[ARC] Changes from Cycloid")).toEqual({
      ok: true,
      title: "Changes from Cycloid",
    });
    expect(validateProposedPrTitle("[ARC] ENG-1234 fix")).toEqual({ ok: true, title: "ENG-1234 fix" });
  });

  it("rejects an over-length title and accepts one at the cap", () => {
    expect(validateProposedPrTitle("x".repeat(MAX_PR_TITLE_LENGTH + 1))).toMatchObject({ ok: false });
    expect(validateProposedPrTitle("x".repeat(MAX_PR_TITLE_LENGTH))).toMatchObject({ ok: true });
  });
});
