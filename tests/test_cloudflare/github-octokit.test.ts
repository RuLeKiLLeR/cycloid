import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetInstallationTokenSingleFlightForTest,
  createInstallationToken,
  createInstallationTokenForCloneToken,
  createScopedInstallationToken,
  ensurePkcs8,
  getAppInstallationCapabilities,
  getAppInstallationDetails,
  invalidateInstallationTokenCache,
  mintWithCiReadFallback,
  SANDBOX_GH_READONLY_TOKEN_PERMISSIONS,
  SANDBOX_INSTALLATION_TOKEN_PERMISSIONS,
  SANDBOX_REQUIRED_TOKEN_PERMISSIONS,
  sandboxGhReadonlyTokenScope,
  sandboxInstallationTokenScope,
  sandboxPushTokenScope,
} from "../../apps/control-plane-worker/src/github/octokit";

const mockGetInstallation = vi.hoisted(() => vi.fn());
const mockCreateInstallationAccessToken = vi.hoisted(() => vi.fn());

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    apps = {
      getInstallation: mockGetInstallation,
      createInstallationAccessToken: mockCreateInstallationAccessToken,
    };
  },
}));

// Test key pair generated with: openssl genrsa 2048 | openssl rsa -traditional
// Then converted: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt
const PKCS1_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAqlK3JHpOV3xCxtN7jY+DBqdx+G6/jjuaqLxZjlzmmRdMh7wx
J3q+bxknqB7RHXhmU9+e52G+YLGHSZOqgTo/TAQSgyyyOJhTx0tzFym7mcy7Tl0+
K/umCSXMww5RmPvVrOlibjBGeATfysekXY5/LcU+v0dIaGdS7Q5cBsnFAbYadctF
GNBX87BQQPjCyP/PW7ojmygQBXU7473jH4elz9p0dwGQIvPhC21x2JjkQQ9se0yl
G7oOoFTpBn/s5LMc5S6PeHbCciLynwE2NVvoHEUzmmVDh1R+wxSqVOtibaIqqcRj
pRsfNhKieRtzJ/kP+Z4k/jp/Ohdmn74Ink+/QwIDAQABAoIBAEcJX5wFrMX9LAar
7qSAfffY/4ZLfnYuctc8Uye2pHCmUINuIJwkK+e/OJR8YeAmNpt1sVs0n4fJkzDD
N0JVjk/AhQ4TprNHCO4ekD5RaA6B3n8VEZibiMjY7JlP0AV7x0cqQaTOWp20/ree
43UnuPBYi06QxujQazw2mHg2UAXhhN/5xyPi5QENeM9hdpmawSFqpj9LQzM1FIk8
xBCRQVZtyIZXX94M4P9FYircX0C2/VtSdkaCxY5ruysEDmrKipl97cvQZKWW5Kmc
BBoUM/GE4vlMyfvQAKwANnrxWC9sZ1Bg2N7AXjt6LkmypBJ2P0lF3ELAuYMMpuY6
JnJKOo0CgYEA0uiL01R8JlU8G6WLFXfcPv57BrlNHAIn0p/UQr7uIvLy3/gAb8AS
9uHpayM8hJWUjT2LAGmd+m1PVSc75OnNsXDpUwL3dpFhaCc66GXLfMOKMkR7jvyM
SRaN0l1C4Sm3R2VbaupgEioxQsVSGJYXZwagpuypi0i8clA29617ZR0CgYEAzrza
TVUZsP+8lyCZHtWelg1nud9MX368fL0NOkvhJ94nYCir4u24MkqcYyC5q4b9Eeqo
+3clmT5Kc+61NUURqPy2C2Ooh5lfzUArEFsyKWeWE3FPYeIh3ltIwggA0FfIE9q1
+Y/idSwOsBEPqQkYgPUAomXBaLe4qNxl6N10Z98CgYAC8dI58h0Fn/0F2crWUuUV
UBJBpsan1HPf4fFhuS6z+DZh4CGJbeIV5lOO9l/67ee0DR7qs47MF0ibRL/2UzlW
99+aFBmGY0M75AhThFBR/pzoVMJw3Z/LyW/Tdw/e+ukfKxAarwkGV+Z2KzEZPMc4
3gPSMM2xLyPKaMpLrPVjFQKBgGNu/8xMDwRLrEg/3IWxFwpyvh3vIYuYqE2SnCca
0dtcBTJBvZJy5bICor8mwUaXsWaJp+bywnm3NRYXjL5nTvwpN+G4eBloEmTk5RGD
21eAw/Tr/dNFcSbCXvc75DBQ2CF8gyPaKYBTxWi3fAHAJzH3JOv25xRXsRA+mSFs
Sg2fAoGBAIVuUptcYABYY0m+YAIWmJpGZidaC3fGX4ER8jK0bhoaAjbkJX8oPQzI
NW9o4k4EiZGk/X1UNvPaqhufVfDV7bNdonaLNHgauDg5QV1/8bJzOuj8QMfMpSAt
xQWCCT4vg30wcX/UNZdcOI0k9yy1f+9LIqfTADdfpMFzJcx8wrXE
-----END RSA PRIVATE KEY-----`;

const EXPECTED_PKCS8_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCqUrckek5XfELG
03uNj4MGp3H4br+OO5qovFmOXOaZF0yHvDEner5vGSeoHtEdeGZT357nYb5gsYdJ
k6qBOj9MBBKDLLI4mFPHS3MXKbuZzLtOXT4r+6YJJczDDlGY+9Ws6WJuMEZ4BN/K
x6Rdjn8txT6/R0hoZ1LtDlwGycUBthp1y0UY0FfzsFBA+MLI/89buiObKBAFdTvj
veMfh6XP2nR3AZAi8+ELbXHYmORBD2x7TKUbug6gVOkGf+zksxzlLo94dsJyIvKf
ATY1W+gcRTOaZUOHVH7DFKpU62JtoiqpxGOlGx82EqJ5G3Mn+Q/5niT+On86F2af
vgieT79DAgMBAAECggEARwlfnAWsxf0sBqvupIB999j/hkt+di5y1zxTJ7akcKZQ
g24gnCQr5784lHxh4CY2m3WxWzSfh8mTMMM3QlWOT8CFDhOms0cI7h6QPlFoDoHe
fxURmJuIyNjsmU/QBXvHRypBpM5anbT+t57jdSe48FiLTpDG6NBrPDaYeDZQBeGE
3/nHI+LlAQ14z2F2mZrBIWqmP0tDMzUUiTzEEJFBVm3Ihldf3gzg/0ViKtxfQLb9
W1J2RoLFjmu7KwQOasqKmX3ty9BkpZbkqZwEGhQz8YTi+UzJ+9AArAA2evFYL2xn
UGDY3sBeO3ouSbKkEnY/SUXcQsC5gwym5jomcko6jQKBgQDS6IvTVHwmVTwbpYsV
d9w+/nsGuU0cAifSn9RCvu4i8vLf+ABvwBL24elrIzyElZSNPYsAaZ36bU9VJzvk
6c2xcOlTAvd2kWFoJzroZct8w4oyRHuO/IxJFo3SXULhKbdHZVtq6mASKjFCxVIY
lhdnBqCm7KmLSLxyUDb3rXtlHQKBgQDOvNpNVRmw/7yXIJke1Z6WDWe530xffrx8
vQ06S+En3idgKKvi7bgySpxjILmrhv0R6qj7dyWZPkpz7rU1RRGo/LYLY6iHmV/N
QCsQWzIpZ5YTcU9h4iHeW0jCCADQV8gT2rX5j+J1LA6wEQ+pCRiA9QCiZcFot7io
3GXo3XRn3wKBgALx0jnyHQWf/QXZytZS5RVQEkGmxqfUc9/h8WG5LrP4NmHgIYlt
4hXmU472X/rt57QNHuqzjswXSJtEv/ZTOVb335oUGYZjQzvkCFOEUFH+nOhUwnDd
n8vJb9N3D9766R8rEBqvCQZX5nYrMRk8xzjeA9IwzbEvI8poykus9WMVAoGAY27/
zEwPBEusSD/chbEXCnK+He8hi5ioTZKcJxrR21wFMkG9knLlsgKivybBRpexZomn
5vLCebc1FheMvmdO/Ck34bh4GWgSZOTlEYPbV4DD9Ov900VxJsJe9zvkMFDYIXyD
I9opgFPFaLd8AcAnMfck6/bnFFexED6ZIWxKDZ8CgYEAhW5Sm1xgAFhjSb5gAhaY
mkZmJ1oLd8ZfgRHyMrRuGhoCNuQlfyg9DMg1b2jiTgSJkaT9fVQ289qqG59V8NXt
s12idos0eBq4ODlBXX/xsnM66PxAx8ylIC3FBYIJPi+DfTBxf9Q1l1w4jST3LLV/
70sip9MAN1+kwXMlzHzCtcQ=
-----END PRIVATE KEY-----`;

describe("ensurePkcs8", () => {
  it("converts PKCS#1 key to PKCS#8 format", () => {
    const result = ensurePkcs8(PKCS1_KEY);
    expect(result).toBe(EXPECTED_PKCS8_KEY);
  });

  it("returns PKCS#8 key unchanged", () => {
    const result = ensurePkcs8(EXPECTED_PKCS8_KEY);
    expect(result).toBe(EXPECTED_PKCS8_KEY);
  });

  it("returns empty string unchanged", () => {
    expect(ensurePkcs8("")).toBe("");
  });

  it("handles PKCS#1 key with literal \\n instead of newlines", () => {
    const singleLine = PKCS1_KEY.replace(/\n/g, "\\n");
    // ensurePkcs8 strips all whitespace from the base64, but the header check
    // still matches because \\n is not \s. The caller replaces \\n -> \n first.
    const normalized = singleLine.replace(/\\n/g, "\n");
    const result = ensurePkcs8(normalized);
    expect(result).toBe(EXPECTED_PKCS8_KEY);
  });
});

function makeKvEnv(): { env: never; store: Map<string, string>; puts: Array<{ key: string; ttl?: number }> } {
  const store = new Map<string, string>();
  const puts: Array<{ key: string; ttl?: number }> = [];
  const env = {
    REPOS_CACHE: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
        store.set(key, value);
        puts.push({ key, ttl: opts?.expirationTtl });
      },
      delete: async (key: string) => {
        store.delete(key);
      },
      list: async ({ prefix, cursor }: { prefix?: string; cursor?: string } = {}) => {
        void cursor;
        const keys = [...store.keys()]
          .filter((key) => (prefix ? key.startsWith(prefix) : true))
          .map((name) => ({ name }));
        return { keys, list_complete: true, cursor: undefined };
      },
    },
  } as never;
  return { env, store, puts };
}

describe("createInstallationToken caching", () => {
  beforeEach(() => {
    __resetInstallationTokenSingleFlightForTest();
  });

  it("mints once and serves the cached token on the second call", async () => {
    const { env } = makeKvEnv();
    const mint = vi.fn(async () => "tok-1");

    await expect(createInstallationToken(env, 123, mint)).resolves.toBe("tok-1");
    await expect(createInstallationToken(env, 123, mint)).resolves.toBe("tok-1");
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("caches with a sub-60-minute TTL so the token refreshes before expiry", async () => {
    const { env, puts } = makeKvEnv();
    await createInstallationToken(env, 123, async () => "tok-1");
    expect(puts).toHaveLength(1);
    expect(puts[0].ttl).toBeGreaterThan(0);
    expect(puts[0].ttl).toBeLessThan(60 * 60);
  });

  it("keys the cache per installation id", async () => {
    const { env } = makeKvEnv();
    await expect(createInstallationToken(env, 1, async () => "tok-a")).resolves.toBe("tok-a");
    await expect(createInstallationToken(env, 2, async () => "tok-b")).resolves.toBe("tok-b");
  });

  it("re-mints after the cache is invalidated", async () => {
    const { env } = makeKvEnv();
    let n = 0;
    const mint = vi.fn(async () => `tok-${++n}`);

    await expect(createInstallationToken(env, 123, mint)).resolves.toBe("tok-1");
    await invalidateInstallationTokenCache(env, 123);
    await expect(createInstallationToken(env, 123, mint)).resolves.toBe("tok-2");
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("mints when the cache read throws (KV outage must not block token access) and warns without the token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const env = {
        REPOS_CACHE: {
          get: async () => {
            throw new Error("kv get unavailable");
          },
          put: async () => {},
          delete: async () => {},
        },
      } as never;
      const mint = vi.fn(async () => "tok-secret-1");
      await expect(createInstallationToken(env, 123, mint)).resolves.toBe("tok-secret-1");
      expect(mint).toHaveBeenCalledTimes(1);

      const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("installation_token_cache_get_failed");
      expect(logged).not.toContain("tok-secret-1");
      // Must not carry an `error` key: the worker logger escalates any warn with
      // one to the registered error handler (Sentry/Datadog). Best-effort KV
      // blips must not page.
      expect(logged).not.toContain('"error"');
      expect(logged).toContain("kvError");
    } finally {
      warn.mockRestore();
    }
  });

  it("returns the minted token when the cache write throws and warns without the token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const env = {
        REPOS_CACHE: {
          get: async () => null,
          put: async () => {
            throw new Error("kv put unavailable");
          },
          delete: async () => {},
        },
      } as never;
      await expect(createInstallationToken(env, 123, async () => "tok-secret-2")).resolves.toBe("tok-secret-2");

      const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("installation_token_cache_put_failed");
      expect(logged).not.toContain("tok-secret-2");
      // See get-failure test: no `error` key, so no error-handler escalation.
      expect(logged).not.toContain('"error"');
      expect(logged).toContain("kvError");
    } finally {
      warn.mockRestore();
    }
  });

  it("collapses concurrent same-id callers onto one KV read + one mint + one KV write", async () => {
    const { env, store, puts } = makeKvEnv();
    const getSpy = vi.spyOn(store, "get");

    let resolveMint!: (v: string) => void;
    const mint = vi.fn(
      () =>
        new Promise<string>((res) => {
          resolveMint = res;
        }),
    );

    const a = createInstallationToken(env, 123, mint);
    const b = createInstallationToken(env, 123, mint);
    // Let the shared flight reach mint() (one KV read happens first). Both
    // callers are in flight before the mint settles.
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));

    resolveMint("tok-shared");
    await expect(a).resolves.toBe("tok-shared");
    await expect(b).resolves.toBe("tok-shared");

    expect(mint).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(puts).toHaveLength(1);
  });

  it("shares a live mint across an invalidation window without serving a stale cached value", async () => {
    const { env } = makeKvEnv();

    let resolveMint!: (v: string) => void;
    const mint = vi.fn(
      () =>
        new Promise<string>((res) => {
          resolveMint = res;
        }),
    );

    // Caller A starts a slow mint; invalidate runs while it is in flight; caller
    // B arrives before A settles and shares A's live mint (not a cached value).
    const a = createInstallationToken(env, 123, mint);
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
    await invalidateInstallationTokenCache(env, 123);
    const b = createInstallationToken(env, 123, mint);
    // B shares A's still-in-flight live mint rather than starting its own.
    expect(mint).toHaveBeenCalledTimes(1);

    resolveMint("tok-live");
    await expect(a).resolves.toBe("tok-live");
    await expect(b).resolves.toBe("tok-live");

    // After settle, a fresh mint runs again (no retained in-flight state).
    await invalidateInstallationTokenCache(env, 123);
    const next = vi.fn(async () => "tok-next");
    await expect(createInstallationToken(env, 123, next)).resolves.toBe("tok-next");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("skips the KV write when an invalidation lands during an in-flight mint, then re-mints next call", async () => {
    const { env, store, puts } = makeKvEnv();

    let resolveMint!: (v: string) => void;
    const mint = vi.fn(
      () =>
        new Promise<string>((res) => {
          resolveMint = res;
        }),
    );

    // A mint is in flight when a grant-change webhook invalidates the cache.
    const a = createInstallationToken(env, 123, mint);
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
    await invalidateInstallationTokenCache(env, 123);
    resolveMint("tok-mid-invalidation");

    // The caller still receives its freshly minted token...
    await expect(a).resolves.toBe("tok-mid-invalidation");
    // ...but the post-invalidation token is NOT written back to KV (writing it
    // would undo the delete and cache a token minted around the grant change).
    expect(puts).toHaveLength(0);
    expect(store.has("github-installation-token:123")).toBe(false);

    // Because KV was never repopulated, the next call mints fresh rather than
    // serving the skipped token.
    const fresh = vi.fn(async () => "tok-fresh");
    await expect(createInstallationToken(env, 123, fresh)).resolves.toBe("tok-fresh");
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("scopes the write-guard per installation id (invalidating another id does not skip this write)", async () => {
    const { env, puts } = makeKvEnv();

    let resolveMint!: (v: string) => void;
    const mint = vi.fn(
      () =>
        new Promise<string>((res) => {
          resolveMint = res;
        }),
    );

    const a = createInstallationToken(env, 1, mint);
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
    // Invalidate a different installation while id 1's mint is in flight.
    await invalidateInstallationTokenCache(env, 2);
    resolveMint("tok-1");

    await expect(a).resolves.toBe("tok-1");
    // id 1's generation was untouched, so its write still lands.
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toBe("github-installation-token:1");
  });
});

describe("createInstallationTokenForCloneToken", () => {
  const env = {} as never;
  const scope = { repositories: ["repo-a"], permissions: { contents: "write" } };

  it("aborts a timed-out mint and succeeds on the retry", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const firstSignalAbortedBeforeRetry: boolean[] = [];
      const mint = vi.fn((signal: AbortSignal): Promise<string> => {
        signals.push(signal);
        if (signals.length === 1) {
          // Hang until the wrapper's timeout aborts this attempt.
          return new Promise<string>((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("mint aborted")));
          });
        }
        firstSignalAbortedBeforeRetry.push(signals[0].aborted);
        return Promise.resolve("fresh-token");
      });

      const resultPromise = createInstallationTokenForCloneToken(env, 123, scope, mint);
      await vi.advanceTimersByTimeAsync(4_000);

      await expect(resultPromise).resolves.toBe("fresh-token");
      expect(mint).toHaveBeenCalledTimes(2);
      // The timed-out attempt's signal is aborted before the retry starts, so
      // the slow mint cannot keep running behind the retry.
      expect(firstSignalAbortedBeforeRetry).toEqual([true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the token from a first attempt that succeeds immediately", async () => {
    const mint = vi.fn(async (_signal: AbortSignal): Promise<string> => "fresh-token");

    await expect(createInstallationTokenForCloneToken(env, 123, scope, mint)).resolves.toBe("fresh-token");
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("does not retry a definitive non-timeout failure", async () => {
    const mint = vi.fn(async (_signal: AbortSignal): Promise<string> => {
      throw new Error("github mint unavailable (401)");
    });

    await expect(createInstallationTokenForCloneToken(env, 123, scope, mint)).rejects.toThrow(
      "github mint unavailable (401)",
    );
    // Non-timeout errors are definitive: surface attempt 1's error, no retry.
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("surfaces the retry's error when the first attempt times out and the retry fails", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const mint = vi.fn((signal: AbortSignal): Promise<string> => {
        calls++;
        if (calls === 1) {
          return new Promise<string>((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("mint aborted")));
          });
        }
        return Promise.reject(new Error("retry failed"));
      });

      const resultPromise = createInstallationTokenForCloneToken(env, 123, scope, mint);
      resultPromise.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(4_000);

      await expect(resultPromise).rejects.toThrow("retry failed");
      expect(mint).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sandboxInstallationTokenScope (guardrail: never installation-wide)", () => {
  it("scopes to exactly the one target repo with the minimal sandbox permissions", () => {
    const scope = sandboxInstallationTokenScope("target-repo");
    // The sandbox clone/push token path must always request a repository list:
    // a regression that drops this would silently mint an installation-wide token.
    expect(scope.repositories).toEqual(["target-repo"]);
    expect(scope.repositories).toHaveLength(1);
    expect(scope.permissions).toEqual(SANDBOX_INSTALLATION_TOKEN_PERMISSIONS);
    // PR/issue/check/actions mutation stays server-side, so the sandbox token must not
    // carry write beyond contents. CI read lets the agent self-diagnose failing CI
    // without any write escalation.
    expect(scope.permissions.pull_requests).toBe("read");
    // `gh pr checks` reads GitHub's statusCheckRollup, which includes both CheckRun
    // nodes and classic StatusContext nodes. `checks:read` alone is not enough.
    expect(scope.permissions.checks).toBe("read");
    expect(scope.permissions.statuses).toBe("read");
    expect(scope.permissions.actions).toBe("read");
    expect(scope.permissions).not.toHaveProperty("issues");
    // Guardrail: contents is the ONLY write scope; nothing else may be write.
    const writeScopes = Object.entries(scope.permissions)
      .filter(([, level]) => level === "write")
      .map(([name]) => name);
    expect(writeScopes).toEqual(["contents"]);
    // `workflows:write` lives only on the push scope, never on clone scope.
    expect(scope.permissions).not.toHaveProperty("workflows");
  });
});

describe("sandboxGhReadonlyTokenScope (guardrail: read-only, no write scopes)", () => {
  it("scopes to exactly the one target repo with no write permissions", () => {
    const scope = sandboxGhReadonlyTokenScope("target-repo");
    // Single-repo scoping, same as the clone/gh path: never installation-wide.
    expect(scope.repositories).toEqual(["target-repo"]);
    expect(scope.repositories).toHaveLength(1);
    expect(scope.permissions).toEqual(SANDBOX_GH_READONLY_TOKEN_PERMISSIONS);
    // The agent's gh only ever reads (PRs are opened server-side; the gh wrapper
    // blocks mutating subcommands). This token lands in a file the agent can read,
    // so it must carry NO write scope at all -- otherwise a prompt-injection foothold
    // could exfiltrate it and push/mutate directly, bypassing the wrapper.
    expect(scope.permissions.contents).toBe("read");
    expect(scope.permissions.pull_requests).toBe("read");
    // CI reads let the agent self-diagnose failing CI without any write escalation.
    expect(scope.permissions.checks).toBe("read");
    expect(scope.permissions.statuses).toBe("read");
    expect(scope.permissions.actions).toBe("read");
    const writeScopes = Object.entries(scope.permissions)
      .filter(([, level]) => level === "write")
      .map(([name]) => name);
    expect(writeScopes).toEqual([]);
    expect(scope.permissions).not.toHaveProperty("workflows");
    expect(scope.permissions).not.toHaveProperty("issues");
  });

  it("degrades to the read-only required subset (never write) when CI reads are ungranted", async () => {
    // mintWithCiReadFallback keeps the desired VALUE while filtering by KEY, so the
    // read-only scope must fall back to contents:read + pull_requests:read -- proving
    // an ungranted-CI degrade cannot silently reintroduce contents:write.
    const scope = sandboxGhReadonlyTokenScope("target-repo");
    const result = await mintWithCiReadFallback("42" as unknown as number, scope.permissions, async (permissions) => {
      if ("checks" in permissions) {
        throw Object.assign(new Error("The permissions requested are not granted to this installation."), {
          status: 422,
        });
      }
      return "ghs_readonly_token";
    });
    expect(result.token).toBe("ghs_readonly_token");
    expect(result.permissions.contents).toBe("read");
    expect(Object.values(result.permissions)).not.toContain("write");
  });
});

describe("sandboxPushTokenScope (push path carries workflows:write)", () => {
  it("scopes to the one target repo with the minimal set plus workflows:write", () => {
    const scope = sandboxPushTokenScope("target-repo");
    expect(scope.repositories).toEqual(["target-repo"]);
    expect(scope.repositories).toHaveLength(1);
    // Push needs `contents:write` to push and `workflows:write` to push under
    // `.github/workflows/**`; it must not over-grant beyond that.
    expect(scope.permissions.contents).toBe("write");
    expect(scope.permissions.workflows).toBe("write");
    expect(scope.permissions.pull_requests).toBe("read");
    expect(scope.permissions.checks).toBe("read");
    expect(scope.permissions.statuses).toBe("read");
    expect(scope.permissions.actions).toBe("read");
    expect(scope.permissions).not.toHaveProperty("issues");
  });

  it("is exactly the clone/gh scope plus workflows:write (the only added permission)", () => {
    const cloneScope = sandboxInstallationTokenScope("target-repo");
    const pushScope = sandboxPushTokenScope("target-repo");
    expect(pushScope.permissions).toEqual({ ...cloneScope.permissions, workflows: "write" });
  });
});

describe("mintWithCiReadFallback (CI read scope degrades until App grant lands)", () => {
  const permissionError = Object.assign(new Error("The permissions requested are not granted to this installation."), {
    status: 422,
  });

  it("returns the full-scope token when the App has granted CI read", async () => {
    const mintWith = vi.fn().mockResolvedValue("full-tok");
    await expect(mintWithCiReadFallback(123, { ...SANDBOX_INSTALLATION_TOKEN_PERMISSIONS }, mintWith)).resolves.toEqual(
      { token: "full-tok", permissions: SANDBOX_INSTALLATION_TOKEN_PERMISSIONS },
    );
    expect(mintWith).toHaveBeenCalledTimes(1);
    expect(mintWith).toHaveBeenCalledWith(SANDBOX_INSTALLATION_TOKEN_PERMISSIONS);
  });

  it("retries with only the required subset when CI read isn't granted (422)", async () => {
    const mintWith = vi.fn().mockRejectedValueOnce(permissionError).mockResolvedValueOnce("degraded-tok");
    await expect(mintWithCiReadFallback(123, { ...SANDBOX_INSTALLATION_TOKEN_PERMISSIONS }, mintWith)).resolves.toEqual(
      { token: "degraded-tok", permissions: SANDBOX_REQUIRED_TOKEN_PERMISSIONS },
    );
    expect(mintWith).toHaveBeenCalledTimes(2);
    // Second call drops checks/statuses/actions, keeping exactly the required write/read subset.
    expect(mintWith.mock.calls[1][0]).toEqual(SANDBOX_REQUIRED_TOKEN_PERMISSIONS);
  });

  it("propagates a 422 when nothing extra can be dropped (required subset itself rejected)", async () => {
    const mintWith = vi.fn().mockRejectedValue(permissionError);
    await expect(mintWithCiReadFallback(123, { ...SANDBOX_REQUIRED_TOKEN_PERMISSIONS }, mintWith)).rejects.toBe(
      permissionError,
    );
    expect(mintWith).toHaveBeenCalledTimes(1);
  });

  it("does not fall back for a 422 whose message is not the exact missing-grant response", async () => {
    const validation = Object.assign(new Error("Validation Failed"), { status: 422 });
    const mintWith = vi.fn().mockRejectedValue(validation);
    await expect(mintWithCiReadFallback(123, { ...SANDBOX_INSTALLATION_TOKEN_PERMISSIONS }, mintWith)).rejects.toBe(
      validation,
    );
    expect(mintWith).toHaveBeenCalledTimes(1);
  });

  it("does not fall back for non-permission errors (transient/auth)", async () => {
    const transient = Object.assign(new Error("gateway timeout"), { status: 504 });
    const mintWith = vi.fn().mockRejectedValue(transient);
    await expect(mintWithCiReadFallback(123, { ...SANDBOX_INSTALLATION_TOKEN_PERMISSIONS }, mintWith)).rejects.toBe(
      transient,
    );
    expect(mintWith).toHaveBeenCalledTimes(1);
  });
});

describe("createScopedInstallationToken", () => {
  beforeEach(() => {
    __resetInstallationTokenSingleFlightForTest();
    mockCreateInstallationAccessToken.mockReset();
  });

  it("requests the scoped repositories + permissions from GitHub (not installation-wide)", async () => {
    const { env } = makeKvEnv();
    mockCreateInstallationAccessToken.mockResolvedValue({ data: { token: "scoped-tok" } });

    await expect(createScopedInstallationToken(env, 123, sandboxInstallationTokenScope("target-repo"))).resolves.toBe(
      "scoped-tok",
    );

    expect(mockCreateInstallationAccessToken).toHaveBeenCalledTimes(1);
    expect(mockCreateInstallationAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        installation_id: 123,
        repositories: ["target-repo"],
        permissions: SANDBOX_INSTALLATION_TOKEN_PERMISSIONS,
      }),
    );
  });

  it("keys the cache by repo + permissions so a repo-A token is never served to a repo-B request", async () => {
    const { env, store, puts } = makeKvEnv();
    await expect(
      createScopedInstallationToken(env, 123, sandboxInstallationTokenScope("repo-a"), async () => "tok-a"),
    ).resolves.toBe("tok-a");
    await expect(
      createScopedInstallationToken(env, 123, sandboxInstallationTokenScope("repo-b"), async () => "tok-b"),
    ).resolves.toBe("tok-b");

    // Two repos under one installation => two distinct cache entries, distinct mints.
    expect(puts).toHaveLength(2);
    const keys = puts.map((p) => p.key);
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) {
      expect(key).toContain("repos=");
      expect(key).toContain("perms=");
    }
    // The repo-A entry must never satisfy a repo-B read.
    expect([...store.keys()].some((k) => k.includes("repos=repo-a"))).toBe(true);
    expect([...store.keys()].some((k) => k.includes("repos=repo-b"))).toBe(true);
  });

  it("serves the cached scoped token on a repeated same-scope request", async () => {
    const { env } = makeKvEnv();
    const mint = vi.fn(async () => "tok-cached");
    await expect(createScopedInstallationToken(env, 123, sandboxInstallationTokenScope("repo-a"), mint)).resolves.toBe(
      "tok-cached",
    );
    await expect(createScopedInstallationToken(env, 123, sandboxInstallationTokenScope("repo-a"), mint)).resolves.toBe(
      "tok-cached",
    );
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("does not cache a downgraded CI-read mint under the full permission key", async () => {
    const { env, store } = makeKvEnv();
    const permissionError = Object.assign(
      new Error("The permissions requested are not granted to this installation."),
      {
        status: 422,
      },
    );
    mockCreateInstallationAccessToken
      .mockRejectedValueOnce(permissionError)
      .mockResolvedValueOnce({ data: { token: "degraded-tok" } })
      .mockResolvedValueOnce({ data: { token: "full-tok" } });

    await expect(createScopedInstallationToken(env, 123, sandboxInstallationTokenScope("repo-a"))).resolves.toBe(
      "degraded-tok",
    );

    const cachedKeys = [...store.keys()];
    const degradedKey = cachedKeys.find(
      (key) =>
        key.includes("repos=repo-a") &&
        key.includes("contents=write") &&
        key.includes("pull_requests=read") &&
        !key.includes("checks=read") &&
        !key.includes("statuses=read") &&
        !key.includes("actions=read"),
    );
    expect(degradedKey).toBeDefined();
    expect(store.get(degradedKey as string)).toBe("degraded-tok");
    expect(
      cachedKeys.some(
        (key) => key.includes("checks=read") || key.includes("statuses=read") || key.includes("actions=read"),
      ),
    ).toBe(false);

    await expect(createScopedInstallationToken(env, 123, sandboxInstallationTokenScope("repo-a"))).resolves.toBe(
      "full-tok",
    );
    expect(mockCreateInstallationAccessToken).toHaveBeenCalledTimes(3);
  });

  it("does not collide with the unscoped installation-wide cache entry", async () => {
    const { env, store } = makeKvEnv();
    await createInstallationToken(env, 123, async () => "wide-tok");
    await createScopedInstallationToken(env, 123, sandboxInstallationTokenScope("repo-a"), async () => "scoped-tok");

    expect(store.get("github-installation-token:123")).toBe("wide-tok");
    const scopedKey = [...store.keys()].find((k) => k.includes("repos=repo-a"));
    expect(scopedKey).toBeDefined();
    expect(store.get(scopedKey as string)).toBe("scoped-tok");
  });

  it("invalidation clears the unscoped AND every scoped entry for the installation (repo-removal must not leave a stale scoped token)", async () => {
    const { env, store } = makeKvEnv();
    await createInstallationToken(env, 123, async () => "wide-tok");
    await createScopedInstallationToken(env, 123, sandboxInstallationTokenScope("repo-a"), async () => "tok-a");
    await createScopedInstallationToken(env, 123, sandboxInstallationTokenScope("repo-b"), async () => "tok-b");
    // A different installation's scoped entry must survive (prefix is colon-delimited).
    await createScopedInstallationToken(env, 1234, sandboxInstallationTokenScope("repo-a"), async () => "other-tok");

    await invalidateInstallationTokenCache(env, 123);

    // Both the unscoped (exact) and every scoped (`:123:` prefix) entry are gone.
    const keys123 = [...store.keys()].filter(
      (k) => k === "github-installation-token:123" || k.startsWith("github-installation-token:123:"),
    );
    expect(keys123).toHaveLength(0);
    // installation 1234 (prefix-adjacent) is untouched.
    expect([...store.keys()].some((k) => k.startsWith("github-installation-token:1234"))).toBe(true);

    // Next scoped mint after invalidation re-hits GitHub rather than serving the dropped entry.
    const remint = vi.fn(async () => "tok-a2");
    await expect(
      createScopedInstallationToken(env, 123, sandboxInstallationTokenScope("repo-a"), remint),
    ).resolves.toBe("tok-a2");
    expect(remint).toHaveBeenCalledTimes(1);
  });
});

describe("GitHub installation owner type mapping", () => {
  beforeEach(() => {
    mockGetInstallation.mockReset();
  });

  it("uses installation target_type when capabilities account is null", async () => {
    mockGetInstallation.mockResolvedValue({
      data: {
        id: 123,
        account: null,
        target_type: "User",
        repository_selection: "all",
        permissions: { contents: "write" },
        events: ["pull_request"],
      },
    });

    const result = await getAppInstallationCapabilities(
      { GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: EXPECTED_PKCS8_KEY },
      123,
    );

    expect(result).toMatchObject({
      installationId: 123,
      ownerLogin: "",
      ownerId: 0,
      ownerType: "User",
      repositorySelection: "all",
      permissions: { contents: "write" },
      events: ["pull_request"],
    });
  });

  it("uses installation target_type for details when account.type is absent", async () => {
    mockGetInstallation.mockResolvedValue({
      data: {
        id: 456,
        account: { login: "octocat", id: 99 },
        target_type: "User",
        repository_selection: "selected",
        permissions: { metadata: "read" },
        events: ["status"],
      },
    });

    const result = await getAppInstallationDetails(
      {
        GITHUB_APP_ID: "1",
        GITHUB_PRIVATE_KEY: EXPECTED_PKCS8_KEY,
      } as never,
      456,
    );

    expect(result).toMatchObject({
      installationId: 456,
      ownerLogin: "octocat",
      ownerId: 99,
      ownerType: "User",
      repositorySelection: "selected",
      permissions: { metadata: "read" },
      events: ["status"],
    });
  });
});
