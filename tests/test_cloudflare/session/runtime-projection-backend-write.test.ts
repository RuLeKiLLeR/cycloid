import { describe, expect, it } from "vitest";

import {
  buildUpdateSessionRuntimeBackendStatement,
  buildUpdateSessionRuntimeStateStatement,
} from "../../../apps/control-plane-worker/src/session/db";

function captureBindDb() {
  const calls: unknown[][] = [];
  const db = {
    prepare(_sql: string) {
      return {
        bind: (...args: unknown[]) => {
          calls.push(args);
          return { _bound: args };
        },
      };
    },
  };
  return { db, calls };
}

describe("runtime projection write preserves freestyle", () => {
  it("binds freestyle in the single-column backend update instead of null", () => {
    const { db, calls } = captureBindDb();
    buildUpdateSessionRuntimeBackendStatement(db as never, "sess-1", "freestyle");
    expect(calls[0]).toEqual(["freestyle", "sess-1"]);
  });

  it("binds freestyle provider+backend in the full runtime-state update", () => {
    const { db, calls } = captureBindDb();
    buildUpdateSessionRuntimeStateStatement(db as never, "sess-1", {
      runtimeProvider: "freestyle",
      runtimeBackend: "freestyle",
      runtimeState: "running",
      runtimeSandboxId: "sbx-1",
    } as never);
    // Bind order matches the SET clause: runtime_provider is arg[0], runtime_backend is arg[1].
    expect(calls[0]?.[0]).toBe("freestyle");
    expect(calls[0]?.[1]).toBe("freestyle");
  });
});
