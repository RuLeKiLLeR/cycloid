import { afterEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({ existsSync: vi.fn() }));

// Only existsSync is exercised by resolveCodexPathOverride; keep the rest of node:fs real.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: (...args: unknown[]) => fsMock.existsSync(...args) };
});

import { resolveCodexPathOverride } from "../../apps/sandbox-bridge/src/services/codex-server";

describe("resolveCodexPathOverride", () => {
  afterEach(() => {
    fsMock.existsSync.mockReset();
    vi.unstubAllEnvs();
  });

  it("prefers an explicit CODEX_CLI_PATH / CODEX_PATH over any probe", () => {
    fsMock.existsSync.mockReturnValue(true);
    expect(resolveCodexPathOverride({ CODEX_CLI_PATH: "/opt/codex" })).toBe("/opt/codex");
    expect(resolveCodexPathOverride({ CODEX_PATH: "/opt/codex2" })).toBe("/opt/codex2");
    // Explicit path wins even for a freestyle provider.
    expect(resolveCodexPathOverride({ ARCANIST_RUNTIME_PROVIDER: "freestyle", CODEX_CLI_PATH: "/opt/x" })).toBe(
      "/opt/x",
    );
  });

  it("probes the image codex paths for the e2b provider (unchanged)", () => {
    vi.stubEnv("CODEX_CLI_PATH", "");
    vi.stubEnv("CODEX_PATH", "");
    fsMock.existsSync.mockImplementation((path: string) => path === "/usr/local/bin/codex");
    expect(resolveCodexPathOverride({ ARCANIST_RUNTIME_PROVIDER: "e2b" })).toBe("/usr/local/bin/codex");
  });

  it("also probes the image codex paths for the freestyle provider (no split-brain with honest provider)", () => {
    // Once ARCANIST_RUNTIME_PROVIDER is derived honestly, a freestyle session must
    // still discover the CLI via the standard image paths.
    vi.stubEnv("CODEX_CLI_PATH", "");
    vi.stubEnv("CODEX_PATH", "");
    fsMock.existsSync.mockImplementation((path: string) => path === "/usr/bin/codex");
    expect(resolveCodexPathOverride({ ARCANIST_RUNTIME_PROVIDER: "freestyle" })).toBe("/usr/bin/codex");
  });

  it("returns undefined for an unknown/unset provider even when a candidate exists", () => {
    vi.stubEnv("CODEX_CLI_PATH", "");
    vi.stubEnv("CODEX_PATH", "");
    // Empty source value falls back to process.env; pin it empty so the assertion is deterministic.
    vi.stubEnv("ARCANIST_RUNTIME_PROVIDER", "");
    fsMock.existsSync.mockReturnValue(true);
    expect(resolveCodexPathOverride({ ARCANIST_RUNTIME_PROVIDER: "" })).toBeUndefined();
    expect(resolveCodexPathOverride({ ARCANIST_RUNTIME_PROVIDER: "modal" })).toBeUndefined();
  });

  it("returns undefined for a known provider when no candidate path exists", () => {
    vi.stubEnv("CODEX_CLI_PATH", "");
    vi.stubEnv("CODEX_PATH", "");
    fsMock.existsSync.mockReturnValue(false);
    expect(resolveCodexPathOverride({ ARCANIST_RUNTIME_PROVIDER: "freestyle" })).toBeUndefined();
  });
});
