import { describe, expect, it } from "vitest";

import { buildBridgeStartupDiagnosticScript } from "../../apps/control-plane-worker/src/sandbox/bridge-startup-diagnostics";

const BASE = {
  controlPlaneUrl: "https://app.trycycloid.com",
  controlPlaneWsUrl: "https://app.trycycloid.com/api/sessions/s1/ws?type=sandbox",
};

describe("buildBridgeStartupDiagnosticScript", () => {
  it("captures the bridge process table, log tails, and control-plane reachability", () => {
    const script = buildBridgeStartupDiagnosticScript(BASE);
    expect(script).toContain("ps -eo pid,ppid,stat,etime,args");
    expect(script).toContain("/tmp/cycloid-start-bridge.log");
    expect(script).toContain("/tmp/cycloid-egress.log");
    expect(script).toContain("tail -200");
    // both control-plane URLs are assigned for the curl reachability loop
    // (shellQuote only adds quotes when special chars require them)
    expect(script).toContain("control_plane_base=https://app.trycycloid.com");
    expect(script).toContain("control_plane_ws='https://app.trycycloid.com/api/sessions/s1/ws?type=sandbox'");
  });

  it("starts with set +e and does not sleep (deadline-time capture)", () => {
    const script = buildBridgeStartupDiagnosticScript(BASE);
    expect(script).not.toContain("sleep");
    expect(script.startsWith("set +e")).toBe(true);
  });
});
