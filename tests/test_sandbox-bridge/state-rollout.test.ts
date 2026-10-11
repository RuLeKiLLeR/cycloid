import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acceptTarExit,
  createCoalescingPersister,
  extractStateArchive,
  newestStateMtimeMs,
  packStateSubtree,
  restoreStateRollout,
  uploadStateRollout,
} from "../../apps/sandbox-bridge/src/services/state-rollout";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Parameters<
  typeof uploadStateRollout
>[0]["log"];

function makeCodexHome(): string {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  mkdirSync(join(home, "sessions", "2026", "06", "02"), { recursive: true });
  writeFileSync(join(home, "sessions", "2026", "06", "02", "rollout-x.jsonl"), '{"turn":1}\n');
  writeFileSync(join(home, "auth.json"), '{"secret":"do-not-ship"}');
  return home;
}

function makeClaudeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "claude-home-"));
  mkdirSync(join(home, "projects", "-workspace-repo"), { recursive: true });
  writeFileSync(join(home, "projects", "-workspace-repo", "sess-1.jsonl"), '{"turn":1}\n');
  writeFileSync(join(home, ".credentials.json"), '{"secret":"do-not-ship"}');
  return home;
}

// Mirrors opencode's XDG data dir: session state (`opencode.db` + WAL sidecars,
// `snapshot/`, `storage/`) sharing one dir with credentials + regenerable bloat.
function makeOpencodeDataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "oc-xdg-"));
  const dir = join(root, "opencode");
  mkdirSync(join(dir, "snapshot"), { recursive: true });
  mkdirSync(join(dir, "storage"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "log"), { recursive: true });
  writeFileSync(join(dir, "opencode.db"), "sqlite");
  writeFileSync(join(dir, "opencode.db-wal"), "wal");
  writeFileSync(join(dir, "snapshot", "s1"), "snap");
  writeFileSync(join(dir, "storage", "m1.json"), "{}");
  writeFileSync(join(dir, "auth.json"), '{"secret":"do-not-ship"}');
  writeFileSync(join(dir, "bin", "rg"), "binary");
  writeFileSync(join(dir, "log", "run.log"), "logs");
  return root;
}

function codexPort(stateRoot: string, fetchImpl: unknown) {
  return {
    stateRoot,
    subdir: "sessions",
    eventPrefix: "codex_rollout",
    rolloutUrl: "https://cp.test/api/sessions/s1/rollout",
    getSandboxToken: () => "tok",
    fetch: fetchImpl as typeof fetch,
    log,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("packStateSubtree / extractStateArchive", () => {
  it("packs only the sessions subtree and round-trips, excluding auth.json", async () => {
    const home = makeCodexHome();
    const bytes = await packStateSubtree(home, "sessions");
    expect(bytes).not.toBeNull();

    const dest = mkdtempSync(join(tmpdir(), "codex-restore-"));
    await extractStateArchive(dest, new Uint8Array(bytes!));
    expect(existsSync(join(dest, "sessions", "2026", "06", "02", "rollout-x.jsonl"))).toBe(true);
    expect(existsSync(join(dest, "auth.json"))).toBe(false);
  });

  it("packs only the claude projects subtree, excluding credentials", async () => {
    const home = makeClaudeHome();
    const bytes = await packStateSubtree(home, "projects");
    expect(bytes).not.toBeNull();

    const dest = mkdtempSync(join(tmpdir(), "claude-restore-"));
    await extractStateArchive(dest, new Uint8Array(bytes!));
    expect(existsSync(join(dest, "projects", "-workspace-repo", "sess-1.jsonl"))).toBe(true);
    expect(existsSync(join(dest, ".credentials.json"))).toBe(false);
  });

  it("returns null when there is no subtree", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-empty-"));
    expect(await packStateSubtree(home, "sessions")).toBeNull();
  });

  it("packs the opencode data dir, excluding credentials + regenerable bloat", async () => {
    const root = makeOpencodeDataRoot();
    const bytes = await packStateSubtree(root, "opencode", undefined, ["auth.json", "bin", "log", "cache"]);
    expect(bytes).not.toBeNull();

    const dest = mkdtempSync(join(tmpdir(), "oc-restore-"));
    await extractStateArchive(dest, new Uint8Array(bytes!));
    // Session state round-trips.
    expect(existsSync(join(dest, "opencode", "opencode.db"))).toBe(true);
    expect(existsSync(join(dest, "opencode", "opencode.db-wal"))).toBe(true);
    expect(existsSync(join(dest, "opencode", "snapshot", "s1"))).toBe(true);
    expect(existsSync(join(dest, "opencode", "storage", "m1.json"))).toBe(true);
    // Credentials + bloat are excluded from the cross-sandbox archive.
    expect(existsSync(join(dest, "opencode", "auth.json"))).toBe(false);
    expect(existsSync(join(dest, "opencode", "bin"))).toBe(false);
    expect(existsSync(join(dest, "opencode", "log"))).toBe(false);
  });
});

describe("newestStateMtimeMs", () => {
  it("returns 0 when there is no subtree", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-empty-"));
    expect(newestStateMtimeMs(home, "sessions")).toBe(0);
  });

  it("advances when a rollout file is appended", () => {
    const home = makeCodexHome();
    const before = newestStateMtimeMs(home, "sessions");
    expect(before).toBeGreaterThan(0);
    const file = join(home, "sessions", "2026", "06", "02", "rollout-x.jsonl");
    const future = new Date(Date.now() + 5_000);
    writeFileSync(file, '{"turn":2}\n');
    utimesSync(file, future, future);
    expect(newestStateMtimeMs(home, "sessions")).toBeGreaterThan(before);
  });

  it("ignores excluded entries so a later credential/bloat write does not advance the watermark", () => {
    const home = mkdtempSync(join(tmpdir(), "opencode-mtime-"));
    mkdirSync(join(home, "opencode"), { recursive: true });
    const stateFile = join(home, "opencode", "opencode.db");
    writeFileSync(stateFile, "state");
    const stateMtime = newestStateMtimeMs(home, "opencode", ["auth.json"]);
    expect(stateMtime).toBeGreaterThan(0);
    // auth.json (excluded) written strictly later must not move the watermark.
    const authFile = join(home, "opencode", "auth.json");
    const future = new Date(Date.now() + 10_000);
    writeFileSync(authFile, "{}");
    utimesSync(authFile, future, future);
    expect(newestStateMtimeMs(home, "opencode", ["auth.json"])).toBe(stateMtime);
    // Without the exclude, the later auth.json write does advance it.
    expect(newestStateMtimeMs(home, "opencode")).toBeGreaterThan(stateMtime);
  });
});

describe("uploadStateRollout", () => {
  it("PUTs the packed rollout with a bearer token", async () => {
    const home = makeCodexHome();
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const uploaded = await uploadStateRollout(codexPort(home, fetchSpy));
    expect(uploaded).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("does not POST when there is no rollout to pack", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-empty-"));
    const fetchSpy = vi.fn();
    const uploaded = await uploadStateRollout(codexPort(home, fetchSpy));
    expect(uploaded).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never throws when the upload fails", async () => {
    const home = makeCodexHome();
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network"));
    await expect(uploadStateRollout(codexPort(home, fetchSpy))).resolves.toBe(false);
  });

  it("returns false when the control plane rejects the upload", async () => {
    const home = makeCodexHome();
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    await expect(uploadStateRollout(codexPort(home, fetchSpy))).resolves.toBe(false);
  });
});

describe("restoreStateRollout", () => {
  it("extracts a fetched rollout into the state root and returns true", async () => {
    const src = makeCodexHome();
    const packed = (await packStateSubtree(src, "sessions"))!;
    const dest = mkdtempSync(join(tmpdir(), "codex-cold-"));
    const fetchSpy = vi.fn().mockResolvedValue(new Response(new Uint8Array(packed), { status: 200 }));
    const restored = await restoreStateRollout(codexPort(dest, fetchSpy));
    expect(restored).toBe(true);
    expect(existsSync(join(dest, "sessions", "2026", "06", "02", "rollout-x.jsonl"))).toBe(true);
  });

  it("returns false on 404 without extracting", async () => {
    const dest = mkdtempSync(join(tmpdir(), "codex-cold-"));
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const restored = await restoreStateRollout(codexPort(dest, fetchSpy));
    expect(restored).toBe(false);
    expect(existsSync(join(dest, "sessions"))).toBe(false);
  });

  it("refuses an archive whose declared content-length exceeds the max buffer", async () => {
    const dest = mkdtempSync(join(tmpdir(), "codex-cold-"));
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(new Uint8Array(8), {
        status: 200,
        headers: { "content-length": String(512 * 1024 * 1024) },
      }),
    );
    const restored = await restoreStateRollout(codexPort(dest, fetchSpy));
    expect(restored).toBe(false);
    expect(existsSync(join(dest, "sessions"))).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "codex_rollout.restore_too_large" }),
      expect.any(String),
    );
  });
});

describe("acceptTarExit", () => {
  it("accepts exit 0 regardless of options", () => {
    expect(acceptTarExit(0)).toBe(true);
    expect(acceptTarExit(0, { allowFileChanged: true })).toBe(true);
  });

  it("accepts exit 1 only when file-changed is allowed (pack mode)", () => {
    expect(acceptTarExit(1)).toBe(false);
    expect(acceptTarExit(1, { allowFileChanged: false })).toBe(false);
    expect(acceptTarExit(1, { allowFileChanged: true })).toBe(true);
  });

  it("always rejects fatal/other codes", () => {
    expect(acceptTarExit(2, { allowFileChanged: true })).toBe(false);
    expect(acceptTarExit(137, { allowFileChanged: true })).toBe(false);
    expect(acceptTarExit(null, { allowFileChanged: true })).toBe(false);
  });
});

describe("createCoalescingPersister", () => {
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  it("runs at most one upload at a time and coalesces queued requests into one trailing run", async () => {
    const persist = createCoalescingPersister();
    let active = 0;
    let maxActive = 0;
    const ran: string[] = [];
    const gates: Array<ReturnType<typeof deferred>> = [];
    const makeRun = (label: string) => () => {
      ran.push(label);
      active++;
      maxActive = Math.max(maxActive, active);
      const g = deferred();
      gates.push(g);
      return g.promise.finally(() => {
        active--;
      });
    };

    // A starts immediately; B and C arrive while A is in flight.
    const pA = persist(makeRun("A"));
    const pB = persist(makeRun("B"));
    const pC = persist(makeRun("C"));
    await flush();
    expect(ran).toEqual(["A"]); // only A started; B/C are queued (coalesced)

    // A finishes -> the single trailing run executes the LATEST request (C), not B.
    gates[0].resolve();
    await flush();
    expect(ran).toEqual(["A", "C"]);
    expect(maxActive).toBe(1); // never two uploads concurrently

    gates[1].resolve();
    await Promise.all([pA, pB, pC]);
    expect(active).toBe(0);

    // After draining, a fresh request starts a new run rather than getting stuck.
    const pD = persist(makeRun("D"));
    await flush();
    expect(ran).toEqual(["A", "C", "D"]);
    gates[2].resolve();
    await pD;
  });

  it("swallows a run rejection so the serializer never rejects or wedges", async () => {
    const persist = createCoalescingPersister();
    const ran: string[] = [];
    await expect(
      persist(() => {
        ran.push("boom");
        return Promise.reject(new Error("upload failed"));
      }),
    ).resolves.toBeUndefined();
    // A later request still runs (the failed one did not wedge inFlight).
    await persist(() => {
      ran.push("ok");
      return Promise.resolve();
    });
    expect(ran).toEqual(["boom", "ok"]);
  });
});
