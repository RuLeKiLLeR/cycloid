// Tests for `cycloid test-creds`. The CLI reads credential values from
// --value, --value-file, or --value-stdin and PUTs them to the
// /test-credentials/:credName route. The trailing-newline strip matters
// because shell pipelines like `echo "$SECRET" | cycloid test-creds set
// --value-stdin` always end with a newline that the destination service
// won't expect.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();

vi.mock("../../apps/cli/src/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock("../../apps/cli/src/config", () => ({
  requireConfig: () => ({ apiUrl: "https://api.example.com", token: "tok" }),
}));

vi.mock("../../apps/cli/src/runtime", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../apps/cli/src/runtime");
  return {
    ...actual,
    getRuntimeOptions: () => ({}),
    isJson: () => false,
    writeJson: () => undefined,
  };
});

import { setTestCredentialCommand } from "../../apps/cli/src/commands/test-creds";

describe("test-creds CLI value reading", () => {
  let tmp: string;

  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({});
    tmp = mkdtempSync(join(tmpdir(), "test-creds-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function lastBody(): { value: string } {
    const lastCall = apiFetchMock.mock.calls[apiFetchMock.mock.calls.length - 1];
    return JSON.parse((lastCall[2] as { body: string }).body) as { value: string };
  }

  it("strips a trailing newline from --value-file content (echo > file pattern)", async () => {
    const path = join(tmp, "secret.txt");
    writeFileSync(path, "p@ssw0rd\n");
    await setTestCredentialCommand("acme/repo", "test_user_password", {
      business: "biz-a",
      valueFile: path,
    } as never);
    expect(lastBody().value).toBe("p@ssw0rd");
  });

  it("strips a trailing CRLF from --value-file content", async () => {
    const path = join(tmp, "secret-crlf.txt");
    writeFileSync(path, "p@ssw0rd\r\n");
    await setTestCredentialCommand("acme/repo", "test_user_password", {
      business: "biz-a",
      valueFile: path,
    } as never);
    expect(lastBody().value).toBe("p@ssw0rd");
  });

  it("preserves --value content as-is (caller controls quoting)", async () => {
    await setTestCredentialCommand("acme/repo", "test_user_password", {
      business: "biz-a",
      value: "p@ssw0rd\n",
    } as never);
    // --value bypasses the strip because the caller passed the literal value.
    expect(lastBody().value).toBe("p@ssw0rd\n");
  });

  it("preserves embedded newlines in multi-line file content", async () => {
    const path = join(tmp, "multi.txt");
    writeFileSync(path, "line1\nline2\n");
    await setTestCredentialCommand("acme/repo", "rsa_key", {
      business: "biz-a",
      valueFile: path,
    } as never);
    // Strip removes the FINAL newline only; the embedded one stays.
    expect(lastBody().value).toBe("line1\nline2");
  });

  it("strips trailing newline from a file with no newline at all (no-op)", async () => {
    const path = join(tmp, "no-newline.txt");
    writeFileSync(path, "p@ssw0rd");
    await setTestCredentialCommand("acme/repo", "test_user_password", {
      business: "biz-a",
      valueFile: path,
    } as never);
    expect(lastBody().value).toBe("p@ssw0rd");
  });
});
