// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  buildAgentGhHostsYaml,
  buildAgentGitConfig,
  buildGithubTokenUrl,
  refreshAgentGhAuth,
  runWriteAgentGhAuth,
  writeAgentGhAuthConfig,
} from "../../apps/sandbox-bridge/src/utils/agent-gh-auth.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cycloid-gh-auth-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("buildAgentGhHostsYaml", () => {
  it("produces gh's insecure-storage format (top-level + users-map oauth_token) so gh does not migrate to the keyring", () => {
    const parsed = parseYaml(buildAgentGhHostsYaml("ghs_readonly_abc123"));
    const host = parsed["github.com"];
    expect(host.git_protocol).toBe("https");
    // The oauth_token must be reachable under the active user so gh uses it for API calls.
    expect(host.users[host.user].oauth_token).toBe("ghs_readonly_abc123");
    // AND at the top level: gh 2.x treats a users-map-only config as pre-migration and
    // tries to move the token into the OS keyring (dbus/secret-service), which the
    // headless sandbox lacks. gh's own --insecure-storage writes it in both places.
    expect(host.oauth_token).toBe("ghs_readonly_abc123");
  });
});

describe("writeAgentGhAuthConfig", () => {
  it("writes $HOME/.config/gh/hosts.yml (0600) so the agent's real gh can read it", () => {
    const result = writeAgentGhAuthConfig({ token: "ghs_readonly_abc123", homeDir: home });
    expect(result.written).toBe(true);
    const hostsPath = join(home, ".config", "gh", "hosts.yml");
    expect(result.path).toBe(hostsPath);
    const parsed = parseYaml(readFileSync(hostsPath, "utf8"));
    expect(parsed["github.com"].users[parsed["github.com"].user].oauth_token).toBe("ghs_readonly_abc123");
    // Token file must not be world/group readable.
    expect(statSync(hostsPath).mode & 0o077).toBe(0);
  });

  it("writes a versioned config.yml so gh skips its keyring migration (which needs dbus)", () => {
    writeAgentGhAuthConfig({ token: "ghs_readonly_abc123", homeDir: home });
    const configPath = join(home, ".config", "gh", "config.yml");
    const parsed = parseYaml(readFileSync(configPath, "utf8"));
    // A present schema `version` marks migrations as already applied, so gh does not run
    // the multi-account/secure-storage migration on load.
    expect(parsed.version).toBeDefined();
    expect(statSync(configPath).mode & 0o077).toBe(0);
  });

  it("writes an absolute real-gh credential helper with a leading reset", () => {
    writeAgentGhAuthConfig({ token: "ghs_readonly_abc123", homeDir: home, realGhPath: "/real/bin/gh" });
    const gitConfig = readFileSync(join(home, ".gitconfig"), "utf8");
    expect(gitConfig).toContain('[credential "https://github.com"]');
    expect(gitConfig).toContain("helper =\n");
    expect(gitConfig).toContain("helper = !/real/bin/gh auth git-credential");
    expect(statSync(join(home, ".gitconfig")).mode & 0o077).toBe(0);
    expect(buildAgentGitConfig("/real/bin/gh")).not.toContain("ghs_");
  });

  it("fails closed on an empty token (never writes an unauthenticated config)", () => {
    const result = writeAgentGhAuthConfig({ token: "   ", homeDir: home });
    expect(result.written).toBe(false);
    expect(result.reason).toBe("empty_token");
  });

  it("fails closed on a malformed token (YAML-hostile chars) instead of corrupting hosts.yml", () => {
    const result = writeAgentGhAuthConfig({ token: "bad: token\nwith: newlines", homeDir: home });
    expect(result.written).toBe(false);
    expect(result.reason).toBe("malformed_token");
  });
});

describe("refreshAgentGhAuth", () => {
  const tokenUrl = "https://cp.example/api/sessions/s-1/github-token";

  it("fetches the read-only token with the sandbox auth bearer and writes the config", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, token: "ghs_readonly_xyz" }), { status: 200 }),
    );
    const result = await refreshAgentGhAuth({ tokenUrl, authToken: "sbx-token", homeDir: home, fetchImpl });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      tokenUrl,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer sbx-token" }) }),
    );
    const parsed = parseYaml(readFileSync(join(home, ".config", "gh", "hosts.yml"), "utf8"));
    expect(parsed["github.com"].users[parsed["github.com"].user].oauth_token).toBe("ghs_readonly_xyz");
  });

  it("bounds the fetch when the caller does not provide a signal", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ ok: false }), { status: 403 });
    });
    await refreshAgentGhAuth({ tokenUrl, authToken: "sbx-token", homeDir: home, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("fails soft (no throw) on an HTTP error and does not write a config", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 403 }));
    const result = await refreshAgentGhAuth({ tokenUrl, authToken: "sbx-token", homeDir: home, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("http_403");
  });

  it("fails soft when the response carries no token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const result = await refreshAgentGhAuth({ tokenUrl, authToken: "sbx-token", homeDir: home, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_token");
  });

  it("fails soft (no throw) when fetch itself rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await refreshAgentGhAuth({ tokenUrl, authToken: "sbx-token", homeDir: home, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("fetch_failed");
  });

  it("fails closed when the auth token or url is missing (never calls fetch)", async () => {
    const fetchImpl = vi.fn();
    const result = await refreshAgentGhAuth({ tokenUrl, authToken: "", homeDir: home, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_config");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("buildGithubTokenUrl", () => {
  it("builds the session github-token URL, adding https and trimming trailing slashes", () => {
    expect(buildGithubTokenUrl("cp.example//", "s-1")).toBe("https://cp.example/api/sessions/s-1/github-token");
    expect(buildGithubTokenUrl("https://cp.example", "s-1")).toBe("https://cp.example/api/sessions/s-1/github-token");
  });

  it("returns empty when the control-plane url or session id is missing (refresh then fails closed)", () => {
    expect(buildGithubTokenUrl("", "s-1")).toBe("");
    expect(buildGithubTokenUrl("cp.example", "")).toBe("");
  });
});

describe("runWriteAgentGhAuth (boot subcommand)", () => {
  it("reads CONTROL_PLANE_URL/SESSION_ID/SANDBOX_AUTH_TOKEN, fetches the read-only token, and writes the config", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, token: "ghs_env_token" }), { status: 200 }),
    );
    const result = await runWriteAgentGhAuth({
      env: { CONTROL_PLANE_URL: "https://cp.example", SESSION_ID: "s-1", SANDBOX_AUTH_TOKEN: "sbx", HOME: home },
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://cp.example/api/sessions/s-1/github-token",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer sbx" }) }),
    );
    const parsed = parseYaml(readFileSync(join(home, ".config", "gh", "hosts.yml"), "utf8"));
    expect(parsed["github.com"].users[parsed["github.com"].user].oauth_token).toBe("ghs_env_token");
  });

  it("fails soft (missing_config) when required env is absent, without fetching", async () => {
    const fetchImpl = vi.fn();
    const result = await runWriteAgentGhAuth({ env: { HOME: home }, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_config");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  const readyEnv = { CONTROL_PLANE_URL: "https://cp.example", SESSION_ID: "s-1", SANDBOX_AUTH_TOKEN: "sbx" };

  it("retries a 403 'Sandbox not active' and succeeds once the sandbox becomes ready", async () => {
    // At bridge boot the sandbox is still spawning, so /github-token 403s until the
    // bridge signals ready. The boot write must retry, not give up after one 403.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("Sandbox not active", { status: 403 }))
      .mockResolvedValueOnce(new Response("Sandbox not active", { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, token: "ghs_ready" }), { status: 200 }));
    const sleep = vi.fn(async () => {});
    const result = await runWriteAgentGhAuth({ env: { ...readyEnv, HOME: home }, fetchImpl, sleep, maxAttempts: 5 });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const parsed = parseYaml(readFileSync(join(home, ".config", "gh", "hosts.yml"), "utf8"));
    expect(parsed["github.com"].users[parsed["github.com"].user].oauth_token).toBe("ghs_ready");
  });

  it("gives up fail-soft after maxAttempts of a persistent 403 (never throws)", async () => {
    const fetchImpl = vi.fn(async () => new Response("Sandbox not active", { status: 403 }));
    const sleep = vi.fn(async () => {});
    const result = await runWriteAgentGhAuth({ env: { ...readyEnv, HOME: home }, fetchImpl, sleep, maxAttempts: 3 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("http_403");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry a definitive missing_config (config will not self-heal)", async () => {
    const fetchImpl = vi.fn();
    const sleep = vi.fn(async () => {});
    const result = await runWriteAgentGhAuth({ env: { HOME: home }, fetchImpl, sleep, maxAttempts: 5 });
    expect(result.reason).toBe("missing_config");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });
});
