import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  egressAddCommand,
  egressSourceSetCommand,
  egressSyncCommand,
  egressValidateCommand,
} from "../../apps/cli/src/commands/egress";

describe("CLI egress commands", () => {
  let originalCwd: string;
  let tempDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "cycloid-egress-cli-"));
    process.chdir(tempDir);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    vi.unstubAllGlobals();
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("sets the egress allowlist source repo", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          source: { sourceRepoOwner: "acme", sourceRepoName: "policy" },
          path: ".cycloid/egress-allowlist.txt",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await egressSourceSetCommand("acme/policy", {
      apiUrl: "https://api.example.test",
      token: "arc_test",
      business: "biz-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/businesses/biz-1/egress-allowlist/source",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ sourceRepoOwner: "acme", sourceRepoName: "policy" }),
      }),
    );
  });

  it("opens an egress allowlist PR with normalized domains", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          addedDomains: ["api.acme.test"],
          prUrl: "https://github.com/acme/policy/pull/4",
          status: "created",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await egressAddCommand(["API.Acme.test"], {
      apiUrl: "https://api.example.test",
      token: "arc_test",
      business: "biz-1",
      reason: "needed for onboarding",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/businesses/biz-1/egress-allowlist/pull-request",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ domains: ["api.acme.test"], reason: "needed for onboarding" }),
      }),
    );
  });

  it("syncs the source file into the runtime allowlist", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          egressAllowlist: ["api.acme.test"],
          source: { sourceRepoOwner: "acme", sourceRepoName: "policy" },
          path: ".cycloid/egress-allowlist.txt",
          defaultBranch: "main",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await egressSyncCommand({ apiUrl: "https://api.example.test", token: "arc_test", business: "biz-1" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/businesses/biz-1/egress-allowlist/sync",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("validates a local egress allowlist file", async () => {
    writeFileSync("egress.txt", "api.acme.test\nregistry.acme.test\n");

    await egressValidateCommand("egress.txt");

    const output = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(output).toContain("Valid egress allowlist: egress.txt");
    expect(output).toContain("2 domains.");
  });
});
