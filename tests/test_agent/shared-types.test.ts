import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SHARED_TYPES = [
  "ErrorCode",
  "DiagnosticEntry",
  "HandlePromptOptions",
  "SandboxCommand",
  "SandboxAckMessage",
  "SandboxSocketMessage",
  "UploadedFile",
  "UploadedImage",
];

const SHARED_SOURCE = resolve("shared/types/sandbox.ts");
const BRIDGE_EVENTS_SOURCE = resolve("shared/events/bridge.ts");

function readSource(path: string): string {
  return readFileSync(path, "utf-8");
}

describe("shared sandbox types (single source of truth)", () => {
  it("shared/types/sandbox.ts defines all canonical types", () => {
    const source = readSource(SHARED_SOURCE);
    for (const typeName of SHARED_TYPES) {
      expect(source, `shared source must define ${typeName}`).toContain(`export type ${typeName}`);
    }
  });

  it("shared/events/bridge.ts defines BridgeEvent", () => {
    const source = readSource(BRIDGE_EVENTS_SOURCE);
    expect(source).toContain("export type BridgeEvent =");
  });

  it("BridgeEvent does not duplicate discriminant values", () => {
    const source = readSource(BRIDGE_EVENTS_SOURCE);
    const bridgeEventStart = source.indexOf("export type BridgeEvent =");

    expect(bridgeEventStart).toBeGreaterThanOrEqual(0);

    const bridgeEventSource = source.slice(bridgeEventStart);

    const discriminants = Array.from(
      bridgeEventSource.matchAll(/^\s*\|\s*\{(?:[^\n]|\n(?!\s*\|))*?\btype:\s*"([^"]+)"/gm),
      ([, type]) => type,
    );

    expect(discriminants.length).toBeGreaterThan(0);

    const counts = new Map<string, number>();
    for (const type of discriminants) {
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }

    const duplicates = Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([type]) => type);

    expect(duplicates).toEqual([]);
  });
});
