import type { Command } from "commander";

import { apiFetch } from "../api.js";
import { resolveLoginApiUrl, saveConfig } from "../config.js";
import { ApiError, CliError } from "../errors.js";
import { getRuntimeOptions, readHiddenPrompt, readStdinTrimmed, type RuntimeOptions, writeJson } from "../runtime.js";

export async function loginCommand(
  options: { tokenStdin?: boolean; apiUrl?: string; json?: boolean } & RuntimeOptions,
  command?: Command,
): Promise<void> {
  const runtime = getRuntimeOptions(command, options);
  let token: string;

  if (options.tokenStdin) {
    token = await readStdinTrimmed();
  } else if (runtime.token) {
    token = runtime.token;
  } else {
    token = await readHiddenPrompt("Enter your CLI token: ");
  }

  if (!token) {
    throw new CliError("user", "No token provided.");
  }

  if (!token.startsWith("arc_")) {
    throw new CliError("user", "Invalid token format. Token must start with 'arc_'.");
  }

  const apiUrl = resolveLoginApiUrl(runtime.apiUrl);

  saveConfig({ apiUrl, token });
  if (runtime.json) {
    writeJson({ ok: true, apiUrl });
  } else if (!runtime.quiet) {
    console.log(`Logged in. API: ${apiUrl}`);
  }

  try {
    await apiFetch({ apiUrl, token }, "/api/cli-tokens");
    if (!runtime.json && !runtime.quiet) console.log("Token verified.");
  } catch (err) {
    if (!runtime.json && !runtime.quiet) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        console.warn("Warning: Token could not be verified (401). It may be invalid or expired.");
      } else {
        console.warn("Warning: Could not reach API to verify token.");
      }
    }
  }
}
