// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodexRuntimeAdapter } from "../../apps/sandbox-bridge/src/agent/agent-runtime-adapter.js";

function makeLog() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
  return log;
}

function makeAdapter(log = makeLog()) {
  return new CodexRuntimeAdapter({
    createCodex: vi.fn(),
    getCwd: () => "/workspace",
    log,
    startupTimeoutMs: 1_000,
    logResourceSnapshot: () => ({}),
    withPromptActivityPulse: (_id, _phase, work) => work(),
    getSandboxToken: () => "tok",
    getRolloutUploadUrl: () => "https://cp.test/api/sessions/s1/rollout",
  });
}

let codexHome;
let savedCodexHome;

beforeEach(() => {
  codexHome = mkdtempSync(join(tmpdir(), "codex-home-"));
  savedCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function seedSession(mtimeMs?: number) {
  mkdirSync(join(codexHome, "sessions", "2026", "06", "10"), { recursive: true });
  const file = join(codexHome, "sessions", "2026", "06", "10", "rollout-x.jsonl");
  writeFileSync(file, '{"turn":1}\n');
  if (mtimeMs !== undefined) {
    const mtime = new Date(mtimeMs);
    utimesSync(file, mtime, mtime);
  }
}

describe("CodexRuntimeAdapter persistSession", () => {
  it("uploads the sessions subtree once and skips when nothing changed", async () => {
    seedSession();
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const log = makeLog();
    const adapter = makeAdapter(log);
    await adapter.persistSession(log);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://cp.test/api/sessions/s1/rollout");
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("Bearer tok");

    await adapter.persistSession(log);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries an unchanged session mtime after a failed upload", async () => {
    const fixedMtime = 1_000_000_000;
    seedSession(fixedMtime);
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const log = makeLog();
    const adapter = makeAdapter(log);
    await adapter.persistSession(log);
    await adapter.persistSession(log);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("serializes overlapping persistSession calls — no concurrent PUTs to the rollout blob", async () => {
    seedSession(1_000_000_000);
    let concurrent = 0;
    let maxConcurrent = 0;
    const releases: Array<() => void> = [];
    const fetchSpy = vi.fn().mockImplementation(() => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return new Promise<Response>((resolve) => {
        releases.push(() => {
          concurrent--;
          resolve(new Response(null, { status: 200 }));
        });
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const log = makeLog();
    const adapter = makeAdapter(log);

    // First persist begins an upload that we hold open.
    const p1 = adapter.persistSession(log);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    // New rollout content + a second persist while the first PUT is still in flight.
    seedSession(1_000_000_000 + 5_000);
    const p2 = adapter.persistSession(log);

    // p2 is coalesced behind the in-flight upload: still exactly one PUT so far.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Release the first upload -> the coalesced trailing upload fires (mtime advanced).
    releases[0]();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    releases[1]();

    await Promise.all([p1, p2]);
    expect(maxConcurrent).toBe(1);
  });
});
