import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalPath = process.env.ARCANIST_EGRESS_LOG_PATH;

describe("egress log export", () => {
  let dir: string | undefined;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.ARCANIST_EGRESS_LOG_PATH;
    else process.env.ARCANIST_EGRESS_LOG_PATH = originalPath;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("emits structured bridge logs for egress fallback and failure signals", async () => {
    dir = mkdtempSync(join(tmpdir(), "cycloid-egress-bridge-"));
    const logPath = join(dir, "cycloid-egress.log");
    writeFileSync(
      logPath,
      [
        "[egress] github-meta-fetch-failed endpoint=https://api.github.com/meta attempt=1 max_attempts=3",
        "[egress] github-meta-snapshot-used path=/app/github-meta-cidrs.snapshot",
        "[egress] unresolved domain=github.com",
        "[egress] enforced allowed_addresses=123 unresolved_domains=1 event=forged",
        "[egress] github-meta-cidrs-unavailable endpoint=https://api.github.com/meta snapshot_path=/app/github-meta-cidrs.snapshot",
      ].join("\n"),
      "utf8",
    );
    process.env.ARCANIST_EGRESS_LOG_PATH = logPath;

    const warn = vi.fn();
    const info = vi.fn();
    const error = vi.fn();
    const { emitStartupEgressLog } = await import("../../apps/sandbox-bridge/src/services/egress-log.js");

    emitStartupEgressLog({ warn, info, error } as never);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "egress.github_meta_fetch_failed",
        attempt: "1",
        max_attempts: "3",
      }),
      "Sandbox egress GitHub Meta fetch failed",
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "egress.github_meta_snapshot_used",
        path: "/app/github-meta-cidrs.snapshot",
      }),
      "Sandbox egress GitHub Meta snapshot fallback used",
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "egress.unresolved_domain",
        domain: "github.com",
      }),
      "Sandbox egress unresolved domain",
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "egress.enforced",
        allowed_addresses: "123",
        unresolved_domains: "1",
      }),
      "Sandbox egress enforcement completed",
    );
    expect(info).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: "forged",
        unresolved_domains: "1",
      }),
      "Sandbox egress enforcement completed",
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "egress.github_meta_unavailable",
        endpoint: "https://api.github.com/meta",
      }),
      "Sandbox egress GitHub Meta CIDRs unavailable",
    );
  });
});
