// Pure OOM-detection logic for the "sandbox undersized" signal, split out of the
// bridge so the latch + /proc/vmstat parsing are unit-testable without standing
// up a full Bridge instance. Fires for every session, not just onboarding.
//
// We read the SYSTEM-WIDE oom_kill counter from /proc/vmstat, not the bridge's
// cgroup: a build that OOMs inside a docker/compose cgroup subtree never bumps
// the bridge cgroup's memory.events.oom_kill, but it does bump the global
// counter. The counter is cumulative since VM boot, so we diff against a baseline
// captured at session start.

/** Parse the cumulative global OOM-kill count from /proc/vmstat (0 if absent). */
export function parseGlobalOomKills(vmstat: string): number {
  const match = /^oom_kill\s+(\d+)/m.exec(vmstat);
  return match ? Number(match[1]) : 0;
}

// Returns the number of OOM-kills observed since `baselineOomKills`, or null when
// none have happened this session.
export function detectSessionOomKills(vmstat: string, baselineOomKills: number): number | null {
  const delta = parseGlobalOomKills(vmstat) - baselineOomKills;
  return delta > 0 ? delta : null;
}

// One-shot latch + OOM-since-baseline check, kept pure so the branching is
// covered without the bridge's I/O. Returns the report when the sandbox should be
// flagged undersized this sample, else null.
export function decideUndersizeReport(params: {
  alreadyReported: boolean;
  vmstat: string;
  baselineOomKills: number;
}): { oomKills: number } | null {
  if (params.alreadyReported) return null;
  const oomKills = detectSessionOomKills(params.vmstat, params.baselineOomKills);
  return oomKills === null ? null : { oomKills };
}

// The kernel OOM-killer victim: which process the kernel actually killed. The
// /proc/vmstat counter (above) says a kill HAPPENED; this says WHAT died, which
// is what turns a "sandbox undersized" alert into an actionable "pytest -n 15
// used 14 GB" signal. `comm` is the kernel's process name (truncated to ~15
// chars); `anonRssMb` is the victim's anonymous RSS at kill time.
export interface OomVictim {
  pid: number;
  comm: string;
  anonRssMb: number;
}

// Parse the most-recent OOM-killer victim from a kernel-log dump (dmesg /
// /dev/kmsg). The kernel prints one summary line per kill, e.g.:
//   Out of memory: Killed process 30149 (python3) total-vm:3182368kB, anon-rss:29208kB, file-rss:316kB, ...
// We return the LAST match so a session with several kills reports the final
// victim. Returns null when no victim line is present — e.g. dmesg is empty or
// unreadable (restricted CAP_SYSLOG), in which case the caller degrades to the
// count-only signal it emitted before.
export function parseOomVictim(kernelLog: string): OomVictim | null {
  const re = /Killed process (\d+) \(([^)]+)\)[^\n]*?anon-rss:(\d+)kB/g;
  let match: RegExpExecArray | null;
  let last: OomVictim | null = null;
  while ((match = re.exec(kernelLog)) !== null) {
    last = { pid: Number(match[1]), comm: match[2], anonRssMb: Math.round(Number(match[3]) / 1024) };
  }
  return last;
}
