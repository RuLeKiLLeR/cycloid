import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const SUPERVISOR = resolve(REPO_ROOT, "apps/sandbox-e2b/scripts/cycloid-desktop-supervisor");

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cycloid-desktop-supervisor-"));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function cleanProcessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.BASH_ENV;
  delete env.ENV;
  return env;
}

function writeFakeDesktopCommands(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const longRunning = `#!/usr/bin/env bash
set -euo pipefail
echo "$$ $0 $*" >> "\${FAKE_DESKTOP_COMMAND_LOG:?}"
exec -a "\${0##*/}" sleep 60
`;
  writeExecutable(binDir, "Xvfb", longRunning);
  writeExecutable(
    binDir,
    "dbus-daemon",
    `#!/usr/bin/env bash
set -euo pipefail
echo "dbus-daemon $*" >> "\${FAKE_DESKTOP_COMMAND_LOG:?}"
(exec -a dbus-daemon sleep 60) >/dev/null 2>&1 &
printf 'unix:path=%s/fake-bus\\n%s\\n' "\${ARCANIST_DESKTOP_STATE_DIR:?}" "$!"
exit 0
`,
  );
  writeExecutable(binDir, "xfsettingsd", longRunning);
  writeExecutable(
    binDir,
    "xfwm4",
    `#!/usr/bin/env bash
set -euo pipefail
echo "xfwm4 $*" >> "\${FAKE_DESKTOP_COMMAND_LOG:?}"
if [ "\${FAKE_XFWM4_EXIT:-0}" = "1" ]; then exit 0; fi
exec -a xfwm4 sleep 60
`,
  );
  writeExecutable(binDir, "xfdesktop", longRunning);
  writeExecutable(binDir, "xfce4-panel", longRunning);
  writeExecutable(binDir, "x11vnc", longRunning);
  writeExecutable(binDir, "websockify", longRunning);
  writeExecutable(
    binDir,
    "xdotool",
    `#!/bin/sh
set -eu
if [ "\${1:-}" = "getdisplaygeometry" ]; then
  printf '%s\\n' "\${FAKE_DISPLAY_SIZE:-1440 900}"
  exit 0
fi
exit 2
`,
  );
  writeExecutable(
    binDir,
    "xfconf-query",
    `#!/bin/sh
set -eu
echo "xfconf-query $*" >> "\${FAKE_DESKTOP_COMMAND_LOG:?}"
exit 0
`,
  );
  writeExecutable(
    binDir,
    "xsetroot",
    `#!/bin/sh
set -eu
echo "xsetroot $*" >> "\${FAKE_DESKTOP_COMMAND_LOG:?}"
exit "\${FAKE_XSETROOT_EXIT:-0}"
`,
  );
  writeExecutable(
    binDir,
    "scrot",
    `#!/bin/sh
set -eu
last=""
for arg in "$@"; do last="$arg"; done
if [ -n "\${FAKE_SCROT_LOG:-}" ]; then printf '%s\n' "$last" >> "$FAKE_SCROT_LOG"; fi
if [ "\${FAKE_SCROT_UNIFORM:-0}" = "1" ]; then
  printf '\\000\\000\\000\\000' > "$last"
else
  printf 'fake-png' > "$last"
fi
`,
  );
  writeExecutable(
    binDir,
    "ffmpeg",
    `#!/bin/sh
exit 1
`,
  );
  writeExecutable(
    binDir,
    "nc",
    `#!/bin/sh
set -eu
last=""
for arg in "$@"; do last="$arg"; done
if [ "\${1:-}" = "-z" ]; then
  exit "\${FAKE_NC_EXIT:-0}"
fi
if [ "\${FAKE_NC_EXIT:-0}" != "0" ]; then
  exit "\${FAKE_NC_EXIT:-0}"
fi
if [ "$last" = "\${ARCANIST_DESKTOP_VNC_PORT:-5900}" ]; then
  if [ "\${FAKE_VNC_PROTOCOL_BAD:-0}" = "1" ]; then
    printf 'not-rfb\\n'
  else
    printf 'RFB 003.008\\n'
  fi
  exit 0
fi
if [ "$last" = "\${ARCANIST_DESKTOP_NOVNC_PORT:-6080}" ]; then
  if [ "\${FAKE_NOVNC_PROTOCOL_BAD:-0}" = "1" ]; then
    printf 'HTTP/1.1 502 Bad Gateway\\r\\n\\r\\n'
  else
    printf 'HTTP/1.1 101 Switching Protocols\\r\\n\\r\\n'
  fi
  exit 0
fi
exit 1
`,
  );
  writeExecutable(
    binDir,
    "ss",
    `#!/bin/sh
set -eu
if [ "\${FAKE_SS_EXIT:-0}" != "0" ]; then exit "\${FAKE_SS_EXIT}"; fi
if [ "\${FAKE_NON_LOOPBACK:-0}" = "1" ]; then
  cat <<'EOF'
State Recv-Q Send-Q Local Address:Port Peer Address:Port
LISTEN 0 4096 0.0.0.0:5900 0.0.0.0:*
LISTEN 0 4096 127.0.0.1:6080 0.0.0.0:*
EOF
elif [ "\${FAKE_E2B_LINK_LOCAL:-0}" = "1" ]; then
  cat <<'EOF'
State Recv-Q Send-Q Local Address:Port Peer Address:Port
LISTEN 0 4096 127.0.0.1:5900 0.0.0.0:*
LISTEN 0 4096 127.0.0.1:6080 0.0.0.0:*
LISTEN 0 5 169.254.0.21:5900 0.0.0.0:*
LISTEN 0 5 169.254.0.21:6080 0.0.0.0:*
EOF
else
  cat <<'EOF'
State Recv-Q Send-Q Local Address:Port Peer Address:Port
LISTEN 0 4096 127.0.0.1:5900 0.0.0.0:*
LISTEN 0 4096 127.0.0.1:6080 0.0.0.0:*
EOF
fi
`,
  );
}

function baseEnv(dir: string): NodeJS.ProcessEnv {
  const binDir = join(dir, "bin");
  const stateDir = join(dir, "state");
  writeFakeDesktopCommands(binDir);
  return {
    ...cleanProcessEnv(),
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    DISPLAY: ":99",
    ARCANIST_DESKTOP_STATE_DIR: stateDir,
    ARCANIST_DESKTOP_SUPERVISOR_ITERATIONS: "1",
    ARCANIST_DESKTOP_HEALTH_INTERVAL_SECONDS: "0.01",
    ARCANIST_DESKTOP_RESTART_BACKOFF_1_SECONDS: "0",
    ARCANIST_DESKTOP_RESTART_BACKOFF_2_SECONDS: "0",
    ARCANIST_DESKTOP_RESTART_BACKOFF_3_SECONDS: "0",
    FAKE_DESKTOP_COMMAND_LOG: join(dir, "desktop-commands.log"),
    FAKE_SCROT_LOG: join(dir, "scrot.log"),
  };
}

function runSupervisor(args: string[], env: NodeJS.ProcessEnv, cwdOrTimeout?: string | number) {
  return spawnSync("bash", [SUPERVISOR, ...args], {
    cwd: typeof cwdOrTimeout === "string" ? cwdOrTimeout : undefined,
    env,
    encoding: "utf8",
    timeout: typeof cwdOrTimeout === "number" ? cwdOrTimeout : 20_000,
  });
}

function runSupervisorAsync(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("bash", [SUPERVISOR, ...args], { env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`supervisor ${args.join(" ")} timed out`));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function readHealth(dir: string) {
  return JSON.parse(readFileSync(join(dir, "state", "health.json"), "utf8")) as {
    ok: boolean;
    status: string;
    failedComponent: string | null;
    lastError: string | null;
    size: { width: number; height: number };
    ports: { loopbackOnly: boolean; vnc: { reachable: boolean }; novnc: { reachable: boolean } };
    checks: { screenshot: boolean; desktopRoot: boolean };
    screenshot: { nonBlackPixelRatio: number; entropy: number; uniform: boolean; checkedAt: string | null };
    healthCheckMode: string;
    supervisorGeneration: string | null;
    failedPhase: string | null;
    restartCounts: Record<string, number>;
  };
}

async function waitForAvailableHealth(dir: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (readHealth(dir).status === "available") {
        return;
      }
    } catch {
      // The first health sample has not been written yet.
    }
    await new Promise((resolveDone) => setTimeout(resolveDone, 25));
  }
  throw new Error("desktop health did not become available");
}

function pidAlive(pid: number): boolean {
  return spawnSync("kill", ["-0", String(pid)]).status === 0;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!pidAlive(pid)) {
      return true;
    }
    await new Promise((resolveDone) => setTimeout(resolveDone, 25));
  }
  return !pidAlive(pid);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    spawnSync("bash", [SUPERVISOR, "stop"], {
      env: { ...cleanProcessEnv(), ARCANIST_DESKTOP_STATE_DIR: join(dir, "state") },
      encoding: "utf8",
      timeout: 5000,
    });
    rmSync(dir, { recursive: true, force: true });
  }
});

const linuxOnlyIt = process.platform === "linux" ? it : it.skip;

describe.sequential("desktop supervisor", () => {
  it("writes health JSON with isolated Python imports even from repo-controlled cwd and PYTHONPATH", () => {
    const dir = makeTempDir();
    const poisonDir = join(dir, "poison");
    mkdirSync(poisonDir, { recursive: true });
    writeFileSync(join(poisonDir, "json.py"), "raise RuntimeError('poisoned json import')\n");
    writeFileSync(join(poisonDir, "glob.py"), "raise RuntimeError('poisoned glob import')\n");
    const env = { ...baseEnv(dir), PYTHONPATH: poisonDir };

    const result = runSupervisor(["health"], env, poisonDir);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      status: "preparing",
    });
  });

  it("writes available health JSON with a 1440x900 screenshot smoke and loopback ports", () => {
    const dir = makeTempDir();
    const env = baseEnv(dir);

    const result = runSupervisor(["supervise"], env);

    expect(result.status).toBe(0);
    const health = readHealth(dir);
    expect(health).toMatchObject({
      ok: true,
      status: "available",
      failedComponent: null,
      size: { width: 1440, height: 900 },
      checks: { screenshot: true, background: true, panel: true, desktopRoot: true },
      ports: {
        loopbackOnly: true,
        vnc: { reachable: true },
        novnc: { reachable: true },
      },
    });
    expect(existsSync(join(dir, "state", "health-screenshot.webp"))).toBe(true);
    expect(readFileSync(join(dir, "state", "supervisor.log"), "utf8")).toContain(
      "event=desktop.health status=available",
    );
    const commandLog = readFileSync(join(dir, "desktop-commands.log"), "utf8");
    expect(commandLog).toContain("dbus-daemon");
    expect(commandLog).toContain("xfsettingsd");
    expect(commandLog).toContain("xfwm4 --replace");
    expect(commandLog).toContain("xfdesktop --disable-wm-check");
    expect(commandLog).toContain("xfce4-panel");
    expect(commandLog).toContain("xsetroot -solid #263240");
    expect(commandLog).toMatch(/x11vnc .* -viewonly( |$)/);
    expect(commandLog).toMatch(/x11vnc .* -noclipboard( |$)/);
  }, 20_000);

  it("runs screenshot quality analysis once at readiness and uses lightweight recurring health checks", () => {
    const dir = makeTempDir();
    const env: NodeJS.ProcessEnv = { ...baseEnv(dir), ARCANIST_DESKTOP_SUPERVISOR_ITERATIONS: "3" };

    const result = runSupervisor(["supervise"], env);

    expect(result.status).toBe(0);
    const health = readHealth(dir);
    expect(health).toMatchObject({
      ok: true,
      status: "available",
      healthCheckMode: "lightweight",
      checks: { screenshot: true },
      screenshot: { checkedAt: expect.any(String) },
    });
    const scrotCalls = readFileSync(env.FAKE_SCROT_LOG!, "utf8").trim().split("\n");
    expect(scrotCalls).toHaveLength(1);
    const supervisorLog = readFileSync(join(dir, "state", "supervisor.log"), "utf8");
    expect(supervisorLog.match(/event=desktop\.health .*check_mode=full/g)).toHaveLength(1);
    expect(supervisorLog.match(/event=desktop\.health .*check_mode=lightweight/g)).toHaveLength(2);
  }, 20_000);

  it("reruns full screenshot quality analysis for an explicit health request", async () => {
    const dir = makeTempDir();
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir),
      ARCANIST_DESKTOP_SUPERVISOR_ITERATIONS: "0",
      ARCANIST_DESKTOP_HEALTH_INTERVAL_SECONDS: "60",
    };

    const start = runSupervisor(["start"], env);
    expect(start.status).toBe(0);
    await waitForAvailableHealth(dir);

    const healthResult = runSupervisor(["health"], env);

    expect(healthResult.status).toBe(0);
    expect(JSON.parse(healthResult.stdout)).toMatchObject({
      ok: true,
      status: "available",
      healthCheckMode: "full",
      supervisorGeneration: expect.any(String),
      checks: { screenshot: true },
    });
    expect(readFileSync(env.FAKE_SCROT_LOG!, "utf8").trim().split("\n")).toHaveLength(2);
  }, 20_000);

  it("allows E2B link-local forwarding listeners alongside loopback desktop ports", () => {
    const dir = makeTempDir();
    const env = { ...baseEnv(dir), FAKE_E2B_LINK_LOCAL: "1" };

    const result = runSupervisor(["supervise"], env);

    expect(result.status).toBe(0);
    expect(readHealth(dir)).toMatchObject({
      ok: true,
      status: "available",
      failedComponent: null,
      ports: { loopbackOnly: true },
    });
  }, 20_000);

  it("marks the desktop unavailable when a service binds outside loopback", () => {
    const dir = makeTempDir();
    const env = { ...baseEnv(dir), FAKE_NON_LOOPBACK: "1" };

    const result = runSupervisor(["supervise"], env);

    expect(result.status).toBe(0);
    expect(readHealth(dir)).toMatchObject({
      ok: false,
      status: "unavailable",
      failedComponent: "ports",
      failedPhase: "provider_port_resolve",
      lastError: "non_loopback_binding",
      checks: { background: true, panel: true },
      ports: { loopbackOnly: false },
    });
  }, 20_000);

  it("reports ss_unavailable when socket inspection fails", () => {
    const dir = makeTempDir();
    const env = { ...baseEnv(dir), FAKE_SS_EXIT: "127" };

    const result = runSupervisor(["supervise"], env);

    expect(result.status).toBe(0);
    expect(readHealth(dir)).toMatchObject({
      ok: false,
      status: "unavailable",
      failedComponent: "ports",
      failedPhase: "provider_port_resolve",
      lastError: "ss_unavailable",
      ports: { loopbackOnly: false },
    });
  }, 20_000);

  it("marks the desktop unavailable when the VNC RFB handshake fails", () => {
    const dir = makeTempDir();
    const env = { ...baseEnv(dir), FAKE_VNC_PROTOCOL_BAD: "1" };

    const result = runSupervisor(["supervise"], env);

    expect(result.status).toBe(0);
    expect(readHealth(dir)).toMatchObject({
      ok: false,
      status: "unavailable",
      failedComponent: "x11vnc",
      failedPhase: "vnc_ready",
      lastError: "vnc_rfb_handshake_failed",
      ports: { vnc: { reachable: false } },
    });
  }, 20_000);

  it("marks the desktop unavailable when the noVNC WebSocket handshake fails", () => {
    const dir = makeTempDir();
    const env = { ...baseEnv(dir), FAKE_NOVNC_PROTOCOL_BAD: "1" };

    const result = runSupervisor(["supervise"], env);

    expect(result.status).toBe(0);
    expect(readHealth(dir)).toMatchObject({
      ok: false,
      status: "unavailable",
      failedComponent: "websockify",
      failedPhase: "websockify_ready",
      lastError: "novnc_websocket_handshake_failed",
      ports: { vnc: { reachable: true }, novnc: { reachable: false } },
    });
  }, 20_000);

  it("marks the desktop unavailable when visible background setup fails", () => {
    const dir = makeTempDir();
    const env = { ...baseEnv(dir), FAKE_XSETROOT_EXIT: "1" };

    const result = runSupervisor(["supervise"], env);

    expect(result.status).toBe(0);
    expect(readHealth(dir)).toMatchObject({
      ok: false,
      status: "unavailable",
      failedComponent: "background",
      failedPhase: "desktop_root",
      lastError: "desktop_background_failed",
      checks: { background: false },
    });
  }, 20_000);

  it("does not report a stale screenshot as passing when health is already unavailable", () => {
    const dir = makeTempDir();
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "health-screenshot.webp"), "stale-webp");
    const env = { ...baseEnv(dir), FAKE_DISPLAY_SIZE: "not-a-size" };

    const result = runSupervisor(["supervise"], env);

    expect(result.status).toBe(0);
    expect(readHealth(dir)).toMatchObject({
      ok: false,
      status: "unavailable",
      failedComponent: "xvfb",
      checks: { screenshot: false },
    });
  }, 20_000);

  it("does not leave desktop processes running when PID state cannot be written", () => {
    const dir = makeTempDir();
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "pids"), "not-a-directory");
    const env = baseEnv(dir);

    const result = runSupervisor(["supervise"], env);

    expect(result.status).toBe(0);
    expect(readHealth(dir)).toMatchObject({
      ok: false,
      status: "unavailable",
      failedComponent: "xvfb",
    });
    expect(readFileSync(join(stateDir, "supervisor.log"), "utf8")).toContain(
      "event=desktop.write_pid component=xvfb outcome=failed",
    );
    const startedPids = readFileSync(env.FAKE_DESKTOP_COMMAND_LOG!, "utf8")
      .trim()
      .split("\n")
      .map((line) => Number(line.split(" ", 1)[0]));
    expect(startedPids).not.toHaveLength(0);
    expect(startedPids.every((pid) => !pidAlive(pid))).toBe(true);
  });

  it("marks the desktop unavailable when the screenshot is black or uniform", () => {
    const dir = makeTempDir();
    const env = { ...baseEnv(dir), FAKE_SCROT_UNIFORM: "1" };

    const result = runSupervisor(["supervise"], env);

    expect(result.status).toBe(0);
    expect(readHealth(dir)).toMatchObject({
      ok: false,
      status: "unavailable",
      failedComponent: "screenshot_black_or_uniform",
      failedPhase: "screenshot_black_or_uniform",
      lastError: "screenshot_black_or_uniform",
      screenshot: { nonBlackPixelRatio: 0, uniform: true },
    });
  }, 20_000);
  it("caps restart attempts for a repeatedly exiting window manager", () => {
    const dir = makeTempDir();
    const env = {
      ...baseEnv(dir),
      ARCANIST_DESKTOP_SUPERVISOR_ITERATIONS: "6",
      ARCANIST_DESKTOP_RESTART_BUDGET: "3",
      FAKE_XFWM4_EXIT: "1",
    };

    const result = runSupervisor(["supervise"], env, 40_000);

    expect(result.status).toBe(0);
    const health = readHealth(dir);
    expect(health.status).toBe("unavailable");
    expect(health.failedComponent).toBe("xfwm4");
    expect(health.failedPhase).toBe("window_manager");
    expect(health.restartCounts.xfwm4).toBe(3);
    expect(readFileSync(join(dir, "state", "supervisor.log"), "utf8")).toContain(
      "event=desktop.restart component=xfwm4 outcome=budget_exhausted",
    );
  }, 45_000);

  it("restarts an alive VNC component when its protocol health check fails", () => {
    const dir = makeTempDir();
    const env = {
      ...baseEnv(dir),
      ARCANIST_DESKTOP_SUPERVISOR_ITERATIONS: "2",
      ARCANIST_DESKTOP_RESTART_BUDGET: "1",
      FAKE_NOVNC_PROTOCOL_BAD: "1",
    };

    const result = runSupervisor(["supervise"], env);

    expect(result.status).toBe(0);
    const supervisorLog = readFileSync(join(dir, "state", "supervisor.log"), "utf8");
    expect(supervisorLog.match(/event=desktop.start component=websockify/g)?.length).toBe(2);
    expect(supervisorLog).toContain("event=desktop.restart component=websockify attempt=1 reason=health_check_failed");
  }, 20_000);

  linuxOnlyIt(
    "rejects a PID file that points at a reused non-component process",
    () => {
      const dir = makeTempDir();
      const env = {
        ...baseEnv(dir),
        ARCANIST_DESKTOP_RESTART_BUDGET: "1",
      };
      const stateDir = join(dir, "state");
      mkdirSync(join(stateDir, "pids"), { recursive: true });
      writeFileSync(join(stateDir, "pids", "x11vnc.pid"), `${process.pid}\n`);
      writeFileSync(join(stateDir, "x11vnc.started"), "");

      const result = runSupervisor(["supervise"], env);

      expect(result.status).toBe(0);
      const supervisorLog = readFileSync(join(stateDir, "supervisor.log"), "utf8");
      expect(supervisorLog).toContain("event=desktop.pid component=x11vnc status=stale action=remove");
      expect(supervisorLog).toContain("event=desktop.restart component=x11vnc attempt=1 reason=process_exit");
      const commandLog = readFileSync(join(dir, "desktop-commands.log"), "utf8");
      expect(commandLog.match(/x11vnc/g)?.length).toBe(1);
    },
    20_000,
  );

  it("start-ready waits for an available health sample", () => {
    const dir = makeTempDir();
    const env = {
      ...baseEnv(dir),
      ARCANIST_DESKTOP_START_READY_TIMEOUT_SECONDS: "12",
      ARCANIST_DESKTOP_START_READY_POLL_SECONDS: "0.05",
    };

    const result = runSupervisor(["start-ready"], env);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      status: "available",
      failedComponent: null,
      size: { width: 1440, height: 900 },
    });
  }, 20_000);

  it("removes stale X display locks before launching Xvfb", () => {
    const dir = makeTempDir();
    const displayNumber = 681;
    const lockPath = `/tmp/.X${displayNumber}-lock`;
    const env = {
      ...baseEnv(dir),
      DISPLAY: `:${displayNumber}`,
      ARCANIST_DESKTOP_DISPLAY: `:${displayNumber}`,
    };
    rmSync(lockPath, { force: true });
    writeFileSync(lockPath, "999999\n");

    try {
      const result = runSupervisor(["supervise"], env);

      expect(result.status).toBe(0);
      expect(existsSync(lockPath)).toBe(false);
      expect(readFileSync(join(dir, "state", "supervisor.log"), "utf8")).toContain(
        "event=desktop.x_display_lock status=stale action=remove",
      );
    } finally {
      rmSync(lockPath, { force: true });
    }
  }, 20_000);

  it("start returns without waiting for the supervisor loop", () => {
    const dir = makeTempDir();
    const env = { ...baseEnv(dir), ARCANIST_DESKTOP_HEALTH_INTERVAL_SECONDS: "60" };
    const startedAt = Date.now();

    const result = runSupervisor(["start"], env);

    expect(result.status).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(existsSync(join(dir, "state", "pids", "supervisor.pid"))).toBe(true);
  }, 10_000);

  it("start skips resume-check when the supervisor is already running", () => {
    const dir = makeTempDir();
    const stateDir = join(dir, "state");
    const pidDir = join(stateDir, "pids");
    const resumeCheckLog = join(dir, "resume-check.log");
    mkdirSync(pidDir, { recursive: true });
    const external = spawnSync(
      "bash",
      ["-c", "(exec -a cycloid-desktop-supervisor sleep 60) >/dev/null 2>&1 & echo $!"],
      {
        encoding: "utf8",
      },
    );
    expect(external.status).toBe(0);
    const supervisorPid = Number(external.stdout.trim());
    if (!Number.isInteger(supervisorPid) || supervisorPid <= 0) {
      throw new Error(`failed to start external supervisor pid: ${external.stdout}`);
    }
    writeFileSync(join(pidDir, "supervisor.pid"), `${supervisorPid}\n`);
    const env = { ...baseEnv(dir), FAKE_RESUME_CHECK_LOG: resumeCheckLog };
    writeExecutable(
      join(dir, "bin"),
      "cycloid-desktop",
      `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "\${FAKE_RESUME_CHECK_LOG:?}"
`,
    );

    const result = runSupervisor(["start"], env);

    expect(result.status).toBe(0);
    expect(existsSync(resumeCheckLog)).toBe(false);
    const supervisorLog = readFileSync(join(stateDir, "supervisor.log"), "utf8");
    expect(supervisorLog).toContain("event=desktop.start supervisor=already_running");
    expect(supervisorLog).not.toContain("event=desktop.recording_resume_check");
  }, 10_000);

  it("stop waits for externally-owned component processes to exit", async () => {
    const dir = makeTempDir();
    const stateDir = join(dir, "state");
    const pidDir = join(stateDir, "pids");
    mkdirSync(pidDir, { recursive: true });
    const external = spawnSync(
      "bash",
      ["-c", "(trap 'sleep 0.2; exit 0' TERM; while true; do sleep 1; done) >/dev/null 2>&1 & echo $!"],
      {
        encoding: "utf8",
      },
    );
    expect(external.status).toBe(0);
    const externalPid = Number(external.stdout.trim());
    if (!Number.isInteger(externalPid) || externalPid <= 0) {
      throw new Error(`failed to start external process: ${external.stdout}`);
    }
    writeFileSync(join(pidDir, "x11vnc.pid"), `${externalPid}\n`);

    const stoppedAt = Date.now();
    const result = runSupervisor(["stop"], { ...cleanProcessEnv(), ARCANIST_DESKTOP_STATE_DIR: stateDir });

    expect(result.status).toBe(0);
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(150);
    expect(await waitForProcessExit(externalPid, 1000)).toBe(true);
  }, 10_000);

  it("times out instead of waiting forever on a held supervisor start lock", () => {
    const dir = makeTempDir();
    const env = { ...baseEnv(dir), ARCANIST_DESKTOP_LOCK_WAIT_SECONDS: "0" };
    const lockDir = join(dir, "state", "locks", "supervisor-start.lock.d");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "pid"), `${process.pid}\n`);

    const result = runSupervisor(["start"], env);

    expect(result.status).toBe(1);
    expect(readFileSync(join(dir, "state", "supervisor.log"), "utf8")).toContain(
      "event=desktop.lock name=supervisor-start outcome=timeout",
    );
  }, 10_000);

  it("serializes concurrent supervisor starts with a cross-process lock", async () => {
    const dir = makeTempDir();
    const binDir = join(dir, "bin");
    const env = {
      ...baseEnv(dir),
      ARCANIST_DESKTOP_SUPERVISOR_ITERATIONS: "0",
      ARCANIST_DESKTOP_HEALTH_INTERVAL_SECONDS: "60",
    };
    writeExecutable(
      binDir,
      "cycloid-desktop",
      `#!/bin/sh
sleep 0.2
exit 1
`,
    );

    const [first, second] = await Promise.all([runSupervisorAsync(["start"], env), runSupervisorAsync(["start"], env)]);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const supervisorLog = readFileSync(join(dir, "state", "supervisor.log"), "utf8");
    expect(supervisorLog.match(/event=desktop.start supervisor=launched/g)?.length).toBe(1);
    expect(supervisorLog).toContain("event=desktop.start supervisor=already_running");
  }, 20_000);
});
