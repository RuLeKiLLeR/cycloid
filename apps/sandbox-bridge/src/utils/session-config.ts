export type SessionConfig = Record<string, unknown>;

export type ManagedMcpRuntimeServer = {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, { value?: string; envVar?: string }>;
  envVars?: string[];
};

export function parseSessionConfig(raw = process.env.SESSION_CONFIG): SessionConfig {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SessionConfig) : {};
  } catch {
    return {};
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sessionConfigValue(config: SessionConfig, camelCaseKey: string, snakeCaseKey: string): string | undefined {
  return optionalString(config[camelCaseKey]) ?? optionalString(config[snakeCaseKey]);
}

export function getRestorableAgentSessionId(config: SessionConfig): string | undefined {
  return (
    sessionConfigValue(config, "agentSessionId", "agent_session_id") ??
    sessionConfigValue(config, "codexSessionId", "codex_session_id")
  );
}

export function getRestorableAgentSessionAgent(config: SessionConfig): string | undefined {
  return (
    sessionConfigValue(config, "agentSessionAgent", "agent_session_agent") ??
    sessionConfigValue(config, "codexSessionAgent", "codex_session_agent")
  );
}

export function getSessionAgentRole(config: SessionConfig): string | undefined {
  return sessionConfigValue(config, "agentRole", "agent_role");
}

export function getSessionAgentProfile(config: SessionConfig): string | undefined {
  return sessionConfigValue(config, "agentProfile", "agent_profile");
}

export function getSessionHarnessKind(config: SessionConfig): string | undefined {
  return sessionConfigValue(config, "harnessKind", "harness_kind");
}

export function getSessionRuntimeStartupProfile(config: SessionConfig): string | undefined {
  return sessionConfigValue(config, "runtimeStartupProfile", "runtime_startup_profile");
}

export function getSessionVerificationRuntimeMode(config: SessionConfig): string | undefined {
  return sessionConfigValue(config, "verificationRuntimeMode", "verification_runtime_mode");
}

export function getSessionTargetPrUrl(config: SessionConfig): string | undefined {
  return sessionConfigValue(config, "targetPrUrl", "target_pr_url");
}

export function getUseOpenAIFlexServiceTier(config: SessionConfig): boolean {
  return config.useOpenAIFlexServiceTier === true || config.use_openai_flex_service_tier === true;
}

function isManagedMcpRuntimeServer(value: unknown): value is ManagedMcpRuntimeServer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.length === 0) return false;
  if (record.transport !== "stdio" && record.transport !== "http" && record.transport !== "sse") return false;
  if (record.command !== undefined && typeof record.command !== "string") return false;
  if (record.url !== undefined && typeof record.url !== "string") return false;
  if (
    record.args !== undefined &&
    (!Array.isArray(record.args) || !record.args.every((arg) => typeof arg === "string"))
  ) {
    return false;
  }
  if (
    record.envVars !== undefined &&
    (!Array.isArray(record.envVars) || !record.envVars.every((name) => typeof name === "string"))
  ) {
    return false;
  }
  if (record.headers !== undefined) {
    if (!record.headers || typeof record.headers !== "object" || Array.isArray(record.headers)) return false;
    for (const headerConfig of Object.values(record.headers as Record<string, unknown>)) {
      if (!headerConfig || typeof headerConfig !== "object" || Array.isArray(headerConfig)) return false;
      const config = headerConfig as Record<string, unknown>;
      if (config.value !== undefined && typeof config.value !== "string") return false;
      if (config.envVar !== undefined && typeof config.envVar !== "string") return false;
    }
  }
  return true;
}

export function getManagedMcpServers(config: SessionConfig): ManagedMcpRuntimeServer[] {
  const raw = config.managedMcpServers ?? config.managed_mcp_servers;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isManagedMcpRuntimeServer);
}

export function hasRestorableAgentSession(config: SessionConfig): boolean {
  return Boolean(getRestorableAgentSessionId(config));
}
