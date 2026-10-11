import { createHash } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statfsSync,
} from "node:fs";

import { stringifyError } from "../../../../shared/utils/errors.js";

const CGROUP_ROOT = "/sys/fs/cgroup";
const PSI_ROOT = "/proc/pressure";
const PROC_SELF_STATUS_PATH = "/proc/self/status";
const PROC_LOADAVG_PATH = "/proc/loadavg";
const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const MACHINE_ID_PATHS = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
const CODEX_GLOBAL_CONFIG_DIR = "/root/.config/codex";

export interface RuntimeResourceSnapshot {
  schemaVersion: 2;
  capturedAtMs: number;
  hostIdentity?: {
    hostname?: string;
    bootIdHash?: string;
    machineIdHash?: string;
  };
  runtimeResources?: {
    provider?: string;
    environment?: string;
    cpuRequest?: number;
    cpuLimit?: number;
    memoryRequestMb?: number;
    memoryLimitMb?: number;
  };
  cgroup?: {
    cpu?: CgroupCpuSnapshot;
    memory?: CgroupMemorySnapshot;
    pids?: CgroupPidsSnapshot;
  };
  pressure?: Record<"cpu" | "io" | "memory", PressureSnapshot | null>;
  resourceSources?: ResourceSourcesSnapshot;
  process?: RuntimeProcessSnapshot;
  disks?: Record<string, DiskSnapshot | null>;
  codexConfig?: Record<"global" | "repo", CodexConfigSnapshot>;
  errors?: string[];
}

interface RuntimeResourceSnapshotOptions {
  repoPath?: string;
  includeCodexConfig?: boolean;
}

type NumericMap = Record<string, number>;

interface CgroupCpuSnapshot {
  usage_usec?: number;
  user_usec?: number;
  system_usec?: number;
  nr_periods?: number;
  nr_throttled?: number;
  throttled_usec?: number;
  cpuMax?: string;
  cpuWeight?: string;
}

interface CgroupMemorySnapshot {
  currentBytes?: number;
  maxBytes?: number | "max";
  swapCurrentBytes?: number;
  swapMaxBytes?: number | "max";
  events?: NumericMap;
  peakBytes?: number;
}

interface CgroupPidsSnapshot {
  current?: number;
  max?: number | "max";
  events?: NumericMap;
}

interface PressureWindow {
  avg10?: number;
  avg60?: number;
  avg300?: number;
  total?: number;
}

interface PressureSnapshot {
  some?: PressureWindow;
  full?: PressureWindow;
}

interface DiskSnapshot {
  path: string;
  exists: boolean;
  type?: number;
  blockSize?: number;
  totalBytes?: number;
  freeBytes?: number;
  availableBytes?: number;
  totalFiles?: number;
  freeFiles?: number;
}

type ResourceSourceKey =
  | "cgroupRoot"
  | "cgroupCpuStat"
  | "cgroupCpuMax"
  | "cgroupCpuWeight"
  | "cgroupMemoryCurrent"
  | "cgroupMemoryMax"
  | "cgroupMemoryEvents"
  | "cgroupMemoryPeak"
  | "cgroupPidsCurrent"
  | "cgroupPidsMax"
  | "cgroupPidsEvents"
  | "psiCpu"
  | "psiIo"
  | "psiMemory"
  | "procSelfStatus"
  | "procLoadavg";

type ResourceSourcesSnapshot = Record<ResourceSourceKey, FileState>;

interface RuntimeProcessSnapshot {
  pid: number;
  uptimeSeconds: number;
  memoryUsage: NodeJS.MemoryUsage;
  resourceUsage: NodeJS.ResourceUsage;
  procSelfStatus?: ProcSelfStatusSnapshot;
  loadavg?: LoadavgSnapshot;
}

interface ProcSelfStatusSnapshot {
  vmRssBytes?: number;
  vmHwmBytes?: number;
  vmSizeBytes?: number;
  threads?: number;
  voluntaryContextSwitches?: number;
  nonvoluntaryContextSwitches?: number;
}

interface LoadavgSnapshot {
  oneMinute?: number;
  fiveMinute?: number;
  fifteenMinute?: number;
  runnableEntities?: number;
  totalEntities?: number;
  lastPid?: number;
}

interface CodexConfigSnapshot {
  path: string;
  exists: boolean;
  packageJson: FileState;
  packageLock: FileState;
  nodeModules: FileState;
  nodeModulesRealPath?: string;
  errors?: string[];
}

interface FileState {
  exists: boolean;
  readable?: boolean;
  kind?: "file" | "directory" | "symlink" | "other";
  realpath?: string;
}

export function runtimeResourceLogFields(
  snapshot: RuntimeResourceSnapshot,
  delta?: Record<string, unknown>,
): Record<string, unknown> {
  const deltaFields = delta ? runtimeDeltaLogFields(delta) : {};
  return {
    runtimeResourceSchemaVersion: snapshot.schemaVersion,
    runtimeCapturedAtMs: snapshot.capturedAtMs,
    ...(snapshot.hostIdentity ? { runtimeHost: snapshot.hostIdentity } : {}),
    ...(snapshot.runtimeResources ? { runtimeResources: snapshot.runtimeResources } : {}),
    ...(snapshot.cgroup?.cpu ? { runtimeCpu: snapshot.cgroup.cpu } : {}),
    ...(snapshot.cgroup?.memory ? { runtimeMemory: snapshot.cgroup.memory } : {}),
    ...(snapshot.pressure?.cpu ? { runtimePressureCpu: snapshot.pressure.cpu } : {}),
    ...(snapshot.pressure?.io ? { runtimePressureIo: snapshot.pressure.io } : {}),
    ...(snapshot.pressure?.memory ? { runtimePressureMemory: snapshot.pressure.memory } : {}),
    ...(snapshot.resourceSources ? { runtimeResourceSources: snapshot.resourceSources } : {}),
    ...(snapshot.resourceSources
      ? { runtimeResourceAvailability: resourceSourceAvailability(snapshot.resourceSources) }
      : {}),
    ...(snapshot.process ? { runtimeProcess: snapshot.process } : {}),
    ...(snapshot.disks ? diskLogFields(snapshot.disks) : {}),
    ...(snapshot.codexConfig?.global ? { runtimeCodexGlobalConfig: snapshot.codexConfig.global } : {}),
    ...(snapshot.codexConfig?.repo ? { runtimeCodexRepoConfig: snapshot.codexConfig.repo } : {}),
    ...(snapshot.errors ? { runtimeSnapshotErrors: snapshot.errors } : {}),
    ...deltaFields,
  };
}

export function collectRuntimeResourceSnapshot(options: RuntimeResourceSnapshotOptions = {}): RuntimeResourceSnapshot {
  const errors: string[] = [];
  const snapshot: RuntimeResourceSnapshot = {
    schemaVersion: 2,
    capturedAtMs: Date.now(),
  };

  assignIfPresent(snapshot, "hostIdentity", () => collectHostIdentity());
  assignIfPresent(snapshot, "runtimeResources", () => collectRuntimeResources());
  assignIfPresent(snapshot, "cgroup", () => collectCgroup());
  assignIfPresent(snapshot, "pressure", () => collectPressure());
  assignIfPresent(snapshot, "resourceSources", () => collectResourceSources());
  assignIfPresent(snapshot, "process", () => collectProcessSnapshot());
  assignIfPresent(snapshot, "disks", () => collectDisks(options.repoPath));
  if (options.includeCodexConfig !== false) {
    assignIfPresent(snapshot, "codexConfig", () => collectCodexConfig(options.repoPath));
  }

  if (errors.length > 0) snapshot.errors = errors;
  return snapshot;

  function assignIfPresent<K extends keyof RuntimeResourceSnapshot>(
    target: RuntimeResourceSnapshot,
    key: K,
    collect: () => RuntimeResourceSnapshot[K],
  ) {
    try {
      const value = collect();
      if (value !== undefined) {
        target[key] = value;
      }
    } catch (error) {
      errors.push(`${String(key)}:${stringifyError(error)}`);
    }
  }
}

// Compact per-sandbox resource sample derived from one snapshot (plus the prior
// snapshot for the CPU rate). Every field is optional: it is omitted when its
// cgroup/PSI/statfs source is unreadable so the control plane simply skips that
// gauge rather than emitting a bogus zero. Shape mirrors the
// `sandbox_resource_sample` bridge event payload (shared/events/bridge.ts).
export interface SandboxResourceSample {
  memoryUsedBytes?: number;
  memoryLimitBytes?: number;
  memoryUsedPercent?: number;
  swapUsedBytes?: number;
  cpuUsedPercent?: number;
  cpuThrottledPeriodsPercent?: number;
  cpuPressureAvg10?: number;
  memoryPressureAvg10?: number;
  memoryHighEventsDelta?: number;
  memoryOomEventsDelta?: number;
  memoryOomKillEventsDelta?: number;
  pidsCurrent?: number;
  pidsLimit?: number;
  pidsUsedPercent?: number;
  pidsMaxEventsDelta?: number;
  disks?: Array<{ mount: string; usedPercent?: number; usedBytes?: number; totalBytes?: number; availBytes?: number }>;
}

// Maps a full disk path to a short, low-cardinality `mount` tag for Datadog.
function diskMountLabel(path: string): string {
  if (path === "/root") return "root";
  if (path === "/workspace") return "workspace";
  return "repo";
}

// Resolve the cgroup CPU core allowance from `cpu.max` ("quota period", e.g.
// "400000 100000" = 4 cores) so CPU can be normalized to 0-100% of capacity.
// Falls back to the injected runtime cpu limit; undefined when neither is known.
function resolveCpuCores(snapshot: RuntimeResourceSnapshot): number | undefined {
  const cpuMax = snapshot.cgroup?.cpu?.cpuMax?.trim();
  if (cpuMax && cpuMax !== "max") {
    const [quota, period] = cpuMax.split(/\s+/, 2).map((value) => Number(value));
    if (Number.isFinite(quota) && Number.isFinite(period) && period > 0 && quota > 0) {
      return quota / period;
    }
  }
  const cpuLimit = snapshot.runtimeResources?.cpuLimit;
  return typeof cpuLimit === "number" && cpuLimit > 0 ? cpuLimit : undefined;
}

export function buildSandboxResourceSample(
  current: RuntimeResourceSnapshot,
  previous?: RuntimeResourceSnapshot,
): SandboxResourceSample {
  const sample: SandboxResourceSample = {};
  const memory = current.cgroup?.memory;

  const usedBytes = memory?.currentBytes;
  if (typeof usedBytes === "number") sample.memoryUsedBytes = usedBytes;

  const limitBytes =
    typeof memory?.maxBytes === "number"
      ? memory.maxBytes
      : typeof current.runtimeResources?.memoryLimitMb === "number"
        ? current.runtimeResources.memoryLimitMb * 1024 * 1024
        : undefined;
  if (typeof limitBytes === "number" && limitBytes > 0) {
    sample.memoryLimitBytes = limitBytes;
    if (typeof usedBytes === "number") {
      sample.memoryUsedPercent = round2((usedBytes / limitBytes) * 100);
    }
  }

  if (typeof memory?.swapCurrentBytes === "number") sample.swapUsedBytes = memory.swapCurrentBytes;

  // "some avg10" is the standard short-window memory-stall indicator — it climbs
  // before an OOM, so it is the leading pressure signal.
  const pressureAvg10 = current.pressure?.memory?.some?.avg10;
  if (typeof pressureAvg10 === "number") sample.memoryPressureAvg10 = pressureAvg10;

  const cpuPressureAvg10 = current.pressure?.cpu?.some?.avg10;
  if (typeof cpuPressureAvg10 === "number") sample.cpuPressureAvg10 = cpuPressureAvg10;

  if (previous) {
    assignNonNegativeDelta(
      sample,
      "memoryHighEventsDelta",
      previous.cgroup?.memory?.events?.high,
      memory?.events?.high,
    );
    assignNonNegativeDelta(sample, "memoryOomEventsDelta", previous.cgroup?.memory?.events?.oom, memory?.events?.oom);
    assignNonNegativeDelta(
      sample,
      "memoryOomKillEventsDelta",
      previous.cgroup?.memory?.events?.oom_kill,
      memory?.events?.oom_kill,
    );
  }

  // CPU% needs two samples: rate = Δusage_usec / Δwall_us, normalized to cores so
  // 100 = all allotted cores saturated (matches how `e2b sandbox metrics` reads).
  const usageBefore = previous?.cgroup?.cpu?.usage_usec;
  const usageAfter = current.cgroup?.cpu?.usage_usec;
  if (previous && typeof usageBefore === "number" && typeof usageAfter === "number") {
    const elapsedUs = (current.capturedAtMs - previous.capturedAtMs) * 1000;
    const cores = resolveCpuCores(current);
    if (elapsedUs > 0 && typeof cores === "number" && cores > 0) {
      const pct = ((usageAfter - usageBefore) / elapsedUs / cores) * 100;
      if (Number.isFinite(pct) && pct >= 0) sample.cpuUsedPercent = round2(pct);
    }

    const periodsBefore = previous.cgroup?.cpu?.nr_periods;
    const periodsAfter = current.cgroup?.cpu?.nr_periods;
    const throttledBefore = previous.cgroup?.cpu?.nr_throttled;
    const throttledAfter = current.cgroup?.cpu?.nr_throttled;
    if (
      typeof periodsBefore === "number" &&
      typeof periodsAfter === "number" &&
      typeof throttledBefore === "number" &&
      typeof throttledAfter === "number"
    ) {
      const periodDelta = periodsAfter - periodsBefore;
      const throttledDelta = throttledAfter - throttledBefore;
      if (periodDelta > 0 && throttledDelta >= 0) {
        sample.cpuThrottledPeriodsPercent = round2((throttledDelta / periodDelta) * 100);
      }
    }
  }

  const pids = current.cgroup?.pids;
  if (typeof pids?.current === "number") sample.pidsCurrent = pids.current;
  if (typeof pids?.max === "number" && pids.max > 0) {
    sample.pidsLimit = pids.max;
    if (typeof pids.current === "number") sample.pidsUsedPercent = round2((pids.current / pids.max) * 100);
  }
  if (previous) {
    assignNonNegativeDelta(sample, "pidsMaxEventsDelta", previous.cgroup?.pids?.events?.max, pids?.events?.max);
  }

  const disks = current.disks;
  if (disks) {
    const entries: NonNullable<SandboxResourceSample["disks"]> = [];
    for (const [path, disk] of Object.entries(disks)) {
      if (!disk || !disk.exists || typeof disk.totalBytes !== "number" || disk.totalBytes <= 0) continue;
      const freeBytes = typeof disk.availableBytes === "number" ? disk.availableBytes : disk.freeBytes;
      if (typeof freeBytes !== "number") continue;
      const used = disk.totalBytes - freeBytes;
      entries.push({
        mount: diskMountLabel(path),
        usedBytes: used,
        totalBytes: disk.totalBytes,
        usedPercent: round2((used / disk.totalBytes) * 100),
        // Absolute free bytes (statfs bavail) — the metric a "will this ENOSPC"
        // floor monitor needs. A % threshold false-positives on repos whose disk
        // baseline is structurally high (xyla sits ~97% and publishes fine).
        availBytes: freeBytes,
      });
    }
    if (entries.length > 0) sample.disks = entries;
  }

  return sample;
}

function assignNonNegativeDelta<K extends keyof SandboxResourceSample>(
  sample: SandboxResourceSample,
  key: K,
  before: number | undefined,
  after: number | undefined,
): void {
  if (typeof before !== "number" || typeof after !== "number") return;
  const delta = after - before;
  if (Number.isFinite(delta) && delta >= 0) {
    sample[key] = delta as SandboxResourceSample[K];
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function runtimeResourceDelta(
  before?: RuntimeResourceSnapshot,
  after?: RuntimeResourceSnapshot,
): Record<string, unknown> | undefined {
  if (!before || !after) return undefined;
  const cpuBefore = before.cgroup?.cpu;
  const cpuAfter = after.cgroup?.cpu;
  const memoryBefore = before.cgroup?.memory;
  const memoryAfter = after.cgroup?.memory;

  const delta: Record<string, unknown> = {
    elapsedMs: after.capturedAtMs - before.capturedAtMs,
  };

  const cpuDelta = numericDeltaMap(cpuBefore, cpuAfter, [
    "usage_usec",
    "user_usec",
    "system_usec",
    "nr_periods",
    "nr_throttled",
    "throttled_usec",
  ]);
  if (Object.keys(cpuDelta).length > 0) delta.cpu = cpuDelta;

  const memoryEventsDelta = numericDeltaMap(memoryBefore?.events, memoryAfter?.events);
  if (Object.keys(memoryEventsDelta).length > 0) delta.memoryEvents = memoryEventsDelta;

  if (typeof memoryBefore?.currentBytes === "number" && typeof memoryAfter?.currentBytes === "number") {
    delta.memoryCurrentBytes = memoryAfter.currentBytes - memoryBefore.currentBytes;
  }

  const pressureDelta = pressureTotalDelta(before.pressure, after.pressure);
  if (Object.keys(pressureDelta).length > 0) delta.pressureTotals = pressureDelta;

  return Object.keys(delta).length > 1 ? delta : undefined;
}

function collectHostIdentity(): RuntimeResourceSnapshot["hostIdentity"] {
  return {
    hostname: process.env.HOSTNAME,
    bootIdHash: hashFile(BOOT_ID_PATH),
    machineIdHash: MACHINE_ID_PATHS.map(hashFile).find(Boolean),
  };
}

function collectRuntimeResources(): RuntimeResourceSnapshot["runtimeResources"] {
  return {
    provider: process.env.ARCANIST_RUNTIME_PROVIDER,
    environment: process.env.ARCANIST_RUNTIME_ENVIRONMENT,
    cpuRequest: parseOptionalNumber(process.env.ARCANIST_RUNTIME_CPU_REQUEST),
    cpuLimit: parseOptionalNumber(process.env.ARCANIST_RUNTIME_CPU_LIMIT),
    memoryRequestMb: parseOptionalNumber(process.env.ARCANIST_RUNTIME_MEMORY_REQUEST_MB),
    memoryLimitMb: parseOptionalNumber(process.env.ARCANIST_RUNTIME_MEMORY_LIMIT_MB),
  };
}

function collectCgroup(): RuntimeResourceSnapshot["cgroup"] {
  return {
    cpu: {
      ...parseKeyValueNumbers(readOptional(`${CGROUP_ROOT}/cpu.stat`)),
      cpuMax: readOptional(`${CGROUP_ROOT}/cpu.max`)?.trim(),
      cpuWeight: readOptional(`${CGROUP_ROOT}/cpu.weight`)?.trim(),
    },
    memory: {
      currentBytes: parseOptionalNumber(readOptional(`${CGROUP_ROOT}/memory.current`)),
      maxBytes: parseMaxValue(readOptional(`${CGROUP_ROOT}/memory.max`)),
      swapCurrentBytes: parseOptionalNumber(readOptional(`${CGROUP_ROOT}/memory.swap.current`)),
      swapMaxBytes: parseMaxValue(readOptional(`${CGROUP_ROOT}/memory.swap.max`)),
      events: parseKeyValueNumbers(readOptional(`${CGROUP_ROOT}/memory.events`)),
      peakBytes: parseOptionalNumber(readOptional(`${CGROUP_ROOT}/memory.peak`)),
    },
    pids: {
      current: parseOptionalNumber(readOptional(`${CGROUP_ROOT}/pids.current`)),
      max: parseMaxValue(readOptional(`${CGROUP_ROOT}/pids.max`)),
      events: parseKeyValueNumbers(readOptional(`${CGROUP_ROOT}/pids.events`)),
    },
  };
}

function collectPressure(): RuntimeResourceSnapshot["pressure"] {
  return {
    cpu: parsePressure(readOptional(`${PSI_ROOT}/cpu`)),
    io: parsePressure(readOptional(`${PSI_ROOT}/io`)),
    memory: parsePressure(readOptional(`${PSI_ROOT}/memory`)),
  };
}

function collectResourceSources(): ResourceSourcesSnapshot {
  return {
    cgroupRoot: fileState(CGROUP_ROOT),
    cgroupCpuStat: fileState(`${CGROUP_ROOT}/cpu.stat`),
    cgroupCpuMax: fileState(`${CGROUP_ROOT}/cpu.max`),
    cgroupCpuWeight: fileState(`${CGROUP_ROOT}/cpu.weight`),
    cgroupMemoryCurrent: fileState(`${CGROUP_ROOT}/memory.current`),
    cgroupMemoryMax: fileState(`${CGROUP_ROOT}/memory.max`),
    cgroupMemoryEvents: fileState(`${CGROUP_ROOT}/memory.events`),
    cgroupMemoryPeak: fileState(`${CGROUP_ROOT}/memory.peak`),
    cgroupPidsCurrent: fileState(`${CGROUP_ROOT}/pids.current`),
    cgroupPidsMax: fileState(`${CGROUP_ROOT}/pids.max`),
    cgroupPidsEvents: fileState(`${CGROUP_ROOT}/pids.events`),
    psiCpu: fileState(`${PSI_ROOT}/cpu`),
    psiIo: fileState(`${PSI_ROOT}/io`),
    psiMemory: fileState(`${PSI_ROOT}/memory`),
    procSelfStatus: fileState(PROC_SELF_STATUS_PATH),
    procLoadavg: fileState(PROC_LOADAVG_PATH),
  };
}

function collectProcessSnapshot(): RuntimeProcessSnapshot {
  return {
    pid: process.pid,
    uptimeSeconds: process.uptime(),
    memoryUsage: process.memoryUsage(),
    resourceUsage: process.resourceUsage(),
    procSelfStatus: parseProcSelfStatus(readOptional(PROC_SELF_STATUS_PATH)),
    loadavg: parseLoadavg(readOptional(PROC_LOADAVG_PATH)),
  };
}

function collectDisks(repoPath?: string): RuntimeResourceSnapshot["disks"] {
  const paths = new Set(["/root", "/workspace"]);
  if (repoPath) paths.add(repoPath);
  return Object.fromEntries([...paths].map((path) => [path, collectDisk(path)])) as Record<string, DiskSnapshot | null>;
}

function collectCodexConfig(repoPath?: string): RuntimeResourceSnapshot["codexConfig"] {
  return {
    global: collectCodexConfigDir(CODEX_GLOBAL_CONFIG_DIR),
    repo: collectCodexConfigDir(`${repoPath ?? process.cwd()}/.codex`),
  };
}

function collectCodexConfigDir(path: string): CodexConfigSnapshot {
  const errors: string[] = [];
  const snapshot: CodexConfigSnapshot = {
    path,
    exists: existsSync(path),
    packageJson: fileState(`${path}/package.json`),
    packageLock: fileState(`${path}/package-lock.json`),
    nodeModules: fileState(`${path}/node_modules`),
  };

  if (snapshot.nodeModules.exists) {
    try {
      snapshot.nodeModulesRealPath = realpathSync(`${path}/node_modules`);
    } catch (error) {
      errors.push(`nodeModulesRealPath:${stringifyError(error)}`);
    }
  }

  if (errors.length > 0) snapshot.errors = errors;
  return snapshot;
}

function collectDisk(path: string): DiskSnapshot | null {
  if (!existsSync(path)) return { path, exists: false };
  try {
    const stats = statfsSync(path);
    return {
      path,
      exists: true,
      type: Number(stats.type),
      blockSize: stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
      freeBytes: stats.bfree * stats.bsize,
      availableBytes: stats.bavail * stats.bsize,
      totalFiles: stats.files,
      freeFiles: stats.ffree,
    };
  } catch {
    return null;
  }
}

function fileState(path: string): FileState {
  try {
    const stats = lstatSync(path);
    const kind = stats.isSymbolicLink()
      ? "symlink"
      : stats.isFile()
        ? "file"
        : stats.isDirectory()
          ? "directory"
          : "other";
    const result: FileState = { exists: true, kind, readable: isReadable(path) };
    if (stats.isSymbolicLink()) {
      result.realpath = realpathSync(path);
    }
    return result;
  } catch {
    return { exists: false };
  }
}

function isReadable(path: string): boolean {
  try {
    accessSync(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function hashFile(path: string): string | undefined {
  const value = readOptional(path)?.trim();
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function parseKeyValueNumbers(content?: string): NumericMap {
  if (!content) return {};
  const result: NumericMap = {};
  for (const line of content.split("\n")) {
    const [key, value] = line.trim().split(/\s+/, 2);
    if (!key || value === undefined) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) result[key] = parsed;
  }
  return result;
}

function parseOptionalNumber(content?: string): number | undefined {
  if (!content) return undefined;
  const parsed = Number(content.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseMaxValue(content?: string): number | "max" | undefined {
  if (!content) return undefined;
  const trimmed = content.trim();
  if (trimmed === "max") return "max";
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parsePressure(content?: string): PressureSnapshot | null {
  if (!content) return null;
  const snapshot: PressureSnapshot = {};
  for (const line of content.split("\n")) {
    const [kind, ...fields] = line.trim().split(/\s+/);
    if (kind !== "some" && kind !== "full") continue;
    const window: PressureWindow = {};
    for (const field of fields) {
      const [key, value] = field.split("=", 2);
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) continue;
      if (key === "avg10" || key === "avg60" || key === "avg300" || key === "total") {
        window[key] = parsed;
      }
    }
    snapshot[kind] = window;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

function parseProcSelfStatus(content?: string): ProcSelfStatusSnapshot | undefined {
  if (!content) return undefined;
  const byKey = new Map<string, string>();
  for (const line of content.split("\n")) {
    const match = /^([^:]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    byKey.set(match[1], match[2]);
  }
  const snapshot: ProcSelfStatusSnapshot = {
    vmRssBytes: parseProcKb(byKey.get("VmRSS")),
    vmHwmBytes: parseProcKb(byKey.get("VmHWM")),
    vmSizeBytes: parseProcKb(byKey.get("VmSize")),
    threads: parseOptionalNumber(byKey.get("Threads")),
    voluntaryContextSwitches: parseOptionalNumber(byKey.get("voluntary_ctxt_switches")),
    nonvoluntaryContextSwitches: parseOptionalNumber(byKey.get("nonvoluntary_ctxt_switches")),
  };
  return Object.values(snapshot).some((value) => value !== undefined) ? snapshot : undefined;
}

function parseProcKb(content?: string): number | undefined {
  if (!content) return undefined;
  const match = /^(\d+)\s+kB$/i.exec(content.trim());
  if (!match) return parseOptionalNumber(content);
  return Number(match[1]) * 1024;
}

function parseLoadavg(content?: string): LoadavgSnapshot | undefined {
  if (!content) return undefined;
  const [oneMinute, fiveMinute, fifteenMinute, entities, lastPid] = content.trim().split(/\s+/);
  const [runnableEntities, totalEntities] = (entities ?? "").split("/", 2);
  const snapshot: LoadavgSnapshot = {
    oneMinute: parseOptionalNumber(oneMinute),
    fiveMinute: parseOptionalNumber(fiveMinute),
    fifteenMinute: parseOptionalNumber(fifteenMinute),
    runnableEntities: parseOptionalNumber(runnableEntities),
    totalEntities: parseOptionalNumber(totalEntities),
    lastPid: parseOptionalNumber(lastPid),
  };
  return Object.values(snapshot).some((value) => value !== undefined) ? snapshot : undefined;
}

function numericDeltaMap(before?: object, after?: object, keys?: string[]): NumericMap {
  const result: NumericMap = {};
  const beforeRecord = before as Record<string, unknown> | undefined;
  const afterRecord = after as Record<string, unknown> | undefined;
  const allKeys = keys ?? [...new Set([...Object.keys(beforeRecord ?? {}), ...Object.keys(afterRecord ?? {})])];
  for (const key of allKeys) {
    const beforeValue = beforeRecord?.[key];
    const afterValue = afterRecord?.[key];
    if (typeof beforeValue !== "number" || typeof afterValue !== "number") continue;
    result[key] = afterValue - beforeValue;
  }
  return result;
}

function pressureTotalDelta(
  before?: RuntimeResourceSnapshot["pressure"],
  after?: RuntimeResourceSnapshot["pressure"],
): Record<string, Record<string, NumericMap>> {
  const result: Record<string, Record<string, NumericMap>> = {};
  for (const resource of ["cpu", "io", "memory"] as const) {
    for (const kind of ["some", "full"] as const) {
      const delta = numericDeltaMap(before?.[resource]?.[kind], after?.[resource]?.[kind], ["total"]);
      if (Object.keys(delta).length === 0) continue;
      result[resource] ??= {};
      result[resource][kind] = delta;
    }
  }
  return result;
}

function runtimeDeltaLogFields(delta: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (typeof delta.elapsedMs === "number") fields.runtimeDeltaElapsedMs = delta.elapsedMs;
  if (delta.cpu && typeof delta.cpu === "object") fields.runtimeCpuDelta = delta.cpu;
  if (delta.memoryEvents && typeof delta.memoryEvents === "object") {
    fields.runtimeMemoryEventsDelta = delta.memoryEvents;
  }
  if (typeof delta.memoryCurrentBytes === "number") {
    fields.runtimeMemoryCurrentBytesDelta = delta.memoryCurrentBytes;
  }
  if (delta.pressureTotals && typeof delta.pressureTotals === "object") {
    fields.runtimePressureTotalsDelta = flattenPressureTotals(delta.pressureTotals);
  }
  return fields;
}

function diskLogFields(disks: Record<string, DiskSnapshot | null>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [path, snapshot] of Object.entries(disks)) {
    const key =
      path === "/root" ? "runtimeDiskRoot" : path === "/workspace" ? "runtimeDiskWorkspace" : "runtimeDiskRepo";
    fields[key] = snapshot;
  }
  return fields;
}

function resourceSourceAvailability(sources: ResourceSourcesSnapshot): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(sources).map(([key, state]) => [`${key}Readable`, state.exists && state.readable === true]),
  );
}

function flattenPressureTotals(value: unknown): NumericMap {
  const result: NumericMap = {};
  if (!value || typeof value !== "object") return result;
  for (const [resource, byKind] of Object.entries(value as Record<string, unknown>)) {
    if (!byKind || typeof byKind !== "object") continue;
    for (const [kind, metrics] of Object.entries(byKind as Record<string, unknown>)) {
      if (!metrics || typeof metrics !== "object") continue;
      const total = (metrics as Record<string, unknown>).total;
      if (typeof total === "number") result[`${resource}_${kind}_total`] = total;
    }
  }
  return result;
}
