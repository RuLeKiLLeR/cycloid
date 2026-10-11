// ENOSPC (disk-full) outcome detection: the pure signature matcher and the git
// push-error seam that turns a real disk failure into a `sandbox_enospc` event.
import { describe, expect, it, vi } from "vitest";

import { hasEnospcSignature } from "../../apps/sandbox-bridge/src/services/enospc-detect.ts";
import { emitPushErrorEvent, maybeEmitEnospcEvent } from "../../apps/sandbox-bridge/src/services/git/events.ts";

describe("hasEnospcSignature", () => {
  it("matches err.code === 'ENOSPC'", () => {
    expect(hasEnospcSignature({ code: "ENOSPC" })).toBe(true);
  });

  it("matches errno 28 and -28", () => {
    expect(hasEnospcSignature({ errno: 28 })).toBe(true);
    expect(hasEnospcSignature({ errno: -28 })).toBe(true);
  });

  it("matches the git message / stderr text (case-insensitive)", () => {
    expect(hasEnospcSignature("fatal: No space left on device")).toBe(true);
    expect(hasEnospcSignature({ message: "write error: no space left on device" })).toBe(true);
    expect(hasEnospcSignature({ stderr: "error: pack-objects died: ENOSPC" })).toBe(true);
    expect(hasEnospcSignature(new Error("No space left on device"))).toBe(true);
  });

  it("does not match unrelated failures", () => {
    expect(hasEnospcSignature({ code: "ENOENT" })).toBe(false);
    expect(hasEnospcSignature("remote_branch_diverged")).toBe(false);
    expect(hasEnospcSignature({ message: "Authentication failed" })).toBe(false);
    expect(hasEnospcSignature(null)).toBe(false);
    expect(hasEnospcSignature(undefined)).toBe(false);
    expect(hasEnospcSignature(28)).toBe(false);
  });
});

describe("maybeEmitEnospcEvent / emitPushErrorEvent seam", () => {
  const config = () => ({ sandboxId: "sbx-1", sendEvent: vi.fn() });

  it("emits sandbox_enospc for an ENOSPC push failure (alongside push_error)", () => {
    const c = config();
    emitPushErrorEvent(c, { messageId: "m1", branchName: "b", error: "fatal: pack-objects: No space left on device" });
    const types = c.sendEvent.mock.calls.map((call) => call[0].type);
    expect(types).toContain("sandbox_enospc");
    expect(types).toContain("push_error");
    const enospc = c.sendEvent.mock.calls.find((call) => call[0].type === "sandbox_enospc")?.[0];
    expect(enospc).toMatchObject({ type: "sandbox_enospc", source: "push", sandboxId: "sbx-1" });
  });

  it("does NOT emit sandbox_enospc for a non-ENOSPC push failure", () => {
    const c = config();
    emitPushErrorEvent(c, { messageId: "m1", branchName: "b", error: "remote_branch_diverged" });
    const types = c.sendEvent.mock.calls.map((call) => call[0].type);
    expect(types).toEqual(["push_error"]);
  });

  it("maybeEmitEnospcEvent tags the source and never throws on bad input", () => {
    const c = config();
    maybeEmitEnospcEvent(c, "commit", { code: "ENOSPC" });
    expect(c.sendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "sandbox_enospc", source: "commit" }));
    c.sendEvent.mockClear();
    maybeEmitEnospcEvent(c, "commit", undefined);
    expect(c.sendEvent).not.toHaveBeenCalled();
  });
});
