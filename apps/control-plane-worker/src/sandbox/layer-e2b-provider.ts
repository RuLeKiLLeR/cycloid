import type { Logger } from "../logger";
import { emitRuntimeTerminateEvent } from "../session/e2b-runtime-lifecycle";
import type { Env } from "../types";
import type { E2BSandboxClient } from "./e2b-client";
import { compileSandboxLayerBuildCommands } from "./layer-compiler";
import type { SandboxLayerInstruction } from "./layer-parser";

type E2BTemplateApi = typeof import("e2b").Template;

export interface ProviderLogEntry {
  message: string;
  level?: string;
  timestamp?: string;
}

export interface SandboxLayerProviderAdapter {
  startBuild(input: {
    env: Env;
    baseTemplateRef: string;
    generatedName: string;
    instructions: SandboxLayerInstruction[];
    cpuCount: number;
    memoryMB: number;
    provenance: Record<string, string>;
    // Bust E2B's cached base pull so a rebuilt base template propagates into the
    // layer build. Left false for same-base rebuilds to keep them cache-fast.
    skipCache?: boolean;
    logger: Logger;
  }): Promise<{ providerTemplateRef: string; providerBuildId: string }>;
  getBuildStatus(input: {
    env: Env;
    providerTemplateRef: string;
    providerBuildId: string;
    logsOffset: number;
  }): Promise<{
    status: "building" | "ready" | "error";
    logEntries: ProviderLogEntry[];
    nextLogsOffset: number;
    error?: string;
  }>;
  createSmokeSandbox(input: {
    env: Env;
    providerTemplateRef: string;
    buildId: string;
    sourceId: string;
    timeoutMs: number;
  }): Promise<{ sandboxId: string }>;
  runSmokeCommand(input: {
    env: Env;
    sandboxId: string;
    command: string;
    timeoutMs: number;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  terminateSmokeSandbox(input: { env: Env; sandboxId: string }): Promise<void>;
}

export function getE2BSandboxLayerProviderAdapter(): SandboxLayerProviderAdapter {
  return new E2BSandboxLayerProviderAdapter();
}

class E2BSandboxLayerProviderAdapter implements SandboxLayerProviderAdapter {
  async startBuild(input: {
    env: Env;
    baseTemplateRef: string;
    generatedName: string;
    instructions: SandboxLayerInstruction[];
    cpuCount: number;
    memoryMB: number;
    provenance: Record<string, string>;
    skipCache?: boolean;
    logger: Logger;
  }): Promise<{ providerTemplateRef: string; providerBuildId: string }> {
    if (!input.env.E2B_API_KEY) throw new Error("provider_config_missing:E2B_API_KEY");
    const Template = await loadE2BTemplate();
    let template = Template().fromTemplate(input.baseTemplateRef);
    for (const command of compileSandboxLayerBuildCommands(input.instructions)) {
      template = template.runCmd(command, { user: "root" });
    }
    template = template.runCmd(writeProvenanceCommand(input.provenance), { user: "root" });
    template = template.runCmd("/app/ready-check.sh", { user: "root" });
    template = template.runCmd("test -r /etc/cycloid/layer-env.sh || true", { user: "root" });
    const result = await Template.buildInBackground(template, input.generatedName, {
      apiKey: input.env.E2B_API_KEY,
      ...(input.env.E2B_DOMAIN ? { domain: input.env.E2B_DOMAIN } : {}),
      cpuCount: input.cpuCount,
      memoryMB: input.memoryMB,
      // Threaded as a direct literal property (not a spread) so TS excess-property
      // checks the option against the SDK's build options type — proving skipCache
      // is honored, matching how apps/sandbox-e2b/template.ts passes it to Template.build.
      skipCache: input.skipCache ?? false,
    });
    return {
      providerTemplateRef: result.templateId,
      providerBuildId: result.buildId,
    };
  }

  async getBuildStatus(input: {
    env: Env;
    providerTemplateRef: string;
    providerBuildId: string;
    logsOffset: number;
  }): Promise<{
    status: "building" | "ready" | "error";
    logEntries: ProviderLogEntry[];
    nextLogsOffset: number;
    error?: string;
  }> {
    if (!input.env.E2B_API_KEY) throw new Error("provider_config_missing:E2B_API_KEY");
    const Template = await loadE2BTemplate();
    const result = await Template.getBuildStatus(
      { templateId: input.providerTemplateRef, buildId: input.providerBuildId },
      {
        apiKey: input.env.E2B_API_KEY,
        ...(input.env.E2B_DOMAIN ? { domain: input.env.E2B_DOMAIN } : {}),
        logsOffset: input.logsOffset,
      },
    );
    const rawStatus = String(result.status);
    const resultRecord = result as unknown as Record<string, unknown>;
    const logs = normalizeProviderLogEntries(resultRecord.logs ?? resultRecord.logEntries);
    const nextLogsOffset =
      typeof resultRecord.nextLogsOffset === "number"
        ? resultRecord.nextLogsOffset
        : typeof resultRecord.logsOffset === "number"
          ? resultRecord.logsOffset
          : input.logsOffset + logs.length;
    return {
      status:
        rawStatus === "ready" || rawStatus === "success" || rawStatus === "finished"
          ? "ready"
          : rawStatus === "error" || rawStatus === "failed"
            ? "error"
            : "building",
      logEntries: logs,
      nextLogsOffset,
      error: readErrorMessage(result),
    };
  }

  async createSmokeSandbox(input: {
    env: Env;
    providerTemplateRef: string;
    buildId: string;
    sourceId: string;
    timeoutMs: number;
  }): Promise<{ sandboxId: string }> {
    const client = await createE2BClient(input.env);
    const sandboxId = crypto.randomUUID();
    const created = await client.createSandbox({
      sandboxId,
      template: input.providerTemplateRef,
      timeoutMs: input.timeoutMs,
      envs: {},
      metadata: {
        runtime_provider: "e2b",
        purpose: "sandbox_layer_smoke",
        build_id: input.buildId,
        source_id: input.sourceId,
      },
    });
    return { sandboxId: created.runtimeSandboxId };
  }

  async runSmokeCommand(input: {
    env: Env;
    sandboxId: string;
    command: string;
    timeoutMs: number;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const client = await createE2BClient(input.env);
    return client.runCommand({
      runtimeSandboxId: input.sandboxId,
      command: input.command,
      timeoutMs: input.timeoutMs,
    });
  }

  async terminateSmokeSandbox(input: { env: Env; sandboxId: string }): Promise<void> {
    const client = await createE2BClient(input.env);
    const result = await client.terminateSandbox(input.sandboxId, "sandbox_layer_smoke");
    // Kill-path read channel (arm 3): completes the "every kill is queryable"
    // invariant, even though a smoke sandbox is never a live session runtime.
    await emitRuntimeTerminateEvent({
      env: input.env,
      sessionId: null,
      runtimeSandboxId: input.sandboxId,
      reason: "sandbox_layer_smoke",
      terminateOutcome: result.status,
    });
  }
}

async function loadE2BTemplate(): Promise<E2BTemplateApi> {
  const { Template } = await import("e2b");
  return Template;
}

// E2B-pinned: this is the per-provider sandbox-LAYER build adapter, not the
// swappable runtime client. It drives E2B-only surface (Template API, layer
// build commands), so it intentionally constructs the concrete E2BSandboxClient
// and does NOT go through createSandboxProviderClient.
async function createE2BClient(env: Env): Promise<E2BSandboxClient> {
  const { E2BSandboxClient } = await import("./e2b-client");
  return new E2BSandboxClient({
    apiKey: env.E2B_API_KEY,
    domain: env.E2B_DOMAIN,
  });
}

function writeProvenanceCommand(provenance: Record<string, string>): string {
  const json = JSON.stringify(provenance);
  return [
    "install -d -m 0755 /etc/cycloid",
    "cat > /etc/cycloid/sandbox-layer-build.json <<'EOF'",
    json,
    "EOF",
    "chown root:root /etc/cycloid/sandbox-layer-build.json",
    "chmod 0644 /etc/cycloid/sandbox-layer-build.json",
  ].join("\n");
}

function normalizeProviderLogEntries(value: unknown): ProviderLogEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string") return { message: entry };
    if (!entry || typeof entry !== "object") return { message: String(entry) };
    const record = entry as Record<string, unknown>;
    return {
      message: String(record.message ?? record.line ?? record.text ?? JSON.stringify(record)),
      ...(typeof record.level === "string" ? { level: record.level } : {}),
      ...(typeof record.timestamp === "string" ? { timestamp: record.timestamp } : {}),
    };
  });
}

function readErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const error = (value as Record<string, unknown>).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string") {
    return (error as Record<string, string>).message;
  }
  return undefined;
}
