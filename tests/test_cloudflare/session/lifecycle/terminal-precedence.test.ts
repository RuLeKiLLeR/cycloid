import { describe, expect, it } from "vitest";

import { pickTerminalErrorCode } from "../../../../apps/control-plane-worker/src/session/lifecycle/terminal-decision";

describe("lifecycle terminal precedence", () => {
  it("keeps typed sandbox and Codex failures above stale_prompt", () => {
    expect(pickTerminalErrorCode("stale_prompt", "sandbox_terminated")).toBe("sandbox_terminated");
    expect(pickTerminalErrorCode("stale_prompt", "sandbox_disconnected")).toBe("sandbox_disconnected");
    expect(pickTerminalErrorCode("stale_prompt", "codex_prompt_dispatch_timeout")).toBe(
      "codex_prompt_dispatch_timeout",
    );
    expect(pickTerminalErrorCode("stale_prompt", "codex_startup_timeout")).toBe("codex_startup_timeout");
    expect(pickTerminalErrorCode("stale_prompt", "codex_api_readiness_timeout")).toBe("codex_api_readiness_timeout");
    expect(pickTerminalErrorCode("stale_prompt", "codex_session_create_timeout")).toBe("codex_session_create_timeout");
    expect(pickTerminalErrorCode("stale_prompt", "codex_not_ready")).toBe("codex_not_ready");
    expect(pickTerminalErrorCode("stale_prompt", "codex_transport_closed")).toBe("codex_transport_closed");
    expect(pickTerminalErrorCode("stale_prompt", "codex_unrecoverable")).toBe("codex_unrecoverable");
  });

  it("treats codex_not_ready as a startup-class failure above api_readiness_timeout", () => {
    // A wedged startup beats a later in-prompt readiness timeout — the
    // original startup cause is the more informative terminal code.
    expect(pickTerminalErrorCode("codex_api_readiness_timeout", "codex_not_ready")).toBe("codex_not_ready");
  });

  it("lets typed runtime failures beat generic aborted terminal races", () => {
    expect(pickTerminalErrorCode("aborted", "codex_transport_closed")).toBe("codex_transport_closed");
    expect(pickTerminalErrorCode("aborted", "sandbox_terminated")).toBe("sandbox_terminated");
    expect(pickTerminalErrorCode("codex_startup_timeout", "aborted")).toBe("codex_startup_timeout");
  });

  it("keeps spawn failures ahead of sandbox runtime failures", () => {
    expect(pickTerminalErrorCode("sandbox_terminated", "spawn_timeout")).toBe("spawn_timeout");
    expect(pickTerminalErrorCode("sandbox_disconnected", "spawn_preconnect")).toBe("spawn_preconnect");
  });
});
