import { describe, expect, it } from "vitest";

import {
  decideUndersizeReport,
  detectSessionOomKills,
  parseGlobalOomKills,
  parseOomVictim,
} from "../../apps/sandbox-bridge/src/services/undersize-detect";

const vmstat = (oom?: number): string =>
  `nr_free_pages 12345\npgfault 99999\n${oom === undefined ? "" : `oom_kill ${oom}\n`}pgmajfault 7\n`;

describe("parseGlobalOomKills", () => {
  it("parses the global oom_kill counter from /proc/vmstat", () => {
    expect(parseGlobalOomKills(vmstat(5))).toBe(5);
  });

  it("returns 0 when oom_kill is absent", () => {
    expect(parseGlobalOomKills(vmstat())).toBe(0);
  });

  it("anchors on the oom_kill line and ignores similarly-prefixed keys", () => {
    expect(parseGlobalOomKills("oom_kill_something 9\noom_kill 2\n")).toBe(2);
  });
});

describe("detectSessionOomKills", () => {
  it("reports the delta when oom_kill grew past the session baseline", () => {
    expect(detectSessionOomKills(vmstat(3), 1)).toBe(2);
  });

  it("returns null when no OOM happened since the baseline", () => {
    expect(detectSessionOomKills(vmstat(4), 4)).toBeNull();
  });

  it("does not false-fire on a non-zero boot baseline", () => {
    expect(detectSessionOomKills(vmstat(2), 2)).toBeNull();
  });
});

describe("decideUndersizeReport", () => {
  const oomSample = {
    alreadyReported: false,
    vmstat: vmstat(3),
    baselineOomKills: 1,
  };

  it("reports an OOM delta for any session", () => {
    expect(decideUndersizeReport(oomSample)).toEqual({ oomKills: 2 });
  });

  it("latches: no second report once already reported", () => {
    expect(decideUndersizeReport({ ...oomSample, alreadyReported: true })).toBeNull();
  });

  it("no report when no OOM happened since the baseline", () => {
    expect(decideUndersizeReport({ ...oomSample, vmstat: vmstat(1), baselineOomKills: 1 })).toBeNull();
  });
});

describe("parseOomVictim", () => {
  // A real kernel OOM-killer summary line (from the openevidence/xyla pytest OOM).
  const killLine =
    "[ 2217.005584] Out of memory: Killed process 30149 (python3) total-vm:3182368kB, anon-rss:29208kB, file-rss:316kB, shmem-rss:8kB, UID:1000 pgtables:3300kB oom_score_adj:100";

  it("extracts pid, comm, and anon-rss (as MB) from the victim line", () => {
    expect(parseOomVictim(killLine)).toEqual({ pid: 30149, comm: "python3", anonRssMb: 29 });
  });

  it("returns the LAST victim when several kills are present", () => {
    const log = [
      "Out of memory: Killed process 100 (node) total-vm:1kB, anon-rss:1048576kB, file-rss:0kB",
      "Out of memory: Killed process 200 (jest) total-vm:1kB, anon-rss:2097152kB, file-rss:0kB",
    ].join("\n");
    expect(parseOomVictim(log)).toEqual({ pid: 200, comm: "jest", anonRssMb: 2048 });
  });

  it("returns null when the log has no victim line (dmesg empty/unreadable)", () => {
    expect(parseOomVictim("nr_free_pages 1\nsome unrelated kernel line\n")).toBeNull();
  });
});
