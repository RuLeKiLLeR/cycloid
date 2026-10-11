import { createHash } from "crypto";
import { chmodSync, writeFileSync } from "fs";

import {
  GITHUB_ACTION_AUTH_DERIVATION_PREFIX,
  GITHUB_ACTION_AUTH_FILE_ENV,
} from "../../../../shared/constants/github-action-auth.js";

export function deriveGithubActionAuthToken(sandboxAuthToken: string): string {
  const sandboxAuthTokenHash = createHash("sha256").update(sandboxAuthToken).digest("hex");
  return createHash("sha256").update(`${GITHUB_ACTION_AUTH_DERIVATION_PREFIX}${sandboxAuthTokenHash}`).digest("hex");
}

export function writeGithubActionAuthFile(path: string, sandboxAuthToken: string): void {
  writeFileSync(path, deriveGithubActionAuthToken(sandboxAuthToken), { encoding: "utf-8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function installGithubActionAuth(sandboxAuthToken: string): { path?: string; reason?: string } {
  const path = process.env[GITHUB_ACTION_AUTH_FILE_ENV] || "/tmp/cycloid-github-action-auth-token";
  try {
    writeGithubActionAuthFile(path, sandboxAuthToken);
  } catch {
    return { reason: "write_failed" };
  }
  process.env[GITHUB_ACTION_AUTH_FILE_ENV] = path;
  return { path };
}
