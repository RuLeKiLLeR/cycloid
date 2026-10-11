import { ENVIRONMENT } from "../../../../shared/constants/environment.js";
import type { Env } from "../types";

const DEFAULT_CPU_COUNT = 2;
const DEFAULT_MEMORY_MB = 4096;
const DEFAULT_TIMEOUT_MS = 3_600_000;
const DEFAULT_SPEC_KEY = "default";
const QA_MAX_MEMORY_MB = 8192;
const TEMPLATE_SUFFIX_RE = /^[a-z0-9][a-z0-9-]*$/;

export type RepoSandboxSpecInput = {
  repo: `${string}/${string}`;
  cpuCount?: number;
  memoryMB?: number;
  timeoutMs?: number;
  templateSuffix?: string;
  // Rootfs disk sizing in whole GiB. Consumed ONLY by the Freestyle create path
  // (maps to vms.create rootfsSizeGb); E2B disk is fixed per team/template, so this
  // dimension never enters the E2B template id and the E2B client ignores it. Unset
  // means "keep the base snapshot's rootfs" — no change from today.
  diskGB?: number;
};

export type ResolvedRepoSandboxSpec = {
  repoOwner: string;
  repoName: string;
  source: "default" | "repo";
  specKey: string;
  cpuCount: number;
  memoryMB: number;
  timeoutMs: number;
  runtimeTemplateId: string;
  // True only when the repo's entry explicitly configures sizing. A non-sizing entry
  // (e.g. timeout-only) still resolves source:"repo" but with the DEFAULTED 2/4096
  // sizing — smaller than the Freestyle base snapshot's baked 8 GiB / 4 vCPU — so the
  // Freestyle path must send sizing only when this is true, or a timeout-only entry
  // would silently SHRINK the VM below the baseline an unspecced repo keeps.
  sizingExplicit: boolean;
  // Freestyle-only rootfs sizing (GiB); undefined for unspecced repos and every repo
  // that omits it, leaving the Freestyle create call byte-identical to today.
  diskGB?: number;
};

export type ResolvedRepoSandboxSizing = Pick<ResolvedRepoSandboxSpec, "specKey" | "cpuCount" | "memoryMB">;

type NormalizedRepoSandboxSpec = {
  repoOwner: string;
  repoName: string;
  specKey: string;
  cpuCount: number;
  memoryMB: number;
  sizingExplicit: boolean;
  timeoutMs?: number;
  templateSuffix?: string;
  diskGB?: number;
};

// Repos listed here are bumped above the default tier; every unlisted repo
// resolves to the default arc-default-template-mem4096-cpu2. A repo gets a larger
// sandbox by adding an explicit entry here (and a matching build in
// scripts/e2b-template-build.sh repo_sandbox_resource_specs).
// Specs above QA_MAX_MEMORY_MB are skipped by the QA E2B build because the QA E2B team
// caps per-sandbox memory at 8192 MiB; only prod builds those larger tiers.
const REPO_SANDBOX_SPECS = [
  { repo: "trycycloid/cycloid", cpuCount: 4, memoryMB: 8192 },
  { repo: "openevidence/xyla", cpuCount: 4, memoryMB: 16384 },
  // mialabs/mia docker-compose app runtime (postgres+redis+api+web) OOM-killed
  // on the default tier (kernel OOM, session 98230b94, 2026-07-02); mia-copy-4
  // is the trycycloid test copy exercising the same runtime.
  { repo: "mialabs/mia", cpuCount: 4, memoryMB: 8192 },
  { repo: "trycycloid/mia-copy-4", cpuCount: 4, memoryMB: 8192 },
] as const satisfies readonly RepoSandboxSpecInput[];

const NORMALIZED_REPO_SANDBOX_SPECS = normalizeRepoSandboxSpecs(REPO_SANDBOX_SPECS);
const REPO_SANDBOX_SPECS_BY_KEY = new Map(NORMALIZED_REPO_SANDBOX_SPECS.map((spec) => [spec.specKey, spec] as const));

export function resolveRepoSandboxSpec(env: Env, repoOwner: string, repoName: string): ResolvedRepoSandboxSpec {
  const key = repoSandboxSpecKey(repoOwner, repoName);
  const configuredSpec = resolveEffectiveRepoSandboxSpec(env, key);
  const templateBase = resolveDefaultE2BSandboxTemplate(env);
  const timeoutMs =
    configuredSpec?.timeoutMs ?? parsePositiveIntegerEnv(env.E2B_SANDBOX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const cpuCount = configuredSpec?.cpuCount ?? DEFAULT_CPU_COUNT;
  const memoryMB = configuredSpec?.memoryMB ?? DEFAULT_MEMORY_MB;

  return {
    repoOwner: configuredSpec?.repoOwner ?? normalizeRepoPart(repoOwner, "repo owner"),
    repoName: configuredSpec?.repoName ?? normalizeRepoPart(repoName, "repo name"),
    source: configuredSpec ? "repo" : "default",
    specKey: configuredSpec?.specKey ?? DEFAULT_SPEC_KEY,
    cpuCount,
    memoryMB,
    sizingExplicit: configuredSpec?.sizingExplicit ?? false,
    timeoutMs,
    runtimeTemplateId: resolveRuntimeTemplateId(templateBase, {
      cpuCount,
      memoryMB,
      templateSuffix: configuredSpec?.templateSuffix,
    }),
    // Disk is intentionally NOT folded into runtimeTemplateId: E2B disk is fixed per
    // team, so the template id stays mem<MB>-cpu<N>. Only the Freestyle path reads this.
    diskGB: configuredSpec?.diskGB,
  };
}

function resolveEffectiveRepoSandboxSpec(env: Env, key: string): NormalizedRepoSandboxSpec | undefined {
  const configuredSpec = REPO_SANDBOX_SPECS_BY_KEY.get(key);
  if (!configuredSpec) return undefined;
  if (env.WORKER_ENV === ENVIRONMENT.Qa && configuredSpec.memoryMB > QA_MAX_MEMORY_MB) {
    return undefined;
  }
  return configuredSpec;
}

export function resolveRepoSandboxSizingBySpecKey(specKey: string): ResolvedRepoSandboxSizing {
  const normalizedKey = specKey.trim().toLowerCase();
  if (normalizedKey === DEFAULT_SPEC_KEY) {
    return { specKey: DEFAULT_SPEC_KEY, cpuCount: DEFAULT_CPU_COUNT, memoryMB: DEFAULT_MEMORY_MB };
  }
  const configuredSpec = REPO_SANDBOX_SPECS_BY_KEY.get(normalizedKey);
  if (!configuredSpec) throw new Error(`Unknown repo sandbox spec key: ${specKey}`);
  return {
    specKey: configuredSpec.specKey,
    cpuCount: configuredSpec.cpuCount,
    memoryMB: configuredSpec.memoryMB,
  };
}

export function normalizeRepoSandboxSpecs(
  specs: readonly RepoSandboxSpecInput[],
): readonly NormalizedRepoSandboxSpec[] {
  const seen = new Set<string>();
  return specs.map((spec) => {
    const [rawOwner, rawName, ...extra] = spec.repo.split("/");
    if (!rawOwner || !rawName || extra.length > 0) {
      throw new Error(`Invalid repo sandbox spec repo: ${spec.repo}`);
    }
    const repoOwner = normalizeRepoPart(rawOwner, "repo owner");
    const repoName = normalizeRepoPart(rawName, "repo name");
    const specKey = `${repoOwner}/${repoName}`;
    if (seen.has(specKey)) {
      throw new Error(`Duplicate repo sandbox spec for ${specKey}`);
    }
    seen.add(specKey);

    // Sizing is all-or-nothing: a partial entry would ride the 2/4096 defaults for
    // the missing dimension, which on Freestyle downsizes the VM below the base
    // snapshot's 8 GiB / 4 vCPU. Throwing here fails the module load (and therefore
    // every test and deploy) rather than shipping a silently shrunken VM.
    const sizingExplicit = spec.cpuCount !== undefined || spec.memoryMB !== undefined || spec.diskGB !== undefined;
    if (sizingExplicit && (spec.cpuCount === undefined || spec.memoryMB === undefined)) {
      throw new Error(`Partial sizing for ${specKey}: set both cpuCount and memoryMB (diskGB optional), or neither`);
    }
    const cpuCount = normalizePositiveInteger(spec.cpuCount ?? DEFAULT_CPU_COUNT, "cpuCount", specKey);
    const memoryMB = normalizePositiveInteger(spec.memoryMB ?? DEFAULT_MEMORY_MB, "memoryMB", specKey);
    const timeoutMs =
      spec.timeoutMs === undefined ? undefined : normalizePositiveInteger(spec.timeoutMs, "timeoutMs", specKey);
    const templateSuffix = spec.templateSuffix?.trim();
    if (templateSuffix && !TEMPLATE_SUFFIX_RE.test(templateSuffix)) {
      throw new Error(`Invalid templateSuffix for ${specKey}: ${spec.templateSuffix}`);
    }
    const diskGB = spec.diskGB === undefined ? undefined : normalizePositiveInteger(spec.diskGB, "diskGB", specKey);

    return {
      repoOwner,
      repoName,
      specKey,
      cpuCount,
      memoryMB,
      sizingExplicit,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(templateSuffix ? { templateSuffix } : {}),
      ...(diskGB !== undefined ? { diskGB } : {}),
    };
  });
}

function resolveDefaultE2BSandboxTemplate(env: Env): string {
  const configured = env.E2B_SANDBOX_TEMPLATE?.trim();
  if (configured) return configured;
  if (env.WORKER_ENV === ENVIRONMENT.Local) return "cycloid-sandbox-dev-local";
  throw new Error("E2B_SANDBOX_TEMPLATE is not configured");
}

export function resolveRuntimeTemplateId(
  templateBase: string,
  spec: { cpuCount: number; memoryMB: number; templateSuffix?: string },
): string {
  const trimmedBase = templateBase.trim();
  if (!trimmedBase) throw new Error("E2B_SANDBOX_TEMPLATE is not configured");
  // Every template carries an explicit `-mem<MB>-cpu<N>` suffix, including the
  // default tier, so the resolved name always advertises its resources (e.g.
  // arc-default-template-mem4096-cpu2). The base env var is the bare stem the
  // suffix is appended to; an explicit templateSuffix overrides the derived one.
  if (spec.templateSuffix) return `${trimmedBase}-${spec.templateSuffix}`;
  return `${trimmedBase}-mem${spec.memoryMB}-cpu${spec.cpuCount}`;
}

function repoSandboxSpecKey(repoOwner: string, repoName: string): string {
  return `${normalizeRepoPart(repoOwner, "repo owner")}/${normalizeRepoPart(repoName, "repo name")}`;
}

function normalizeRepoPart(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) throw new Error(`Invalid repo sandbox spec ${label}`);
  return normalized;
}

function normalizePositiveInteger(value: number, label: string, specKey: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${label} for repo sandbox spec ${specKey}: ${value}`);
  }
  return value;
}

function parsePositiveIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
