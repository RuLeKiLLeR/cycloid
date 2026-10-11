type E2BCompatSmokeResult = {
  sandboxId: string;
  commandStdout: string;
  commandExitCode: number;
  finalState: "paused" | "killed";
};

type E2BCompatSandbox = {
  sandboxId: string;
  commands: {
    run(command: string, options: { timeoutMs: number }): Promise<{ stdout: string; exitCode: number }>;
  };
  pause(): Promise<unknown>;
  kill(): Promise<unknown>;
};

let sandboxSdkPromise: Promise<{
  create(
    template: string,
    options: {
      apiKey: string;
      domain?: string;
      timeoutMs: number;
      lifecycle: { onTimeout: "pause"; autoResume: false };
    },
  ): Promise<E2BCompatSandbox>;
}> | null = null;

async function loadSandboxSdk(): Promise<{
  create(
    template: string,
    options: {
      apiKey: string;
      domain?: string;
      timeoutMs: number;
      lifecycle: { onTimeout: "pause"; autoResume: false };
    },
  ): Promise<E2BCompatSandbox>;
}> {
  sandboxSdkPromise ??= import("e2b").then((module) => module.Sandbox);
  return sandboxSdkPromise;
}

export async function runE2BCompatSmoke(config: {
  apiKey: string;
  template: string;
  domain?: string;
  timeoutMs: number;
  cleanup: "pause" | "kill";
}): Promise<E2BCompatSmokeResult> {
  if (!config.apiKey) throw new Error("E2B_API_KEY is required for compatibility smoke");
  if (!config.template) throw new Error("E2B_SANDBOX_TEMPLATE is required for compatibility smoke");

  const Sandbox = await loadSandboxSdk();
  const sandbox = await Sandbox.create(config.template, {
    apiKey: config.apiKey,
    ...(config.domain ? { domain: config.domain } : {}),
    timeoutMs: config.timeoutMs,
    lifecycle: {
      onTimeout: "pause",
      autoResume: false,
    },
  });

  try {
    const command = await sandbox.commands.run("echo cycloid-e2b-ok", {
      timeoutMs: 30_000,
    });

    return {
      sandboxId: sandbox.sandboxId,
      commandStdout: command.stdout,
      commandExitCode: command.exitCode,
      finalState: config.cleanup === "pause" ? "paused" : "killed",
    };
  } finally {
    if (config.cleanup === "pause") {
      await sandbox.pause();
    } else {
      await sandbox.kill();
    }
  }
}
