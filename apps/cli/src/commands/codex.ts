import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";

import { apiFetch } from "../api.js";
import { CliError, EXIT_CODE_INTERRUPTED } from "../errors.js";
import { emit, resolveBusinessContext, type RuntimeOptions } from "../runtime.js";

const CODEX_SUBSCRIPTION_PATH = "/api/settings/codex-subscription";
const CODEX_SUBSCRIPTION_AUTH_JSON_PATH = "/api/settings/codex-subscription/auth-json";
const CODEX_SUBSCRIPTION_ENABLED_PATH = "/api/settings/codex-subscription/enabled";

type CodexSubscriptionCredentialState = {
  isSet: boolean;
  lastValidationStatus?: string | null;
  lastValidationReasonCode?: string | null;
  updatedAt?: number | null;
};

type CodexSubscriptionStatePayload = {
  eligible: boolean;
  credential: CodexSubscriptionCredentialState;
};

function resolveCodexPath(optionPath?: string): string {
  return optionPath?.trim() || process.env.ARCANIST_CODEX_BIN?.trim() || "codex";
}

// Run the real `codex login --device-auth` under an isolated CODEX_HOME so the
// resulting auth.json never lands in the user's default ~/.codex and can't be
// picked up by an unrelated local Codex. stdio is inherited so the user sees the
// verification URL + code and completes approval on their device; the child
// blocks until login resolves, then writes `${CODEX_HOME}/auth.json`.
function runCodexDeviceLogin(codexPath: string, codexHome: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(codexPath, ["login", "--device-auth"], {
      stdio: "inherit",
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          new CliError("user", `Could not find the \`${codexPath}\` executable.`, {
            hint: "Install the Codex CLI, or point at it with --codex-path <path> or ARCANIST_CODEX_BIN.",
          }),
        );
        return;
      }
      reject(new CliError("user", `Failed to launch \`${codexPath} login --device-auth\`: ${err.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new CliError("user", `\`${codexPath} login --device-auth\` exited with code ${code ?? "unknown"}.`, {
          hint: "Complete the device approval in your browser, then re-run `cycloid codex login`.",
        }),
      );
    });
  });
}

async function setCodexSubscriptionEnabled(
  config: Parameters<typeof apiFetch>[0],
  enabled: boolean,
): Promise<{ useCodexSubscription: boolean }> {
  return apiFetch<{ useCodexSubscription: boolean }>(config, CODEX_SUBSCRIPTION_ENABLED_PATH, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

export async function codexLoginCommand(
  options: { codexPath?: string; json?: boolean } & RuntimeOptions,
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const codexPath = resolveCodexPath(options.codexPath);

  let codexHome: string | undefined;
  const handleSigint = () => {
    if (codexHome) {
      try {
        rmSync(codexHome, { recursive: true, force: true });
      } catch {}
    }
    process.exit(EXIT_CODE_INTERRUPTED);
  };
  process.on("SIGINT", handleSigint);
  try {
    codexHome = await mkdtemp(join(tmpdir(), "cycloid-codex-"));
    await runCodexDeviceLogin(codexPath, codexHome);

    let authJson: string;
    try {
      authJson = await readFile(join(codexHome, "auth.json"), "utf8");
    } catch {
      throw new CliError("user", "Codex login completed but no auth.json was written.", {
        hint: "Verify `codex login --device-auth` succeeds on its own, then re-run `cycloid codex login`.",
      });
    }
    if (!authJson.trim()) {
      throw new CliError("user", "Codex login produced an empty auth.json.");
    }

    // Reuse the exact endpoint the Settings UI "Save" hits; the control plane
    // enforces workspace eligibility, validates the auth.json, and stores it
    // encrypted per user. The CLI never persists the credential locally.
    const state = await apiFetch<CodexSubscriptionCredentialState>(config, CODEX_SUBSCRIPTION_AUTH_JSON_PATH, {
      method: "PUT",
      body: JSON.stringify({ authJson }),
    });

    // Logging in implies intent to use it, so activate the selector too. Best-effort:
    // the credential is already stored, so a failed activation must not fail login —
    // surface it and point at `cycloid codex use on`.
    let activated = false;
    let activationError: string | undefined;
    try {
      await setCodexSubscriptionEnabled(config, true);
      activated = true;
    } catch (err) {
      activationError = err instanceof Error ? err.message : String(err);
    }

    emit(command, options, { ...state, useCodexSubscription: activated }, (payload) => {
      console.log(
        activated
          ? "Codex subscription auth saved and activated for OpenAI sessions."
          : "Codex subscription auth saved.",
      );
      if (payload.lastValidationStatus) console.log(`Status: ${payload.lastValidationStatus}`);
      if (!activated) {
        console.log(`Could not activate it automatically${activationError ? ` (${activationError})` : ""}.`);
        console.log("Run `cycloid codex use on` to start using it.");
      }
    });
  } finally {
    try {
      if (codexHome) {
        await rm(codexHome, { recursive: true, force: true }).catch(() => {});
      }
    } finally {
      process.off("SIGINT", handleSigint);
    }
  }
}

export async function codexUseCommand(
  state: string,
  options: { json?: boolean } & RuntimeOptions,
  command?: Command,
): Promise<void> {
  const normalized = state.trim().toLowerCase();
  if (normalized !== "on" && normalized !== "off") {
    throw new CliError("user", "Usage: cycloid codex use <on|off>");
  }
  const enabled = normalized === "on";
  const { config } = resolveBusinessContext(command, options);
  const result = await setCodexSubscriptionEnabled(config, enabled);
  emit(command, options, result, () =>
    console.log(
      result.useCodexSubscription
        ? "Codex subscription auth is now used for OpenAI sessions."
        : "Codex subscription auth is no longer used for OpenAI sessions.",
    ),
  );
}

export async function codexStatusCommand(
  options: { json?: boolean } & RuntimeOptions,
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const payload = await apiFetch<CodexSubscriptionStatePayload>(config, CODEX_SUBSCRIPTION_PATH);
  emit(command, options, payload, (state) => {
    console.log(`Eligible: ${state.eligible ? "yes" : "no"}`);
    console.log(`Auth.json saved: ${state.credential.isSet ? "yes" : "no"}`);
    if (state.credential.lastValidationStatus) console.log(`Status: ${state.credential.lastValidationStatus}`);
  });
}

export async function codexLogoutCommand(
  options: { json?: boolean } & RuntimeOptions,
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  // Deactivate the selector first so there is no window where sessions are told to
  // use a subscription whose credential is about to be removed. Best-effort: the
  // clear below is the operation that matters.
  await setCodexSubscriptionEnabled(config, false).catch(() => {});
  const payload = await apiFetch<CodexSubscriptionCredentialState>(config, CODEX_SUBSCRIPTION_AUTH_JSON_PATH, {
    method: "DELETE",
  });
  emit(command, options, payload, () => console.log("Codex subscription auth deactivated and cleared."));
}
