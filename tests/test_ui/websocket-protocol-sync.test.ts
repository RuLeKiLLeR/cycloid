import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const WORKER_WS_TYPES = resolve("apps/control-plane-worker/src/ws/types.ts");
const UI_WS_TYPES = resolve("apps/ui/src/hooks/useSessionWebSocket.ts");

function readSource(path: string): string {
  return readFileSync(path, "utf-8");
}

function extractServerMessageTypes(source: string): string[] {
  const serverMessageStart = source.indexOf("export type ServerMessage =");
  if (serverMessageStart < 0) {
    throw new Error("ServerMessage definition not found");
  }

  const followingExport = source.indexOf("\nexport ", serverMessageStart + 1);
  const followingConst = source.indexOf("\nconst ", serverMessageStart + 1);
  const end = [followingExport, followingConst].filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? source.length;
  const serverMessageBlock = source.slice(serverMessageStart, end);

  return [...serverMessageBlock.matchAll(/type:\s*"([^"]+)"/g)].map((match) => match[1]).sort();
}

describe("worker/UI websocket protocol sync", () => {
  it("does not expose stale top-level websocket protocol messages", () => {
    const workerTypes = extractServerMessageTypes(readSource(WORKER_WS_TYPES));
    const uiTypes = extractServerMessageTypes(readSource(UI_WS_TYPES));

    expect(workerTypes).not.toContain("prompt_queued");
    expect(workerTypes).not.toContain("processing_status");
    expect(uiTypes).not.toContain("prompt_queued");
    expect(uiTypes).not.toContain("processing_status");
    expect(workerTypes).not.toContain("error");
    expect(uiTypes).not.toContain("error");
  });

  it("keeps UI server messages aligned with the worker protocol", () => {
    const workerTypes = extractServerMessageTypes(readSource(WORKER_WS_TYPES));
    const uiTypes = extractServerMessageTypes(readSource(UI_WS_TYPES)).filter((type) => type !== "pong");

    expect(uiTypes).toEqual(workerTypes);
  });

  it("keeps the versioned subscribed handshake aligned in both protocol copies", () => {
    const workerSource = readSource(WORKER_WS_TYPES);
    const uiSource = readSource(UI_WS_TYPES);

    expect(workerSource).toContain('type: "subscribed"');
    expect(workerSource).toContain("version: 2");
    expect(uiSource).toContain('type: "subscribed"');
    expect(uiSource).toContain("version: 2");
  });
});
