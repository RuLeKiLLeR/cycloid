export interface SessionSandboxRuntime {
  spawnSandbox(sessionId: string, spawnAttemptId?: string, operation?: string): Promise<void>;
}

interface SessionSandboxRuntimeHost {
  runSpawnSandbox(sessionId: string, spawnAttemptId?: string, operation?: string): Promise<void>;
}

export function createSessionSandboxRuntime(host: SessionSandboxRuntimeHost): SessionSandboxRuntime {
  return {
    spawnSandbox: (sessionId, spawnAttemptId, operation) => host.runSpawnSandbox(sessionId, spawnAttemptId, operation),
  };
}
