// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
// Isolated file: it mocks `child_process.spawn` to drive tar's exit code
// deterministically, which would break the real tar round-trip tests in
// state-rollout.test.ts — so it lives on its own.
import { EventEmitter } from "events";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({ spawn: vi.fn() }));
import { spawn } from "child_process";

import { packStateSubtree } from "../../apps/sandbox-bridge/src/services/state-rollout";

function makeFakeTarChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codex-home-pack-"));
  mkdirSync(join(home, "sessions", "2026", "06", "17"), { recursive: true });
  writeFileSync(join(home, "sessions", "2026", "06", "17", "rollout-x.jsonl"), '{"turn":1}\n');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("packStateSubtree tar exit tolerance", () => {
  it("tolerates tar exit 1 (file changed as we read it), reports it, and returns the archive", async () => {
    const child = makeFakeTarChild();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);
    const onFileChanged = vi.fn();

    // runTar attaches its stdout/close handlers synchronously inside the Promise
    // executor, so they are wired by the time packStateSubtree returns its promise.
    const packPromise = packStateSubtree(home, "sessions", onFileChanged);
    child.stdout.emit("data", Buffer.from([0x1f, 0x8b, 0x08])); // gzip-ish bytes
    child.emit("close", 1); // tar warns + exits 1 because the JSONL grew mid-pack

    const archive = await packPromise;
    expect(archive).not.toBeNull();
    expect(archive.length).toBeGreaterThan(0);
    // The file-changed tolerance is surfaced for observability.
    expect(onFileChanged).toHaveBeenCalledTimes(1);

    // The pack opts into file-changed tolerance via allowFileChanged.
    expect(spawn).toHaveBeenCalledWith("tar", ["czf", "-", "-C", home, "sessions"], expect.anything());
  });

  it("does not report file-changed on a clean exit 0", async () => {
    const child = makeFakeTarChild();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);
    const onFileChanged = vi.fn();

    const packPromise = packStateSubtree(home, "sessions", onFileChanged);
    child.stdout.emit("data", Buffer.from([0x1f, 0x8b, 0x08]));
    child.emit("close", 0);

    await packPromise;
    expect(onFileChanged).not.toHaveBeenCalled();
  });

  it("still rejects a fatal tar exit (code 2)", async () => {
    const child = makeFakeTarChild();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);

    const packPromise = packStateSubtree(home, "sessions");
    child.stderr.emit("data", Buffer.from("tar: fatal"));
    child.emit("close", 2);

    await expect(packPromise).rejects.toThrow(/tar exited 2/);
  });
});
