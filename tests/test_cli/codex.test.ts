import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock config so the commands see a logged-in state.
vi.mock("../../apps/cli/src/config", () => ({
  loadConfig: () => ({ apiUrl: "https://app.trycycloid.com", token: "arc_test_token" }),
  requireConfig: () => ({ apiUrl: "https://app.trycycloid.com", token: "arc_test_token" }),
}));

// Mock the Codex CLI subprocess so no real `codex` binary is required.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, rm: vi.fn(actual.rm) };
});

import { spawn } from "node:child_process";

import {
  codexLoginCommand,
  codexLogoutCommand,
  codexStatusCommand,
  codexUseCommand,
} from "../../apps/cli/src/commands/codex";

const AUTH_JSON = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"refresh"}}';
const ENABLED_URL = "https://app.trycycloid.com/api/settings/codex-subscription/enabled";
const AUTH_JSON_URL = "https://app.trycycloid.com/api/settings/codex-subscription/auth-json";

type FakeChild = EventEmitter;

let consoleOutput: string[];
let fetchCalls: Array<{ url: string; init?: RequestInit }>;

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    fetchCalls.push({ url: urlStr, init });
    return handler(urlStr, init);
  });
}

// Route stub responses by path so login/logout (which make two calls) can be
// asserted independently.
function stubByPath(responders: Record<string, () => Response>) {
  stubFetch((url) => {
    for (const [needle, make] of Object.entries(responders)) {
      if (url.includes(needle)) return make();
    }
    return new Response("{}");
  });
}

// Make the mocked spawn behave like a successful `codex login`: write the given
// auth.json into the temp CODEX_HOME the command created, then exit 0.
function spawnWritesAuthJson(contents: string | null): void {
  vi.mocked(spawn).mockImplementation(((
    _cmd: string,
    _args: readonly string[],
    options?: { env?: NodeJS.ProcessEnv },
  ) => {
    const child = new EventEmitter() as FakeChild;
    const codexHome = options?.env?.CODEX_HOME;
    queueMicrotask(() => {
      if (contents !== null && codexHome) writeFileSync(join(codexHome, "auth.json"), contents);
      child.emit("close", 0);
    });
    return child as unknown as ReturnType<typeof spawn>;
  }) as unknown as typeof spawn);
}

function spawnFails(code: number | null, errno?: NodeJS.ErrnoException): void {
  vi.mocked(spawn).mockImplementation((() => {
    const child = new EventEmitter() as FakeChild;
    queueMicrotask(() => {
      if (errno) child.emit("error", errno);
      else child.emit("close", code);
    });
    return child as unknown as ReturnType<typeof spawn>;
  }) as unknown as typeof spawn);
}

beforeEach(() => {
  consoleOutput = [];
  fetchCalls = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(spawn).mockReset();
});

describe("cycloid codex login", () => {
  it("uploads the auth.json then activates the subscription selector", async () => {
    spawnWritesAuthJson(AUTH_JSON);
    stubByPath({
      "/auth-json": () => new Response(JSON.stringify({ isSet: true, lastValidationStatus: "saved_unverified" })),
      "/enabled": () => new Response(JSON.stringify({ useCodexSubscription: true })),
    });

    await codexLoginCommand({}, undefined);

    expect(fetchCalls).toHaveLength(2);
    const put = fetchCalls.find((c) => c.url === AUTH_JSON_URL);
    expect(put?.init?.method).toBe("PUT");
    expect(JSON.parse(String(put?.init?.body))).toEqual({ authJson: AUTH_JSON });
    const enable = fetchCalls.find((c) => c.url === ENABLED_URL);
    expect(enable?.init?.method).toBe("PUT");
    expect(JSON.parse(String(enable?.init?.body))).toEqual({ enabled: true });
    expect(consoleOutput.join("\n")).toContain("saved and activated");
  });

  it("still succeeds (credential saved) when activation fails, and points at `codex use on`", async () => {
    spawnWritesAuthJson(AUTH_JSON);
    stubByPath({
      "/auth-json": () => new Response(JSON.stringify({ isSet: true })),
      "/enabled": () => new Response("nope", { status: 500 }),
    });

    await codexLoginCommand({}, undefined);

    const out = consoleOutput.join("\n");
    expect(out).toContain("Codex subscription auth saved.");
    expect(out).toContain("codex use on");
  });

  it("passes an isolated CODEX_HOME to the codex subprocess", async () => {
    spawnWritesAuthJson(AUTH_JSON);
    stubByPath({});

    await codexLoginCommand({}, undefined);

    const [, args, options] = vi.mocked(spawn).mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
    expect(args).toEqual(["login", "--device-auth"]);
    expect(options.env?.CODEX_HOME).toMatch(/cycloid-codex-/);
  });

  it("removes the temp CODEX_HOME when interrupted during auth upload", async () => {
    spawnWritesAuthJson(AUTH_JSON);
    let rejectUpload!: (reason?: unknown) => void;
    const stalledUpload = new Promise<Response>((_resolve, reject) => {
      rejectUpload = reject;
    });
    stubFetch((url) => {
      if (url === AUTH_JSON_URL) return stalledUpload;
      if (url === ENABLED_URL) return new Response(JSON.stringify({ useCodexSubscription: true }));
      return new Response("{}");
    });

    let sigintHandler: (() => void) | undefined;
    vi.spyOn(process, "on").mockImplementation(((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === "SIGINT") sigintHandler = listener as () => void;
      return process;
    }) as typeof process.on);
    const offSpy = vi.spyOn(process, "off").mockImplementation((() => process) as typeof process.off);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined as never) as typeof process.exit);

    const loginPromise = codexLoginCommand({}, undefined);

    await vi.waitFor(() => expect(fetchCalls.some((call) => call.url === AUTH_JSON_URL)).toBe(true));
    const [, , options] = vi.mocked(spawn).mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
    const codexHome = options.env?.CODEX_HOME;
    expect(codexHome).toBeTruthy();
    expect(existsSync(codexHome!)).toBe(true);
    expect(sigintHandler).toBeDefined();

    sigintHandler?.();

    expect(exitSpy).toHaveBeenCalledWith(130);
    expect(existsSync(codexHome!)).toBe(false);

    rejectUpload(new Error("interrupted"));
    await expect(loginPromise).rejects.toThrow(/interrupted/);
    expect(offSpy).toHaveBeenCalledWith("SIGINT", sigintHandler);
  });

  it("keeps the SIGINT handler registered until async temp-dir cleanup finishes", async () => {
    spawnWritesAuthJson(AUTH_JSON);
    stubByPath({
      "/auth-json": () => new Response(JSON.stringify({ isSet: true, lastValidationStatus: "saved_unverified" })),
      "/enabled": () => new Response(JSON.stringify({ useCodexSubscription: true })),
    });

    let finishCleanup!: () => void;
    const cleanupPending = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    vi.mocked(rm).mockImplementation((async (...args) => {
      await cleanupPending;
      return vi
        .importActual<typeof import("node:fs/promises")>("node:fs/promises")
        .then((actual) => actual.rm(...args));
    }) as typeof rm);

    const offSpy = vi.spyOn(process, "off").mockImplementation((() => process) as typeof process.off);

    const loginPromise = codexLoginCommand({}, undefined);

    await vi.waitFor(() => expect(vi.mocked(rm)).toHaveBeenCalled());
    expect(offSpy).not.toHaveBeenCalled();

    finishCleanup();
    await loginPromise;

    expect(offSpy).toHaveBeenCalledTimes(1);
    expect(offSpy.mock.calls[0]?.[0]).toBe("SIGINT");
  });

  it("honors --codex-path", async () => {
    spawnWritesAuthJson(AUTH_JSON);
    stubByPath({});

    await codexLoginCommand({ codexPath: "/opt/codex" }, undefined);

    expect(vi.mocked(spawn).mock.calls[0][0]).toBe("/opt/codex");
  });

  it("fails with a helpful error when the codex binary is missing", async () => {
    const enoent: NodeJS.ErrnoException = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
    spawnFails(null, enoent);
    stubByPath({});

    await expect(codexLoginCommand({}, undefined)).rejects.toThrow(/Could not find the `codex` executable/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("fails when codex login exits non-zero", async () => {
    spawnFails(1);
    stubByPath({});

    await expect(codexLoginCommand({}, undefined)).rejects.toThrow(/exited with code 1/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("fails when login succeeds but no auth.json was written", async () => {
    spawnWritesAuthJson(null);
    stubByPath({});

    await expect(codexLoginCommand({}, undefined)).rejects.toThrow(/no auth.json was written/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("does not upload an empty auth.json", async () => {
    spawnWritesAuthJson("   ");
    stubByPath({});

    await expect(codexLoginCommand({}, undefined)).rejects.toThrow(/empty auth.json/);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("cycloid codex status", () => {
  it("reports eligibility and saved state", async () => {
    stubFetch(() => new Response(JSON.stringify({ eligible: true, credential: { isSet: true } })));

    await codexStatusCommand({}, undefined);

    expect(fetchCalls[0].url).toBe("https://app.trycycloid.com/api/settings/codex-subscription");
    const out = consoleOutput.join("\n");
    expect(out).toContain("Eligible: yes");
    expect(out).toContain("Auth.json saved: yes");
  });
});

describe("cycloid codex logout", () => {
  it("deactivates the selector then clears the credential", async () => {
    stubByPath({
      "/enabled": () => new Response(JSON.stringify({ useCodexSubscription: false })),
      "/auth-json": () => new Response(JSON.stringify({ isSet: false })),
    });

    await codexLogoutCommand({}, undefined);

    const enable = fetchCalls.find((c) => c.url === ENABLED_URL);
    expect(enable?.init?.method).toBe("PUT");
    expect(JSON.parse(String(enable?.init?.body))).toEqual({ enabled: false });
    const del = fetchCalls.find((c) => c.url === AUTH_JSON_URL);
    expect(del?.init?.method).toBe("DELETE");
    expect(consoleOutput.join("\n")).toContain("deactivated and cleared");
  });

  it("still clears the credential when deactivation fails", async () => {
    stubByPath({
      "/enabled": () => new Response("nope", { status: 500 }),
      "/auth-json": () => new Response(JSON.stringify({ isSet: false })),
    });

    await codexLogoutCommand({}, undefined);

    expect(fetchCalls.find((c) => c.url === AUTH_JSON_URL)?.init?.method).toBe("DELETE");
    expect(consoleOutput.join("\n")).toContain("deactivated and cleared");
  });
});

describe("cycloid codex use", () => {
  it("turns the selector on", async () => {
    stubByPath({ "/enabled": () => new Response(JSON.stringify({ useCodexSubscription: true })) });

    await codexUseCommand("on", {}, undefined);

    const enable = fetchCalls.find((c) => c.url === ENABLED_URL);
    expect(enable?.init?.method).toBe("PUT");
    expect(JSON.parse(String(enable?.init?.body))).toEqual({ enabled: true });
    expect(consoleOutput.join("\n")).toContain("is now used");
  });

  it("turns the selector off", async () => {
    stubByPath({ "/enabled": () => new Response(JSON.stringify({ useCodexSubscription: false })) });

    await codexUseCommand("OFF", {}, undefined);

    expect(JSON.parse(String(fetchCalls[0].init?.body))).toEqual({ enabled: false });
    expect(consoleOutput.join("\n")).toContain("no longer used");
  });

  it("rejects an invalid state without calling the API", async () => {
    stubByPath({});
    await expect(codexUseCommand("maybe", {}, undefined)).rejects.toThrow(/on\|off/);
    expect(fetchCalls).toHaveLength(0);
  });
});
