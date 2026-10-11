import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../..");
const OWNED_COMPONENTS = [
  "apps/ui/src/components/ui/SegmentedControl.tsx",
  "apps/ui/src/components/ui/Modal.tsx",
  "apps/ui/src/components/SearchableSelectChip.tsx",
  "apps/ui/src/components/Toast.tsx",
  "apps/ui/src/components/SidebarFilterPopover.tsx",
  "apps/ui/src/components/settings/SettingsLayout.tsx",
  "apps/ui/src/components/prompt-form/PromptFormViews.tsx",
] as const;

function source(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const channels = hex.match(/[a-f\d]{2}/gi)?.map((value) => channel(Number.parseInt(value, 16)));
  if (!channels || channels.length !== 3) throw new Error(`Invalid color: ${hex}`);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("owned UI design contract", () => {
  it("keeps muted text AA-readable on the lightest dark surface", () => {
    const css = source("apps/ui/src/App.css");
    const muted = css.match(/--color-text-muted:\s*(#[a-f\d]{6})/i)?.[1];
    const surface3 = css.match(/--color-surface-3:\s*(#[a-f\d]{6})/i)?.[1];
    expect(muted).toBeDefined();
    expect(surface3).toBeDefined();
    expect(contrast(muted!, surface3!)).toBeGreaterThanOrEqual(4.5);
  });

  it("uses named elevation, layer, interaction, and tracking utilities", () => {
    const violations = OWNED_COMPONENTS.flatMap((path) => {
      const contents = source(path);
      const patterns = [
        /shadow-\[[^\]]+\]/g,
        /\[box-shadow:[^\]]+\]/g,
        /\bz-(?:\d+|\[[^\]]+\])/g,
        /active:(?:scale|translate)[^\s"`]*/g,
        /tracking-(?:tighter|tight|wide|wider|widest|\[[^\]]+\])/g,
      ];
      return patterns.flatMap((pattern) => [...contents.matchAll(pattern)].map((match) => `${path}: ${match[0]}`));
    });

    expect(violations).toEqual([]);
    expect(source("apps/ui/src/App.css")).toContain("--tracking-mono: 0.08em");
  });
});
