import type { Env } from "../types";
import { resolveRepoSandboxSizingBySpecKey, resolveRepoSandboxSpec } from "./repo-sandbox-specs";

export interface SandboxLayerResourceProfile {
  key: string;
  cpuCount: number;
  memoryMB: number;
  timeoutMs: number;
  runtimeTemplateId: string;
}

export function resolveSandboxLayerResourceProfile(
  env: Env,
  repoOwner: string,
  repoName: string,
): SandboxLayerResourceProfile {
  const spec = resolveRepoSandboxSpec(env, repoOwner, repoName);
  return {
    key: spec.specKey,
    cpuCount: spec.cpuCount,
    memoryMB: spec.memoryMB,
    timeoutMs: spec.timeoutMs,
    runtimeTemplateId: spec.runtimeTemplateId,
  };
}

export function resolveSandboxLayerResourceSizingByKey(input: { resourceProfileKey: string }): {
  cpuCount: number;
  memoryMB: number;
} {
  const sizing = resolveRepoSandboxSizingBySpecKey(input.resourceProfileKey);
  return {
    cpuCount: sizing.cpuCount,
    memoryMB: sizing.memoryMB,
  };
}
