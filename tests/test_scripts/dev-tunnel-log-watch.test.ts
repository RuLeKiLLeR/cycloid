import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const WATCH_SCRIPT = resolve(REPO_ROOT, "scripts/dev-tunnel-log-watch.sh");

// Real logfmt lines captured from ngrok 3.37.2 (`ngrok http --log=stdout
// --log-format=logfmt`); the loss line's message string was verified against
// the agent binary. msg= precedes obj= on established lines, so the matcher
// must not assume field order.
const ESTABLISHED = 't=2026-06-12T12:44:32-0400 lvl=info msg="client session established" obj=tunnels.session';
const SESSION_LOST =
  't=2026-06-12T12:50:01-0400 lvl=eror msg="session closed, starting reconnect loop" obj=tunnels.session err="read tcp: connection reset by peer"';
const NOISE = [
  't=2026-06-12T12:44:32-0400 lvl=info msg="starting web service" obj=web addr=127.0.0.1:4040 allow_hosts=[]',
  't=2026-06-12T12:44:32-0400 lvl=info msg="tunnel session started" obj=tunnels.session',
  't=2026-06-12T12:44:33-0400 lvl=info msg="started tunnel" obj=tunnels name=command_line addr=http://localhost:3000 url=https://example.ngrok-free.dev',
  't=2026-06-12T12:44:38-0400 lvl=info msg="accept failed" obj=tunnels.session obj=csess id=b01a6df7eb09 err="reconnecting session closed"',
];

const RECONNECTING_LINE = "[tunnel] ngrok agent reconnecting -- expect session WS drops";
const RESTORED_LINE = "[tunnel] ngrok agent session restored";

function runWatcher(lines: string[]): string[] {
  const output = execFileSync("bash", [WATCH_SCRIPT], {
    input: `${lines.join("\n")}\n`,
    encoding: "utf8",
  });
  return output.split("\n").filter(Boolean);
}

describe("dev-tunnel-log-watch.sh", () => {
  it("reports agent session loss", () => {
    expect(runWatcher([ESTABLISHED, SESSION_LOST])).toEqual([RECONNECTING_LINE]);
  });

  it("reports restoration only after a loss", () => {
    expect(runWatcher([ESTABLISHED, SESSION_LOST, ESTABLISHED])).toEqual([RECONNECTING_LINE, RESTORED_LINE]);
  });

  it("stays silent on startup establishment with no prior loss", () => {
    expect(runWatcher([ESTABLISHED])).toEqual([]);
  });

  it("ignores non-session noise lines", () => {
    expect(runWatcher(NOISE)).toEqual([]);
  });

  it("handles repeated loss/restore cycles", () => {
    expect(runWatcher([ESTABLISHED, SESSION_LOST, ESTABLISHED, SESSION_LOST, ESTABLISHED])).toEqual([
      RECONNECTING_LINE,
      RESTORED_LINE,
      RECONNECTING_LINE,
      RESTORED_LINE,
    ]);
  });

  it("does not double-report restoration without a new loss", () => {
    expect(runWatcher([SESSION_LOST, ESTABLISHED, ESTABLISHED])).toEqual([RECONNECTING_LINE, RESTORED_LINE]);
  });

  it("does not double-report loss without an intervening restoration", () => {
    expect(runWatcher([SESSION_LOST, SESSION_LOST, ESTABLISHED])).toEqual([RECONNECTING_LINE, RESTORED_LINE]);
  });
});
