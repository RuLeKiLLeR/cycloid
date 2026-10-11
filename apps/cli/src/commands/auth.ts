import type { Command } from "commander";

import { apiFetch } from "../api.js";
import { emit, resolveBusinessContext, type RuntimeOptions } from "../runtime.js";

export async function whoamiCommand(options: { json?: boolean } & RuntimeOptions, command?: Command): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const payload = await apiFetch<Record<string, unknown>>(config, "/api/auth/whoami");
  emit(command, options, payload, (whoami) => {
    console.log(`User: ${String(whoami.email ?? whoami.userId ?? "unknown")}`);
    if (whoami.tokenScope) console.log(`Token scope: ${String(whoami.tokenScope)}`);
  });
}
