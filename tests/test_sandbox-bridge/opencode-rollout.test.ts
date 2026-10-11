// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpencodeRuntimeAdapter } from "../../apps/sandbox-bridge/src/agent/opencode-runtime-adapter.js";

function makeLog() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
  return log;
}

function makeAdapter(log = makeLog()) {
  return new OpencodeRuntimeAdapter({
    getCwd: () => "/workspace",
    log,
    startupTimeoutMs: 1_000,
    withPromptActivityPulse: (_id, _phase, work) => work(),
    getSandboxToken: () => "tok",
    getRolloutUploadUrl: () => "https://cp.test/api/sessions/s1/rollout",
  });
}

let xdg: string;
let savedXdg: string | undefined;

beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), "oc-xdg-"));
  savedXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = xdg;
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdg;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function seedState(mtimeMs?: number) {
  mkdirSync(join(xdg, "opencode"), { recursive: true });
  const file = join(xdg, "opencode", "opencode.db");
  writeFileSync(file, "sqlite");
  if (mtimeMs !== undefined) {
    const mtime = new Date(mtimeMs);
    utimesSync(file, mtime, mtime);
  }
}

describe("OpencodeRuntimeAdapter persistSession", () => {
  it("uploads the opencode data dir once and skips when nothing changed", async () => {
    seedState();
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

  it("does not upload when there is no opencode state to persist", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const log = makeLog();
    await makeAdapter(log).persistSession(log);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("OpencodeRuntimeAdapter prepareSessionRestore", () => {
  it("cold-restores the rollout blob when no on-disk state exists", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(new Uint8Array([0]), { status: 200 }));
    // Extract is exercised by state-rollout.test; here we only assert the GET path fires.
    vi.stubGlobal("fetch", fetchSpy);
    const log = makeLog();
    await makeAdapter(log).prepareSessionRestore({ restorableSessionId: "ses_1", promptLog: log });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1].method).toBe("GET");
  });

  it("skips restore when on-disk state is already present (warm respawn)", async () => {
    seedState(Date.now());
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const log = makeLog();
    await makeAdapter(log).prepareSessionRestore({ restorableSessionId: "ses_1", promptLog: log });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "opencode_rollout.restore_skipped_local" }),
      expect.any(String),
    );
  });
});

describe("OpencodeRuntimeAdapter resumeSession", () => {
  it("reuses the prior session id and sets activeSessionId when the session resolves", async () => {
    const adapter = makeAdapter();
    const get = vi.fn().mockResolvedValue({ data: { id: "ses_prev" } });
    adapter.session.client = { session: { get } };

    const resumed = await adapter.resumeSession({
      restorableSessionId: "ses_prev",
      signal: new AbortController().signal,
      promptLog: makeLog(),
    });

    expect(resumed).toEqual({ sessionId: "ses_prev" });
    expect(get).toHaveBeenCalledWith({ path: { id: "ses_prev" } });
    // Without this, translateEvent throws on resume (createSessionForPrompt is skipped).
    expect(adapter.activeSessionId).toBe("ses_prev");
  });

  it("returns null (falls back to a fresh session) when the prior session is gone", async () => {
    const adapter = makeAdapter();
    adapter.session.client = { session: { get: vi.fn().mockRejectedValue(new Error("not found")) } };

    const resumed = await adapter.resumeSession({
      restorableSessionId: "ses_gone",
      signal: new AbortController().signal,
      promptLog: makeLog(),
    });

    expect(resumed).toBeNull();
    expect(adapter.activeSessionId).toBeNull();
  });

  it("warns and returns null when session.get resolves without a valid id", async () => {
    const adapter = makeAdapter();
    // Malformed-but-successful response (e.g. a changed SDK envelope): no id.
    adapter.session.client = { session: { get: vi.fn().mockResolvedValue({ data: {} }) } };
    const log = makeLog();

    const resumed = await adapter.resumeSession({
      restorableSessionId: "ses_bad",
      signal: new AbortController().signal,
      promptLog: log,
    });

    expect(resumed).toBeNull();
    expect(adapter.activeSessionId).toBeNull();
    // The degradation must be observable, not a silent fallthrough.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ restorableSessionId: "ses_bad" }),
      expect.stringContaining("no valid id"),
    );
  });
});
