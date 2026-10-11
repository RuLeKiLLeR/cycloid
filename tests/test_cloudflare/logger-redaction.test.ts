import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../../apps/control-plane-worker/src/logger";

describe("control-plane logger redaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redacts secret-named fields in log entries", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createLogger({ bindings: { component: "test" } });

    log.error({ token: "ghp_abcdefghijklmnop1234", action: "test" }, "boom");

    const emitted = spy.mock.calls[0][0] as string;
    expect(emitted).toContain("[REDACTED]");
    expect(emitted).not.toContain("ghp_abcdefghijklmnop1234");
  });

  it("scrubs credentialed URLs inside error strings", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createLogger();

    log.error({ error: "fetch failed: https://user:s3cretpass@github.com/acme/widget.git" }, "request failed");

    const emitted = spy.mock.calls[0][0] as string;
    expect(emitted).toContain("[REDACTED]");
    expect(emitted).not.toContain("s3cretpass");
  });

  it("leaves non-secret fields intact", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger();

    log.info({ sessionId: "session-1", action: "session.create" }, "created");

    const emitted = spy.mock.calls[0][0] as string;
    expect(emitted).toContain("session-1");
    expect(emitted).toContain("session.create");
  });
});
