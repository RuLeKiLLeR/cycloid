import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/cycloid-auth.mjs");

describe("cycloid-auth script", () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    for (const spy of spies.splice(0)) {
      spy.mockRestore();
    }
  });

  it("uses an explicit dogfood session token and does not print tokens", async () => {
    const { main } = (await import(SCRIPT_PATH)) as {
      main: (env: Record<string, string>, fetchImpl: typeof fetch) => Promise<void>;
    };
    const sessionToken = "dogfood-session-token";
    const tempDir = await mkdtemp(resolve(tmpdir(), "cycloid-auth-script-"));
    const statePath = resolve(tempDir, "storage-state.json");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    spies.push(logSpy, errorSpy);

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(input.toString());
      if (url.href === "http://127.0.0.1:5173/auth/status") {
        expect(init?.headers).toMatchObject({
          accept: "application/json",
          cookie: `session_token=${sessionToken}`,
        });
        return new Response(JSON.stringify({ authenticated: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch URL: ${url.href}`);
    });

    try {
      await main(
        {
          ARCANIST_BASE_URL: "http://127.0.0.1:5173",
          ARCANIST_AUTH_STATE_PATH: statePath,
          DOGFOOD_SESSION_TOKEN: sessionToken,
        },
        fetchImpl,
      );

      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      const storageState = JSON.parse(await readFile(statePath, "utf8"));
      expect(storageState.cookies).toContainEqual(
        expect.objectContaining({
          name: "session_token",
          value: sessionToken,
          httpOnly: true,
          sameSite: "Lax",
        }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses a configured dogfood session token and probes the validate URL", async () => {
    const { main } = (await import(SCRIPT_PATH)) as {
      main: (env: Record<string, string>, fetchImpl: typeof fetch) => Promise<void>;
    };
    const tempDir = await mkdtemp(resolve(tmpdir(), "cycloid-auth-script-"));
    const statePath = resolve(tempDir, "storage-state.json");
    const token = "dogfood-session-token";

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(input.toString());
      expect(init?.headers).toMatchObject({ cookie: `session_token=${token}` });
      if (url.href === "http://127.0.0.1:5173/auth/status") {
        return new Response(JSON.stringify({ authenticated: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.href === "http://127.0.0.1:5173/api/bootstrap") {
        return new Response(JSON.stringify({ authenticated: true, user: { login: "cycloid-dogfood" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch URL: ${url.href}`);
    });

    try {
      await main(
        {
          ARCANIST_BASE_URL: "http://127.0.0.1:5173",
          ARCANIST_AUTH_VALIDATE_URL: "http://127.0.0.1:5173/api/bootstrap",
          ARCANIST_AUTH_STATE_PATH: statePath,
          DOGFOOD_SESSION_TOKEN: token,
        },
        fetchImpl,
      );

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const storageState = JSON.parse(await readFile(statePath, "utf8"));
      expect(storageState.cookies).toContainEqual(expect.objectContaining({ value: token }));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["authenticated=false", { authenticated: false }],
    ["missing authenticated", {}],
  ])("rejects a validate URL that reports %s", async (_label, validateBody) => {
    const { main } = (await import(SCRIPT_PATH)) as {
      main: (env: Record<string, string>, fetchImpl: typeof fetch) => Promise<void>;
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input : new URL(input.toString());
      if (url.href.endsWith("/auth/status")) {
        return new Response(JSON.stringify({ authenticated: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(validateBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(
      main(
        {
          ARCANIST_BASE_URL: "http://127.0.0.1:5173",
          ARCANIST_AUTH_VALIDATE_URL: "http://127.0.0.1:5173/api/bootstrap",
          ARCANIST_AUTH_STATE_PATH: "/tmp/cycloid-auth-script/storage-state.json",
          DOGFOOD_SESSION_TOKEN: "dogfood-session-token",
        },
        fetchImpl,
      ),
    ).rejects.toThrow("auth validate probe rejected runtime session token");
  });

  it("requires an explicit dogfood session token instead of minting from sandbox auth", async () => {
    const { main } = (await import(SCRIPT_PATH)) as {
      main: (env: Record<string, string>, fetchImpl: typeof fetch) => Promise<void>;
    };
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      main(
        {
          ARCANIST_BASE_URL: "http://127.0.0.1:5173",
          ARCANIST_AUTH_STATE_PATH: "/tmp/cycloid-auth-script/storage-state.json",
          DOGFOOD_SESSION_TOKEN: "",
          SANDBOX_AUTH_TOKEN: "sandbox-auth-secret",
          SESSION_ID: "s-runtime-auth-script",
        },
        fetchImpl,
      ),
    ).rejects.toThrow("DOGFOOD_SESSION_TOKEN is required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
