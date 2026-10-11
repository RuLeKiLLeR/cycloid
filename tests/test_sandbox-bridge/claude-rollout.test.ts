// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClaudeCodeRuntimeAdapter } from "../../apps/sandbox-bridge/src/agent/claude-runtime-adapter.js";
import { ClaudeSessionManager } from "../../apps/sandbox-bridge/src/services/claude-session.js";
import { packStateSubtree } from "../../apps/sandbox-bridge/src/services/state-rollout.js";

function makeLog() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
  return log;
}

function makeAdapter(log = makeLog()) {
  return new ClaudeCodeRuntimeAdapter({
    getCwd: () => "/workspace",
    log,
    getSandboxToken: () => "tok",
    getRolloutUploadUrl: () => "https://cp.test/api/sessions/s1/rollout",
  });
}

function signal() {
  return new AbortController().signal;
}

let claudeHome;
let savedConfigDir;

beforeEach(() => {
  claudeHome = mkdtempSync(join(tmpdir(), "claude-config-"));
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function seedTranscript(mtimeMs?: number) {
  mkdirSync(join(claudeHome, "projects", "-workspace"), { recursive: true });
  const file = join(claudeHome, "projects", "-workspace", "sess-1.jsonl");
  writeFileSync(file, '{"turn":1}\n');
  if (mtimeMs !== undefined) {
    const mtime = new Date(mtimeMs);
    utimesSync(file, mtime, mtime);
  }
}

describe("ClaudeCodeRuntimeAdapter persistSession", () => {
  it("passes reasoning variants through to the Claude session manager", async () => {
    const dispatch = vi.spyOn(ClaudeSessionManager.prototype, "dispatch").mockResolvedValue(undefined);
    const log = makeLog();
    const adapter = makeAdapter(log);

    await adapter.sendPrompt(
      {
        parts: [{ type: "text", text: "hello" }],
        agent: "build",
        agentRole: "implementation",
        turnMode: "execute",
        model: "anthropic/claude-opus-4-8",
        variant: "high",
        summary: "auto",
      },
      { sessionId: "sess-1", signal: signal() },
    );

    expect(dispatch).toHaveBeenCalledWith(
      {
        parts: [{ type: "text", text: "hello" }],
        agent: "build",
        agentRole: "implementation",
        turnMode: "execute",
        model: "anthropic/claude-opus-4-8",
        variant: "high",
      },
      { sessionId: "sess-1", signal: expect.any(AbortSignal) },
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "agent_runtime.unsupported_capability" }),
      expect.any(String),
    );
  });

  it("uploads the projects subtree once and skips when nothing changed", async () => {
    seedTranscript();
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

    // No new transcript content: the mtime watermark skips the re-upload.
    await adapter.persistSession(log);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does nothing when there is no projects subtree", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const log = makeLog();
    await makeAdapter(log).persistSession(log);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never throws when the upload fails", async () => {
    seedTranscript();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const log = makeLog();
    await expect(makeAdapter(log).persistSession(log)).resolves.toBeUndefined();
  });

  it("retries an unchanged transcript mtime after a failed upload", async () => {
    const fixedMtime = 1_000_000_000;
    seedTranscript(fixedMtime);
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
});

describe("ClaudeCodeRuntimeAdapter prepareSessionRestore", () => {
  it("restores the projects subtree from the control plane before the query opens", async () => {
    // Pack a source home, then restore into the fresh CLAUDE_CONFIG_DIR.
    const src = mkdtempSync(join(tmpdir(), "claude-src-"));
    mkdirSync(join(src, "projects", "-workspace"), { recursive: true });
    writeFileSync(join(src, "projects", "-workspace", "sess-9.jsonl"), '{"turn":9}\n');
    const packed = await packStateSubtree(src, "projects");

    const fetchSpy = vi.fn().mockResolvedValue(new Response(new Uint8Array(packed), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const log = makeLog();
    await makeAdapter(log).prepareSessionRestore({ restorableSessionId: "sess-9", promptLog: log });
    expect(existsSync(join(claudeHome, "projects", "-workspace", "sess-9.jsonl"))).toBe(true);
  });

  it("skips the download entirely when on-disk transcripts already exist (warm respawn)", async () => {
    seedTranscript();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const log = makeLog();
    const adapter = makeAdapter(log);
    await adapter.prepareSessionRestore({ restorableSessionId: "sess-1", promptLog: log });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "claude_rollout.restore_skipped_local" }),
      expect.any(String),
    );

    // Watermark was seeded from the local mtime: no redundant re-upload.
    await adapter.persistSession(log);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("seeds the upload watermark after a successful restore (no redundant first upload)", async () => {
    const src = mkdtempSync(join(tmpdir(), "claude-src-"));
    mkdirSync(join(src, "projects", "-workspace"), { recursive: true });
    writeFileSync(join(src, "projects", "-workspace", "sess-2.jsonl"), '{"turn":2}\n');
    const packed = await packStateSubtree(src, "projects");

    const fetchSpy = vi.fn().mockResolvedValue(new Response(new Uint8Array(packed), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const log = makeLog();
    const adapter = makeAdapter(log);
    await adapter.prepareSessionRestore({ restorableSessionId: "sess-2", promptLog: log });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // the GET

    // Nothing changed since the restore: persistSession must not re-upload.
    await adapter.persistSession(log);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("warns (restore_missing) on 404 without failing the prompt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const log = makeLog();
    await expect(
      makeAdapter(log).prepareSessionRestore({ restorableSessionId: "sess-x", promptLog: log }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "claude_rollout.restore_missing" }),
      expect.any(String),
    );
  });
});

describe("ClaudeCodeRuntimeAdapter resumeSession", () => {
  it("returns null without marking resumable when the transcript is missing", async () => {
    const markResumable = vi.spyOn(ClaudeSessionManager.prototype, "markResumable");
    const log = makeLog();
    const adapter = makeAdapter(log);

    await expect(
      adapter.resumeSession({ restorableSessionId: "missing-session", signal: signal(), promptLog: log }),
    ).resolves.toBeNull();

    expect(markResumable).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ phase_status: "failed", restorableSessionId: "missing-session" }),
      expect.any(String),
    );
    adapter.shutdown();
  });

  it("marks the restored id resumable only when its transcript exists on disk", async () => {
    seedTranscript();
    const markResumable = vi.spyOn(ClaudeSessionManager.prototype, "markResumable");
    const log = makeLog();
    const adapter = makeAdapter(log);

    await expect(
      adapter.resumeSession({ restorableSessionId: "sess-1", signal: signal(), promptLog: log }),
    ).resolves.toEqual({ sessionId: "sess-1" });

    expect(markResumable).toHaveBeenCalledWith("sess-1");
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ phase_status: "completed", claudeSessionId: "sess-1" }),
      expect.any(String),
    );
    adapter.shutdown();
  });
});
