import { createRequire } from "node:module";

import { stringifyError } from "../../../shared/utils/errors.js";
import { normalizeBaseUrl } from "../../../shared/utils/url.js";
import type { CliConfig } from "./config.js";
import { ApiError, CliError } from "./errors.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export const CLI_USER_AGENT = `cycloid-cli/${version}`;
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
export const MIN_HTTP_TIMEOUT_MS = 1_000;
export const MAX_HTTP_TIMEOUT_MS = 600_000;
export const HTTP_TIMEOUT_ENV = "ARCANIST_HTTP_TIMEOUT_MS";

type WhoamiResponse = {
  businessId?: string | null;
};

export function parseHttpTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[HTTP_TIMEOUT_ENV];
  if (!raw) return DEFAULT_HTTP_TIMEOUT_MS;
  if (!/^\d+$/.test(raw)) {
    throw new CliError("user", `${HTTP_TIMEOUT_ENV} must be a positive integer between 1000 and 600000.`);
  }
  const value = Number(raw);
  if (value < MIN_HTTP_TIMEOUT_MS || value > MAX_HTTP_TIMEOUT_MS) {
    throw new CliError("user", `${HTTP_TIMEOUT_ENV} must be between 1000 and 600000 milliseconds.`);
  }
  return value;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function timeoutError(timeoutMs: number): CliError {
  return new CliError("server", `Network timeout after ${timeoutMs}ms.`, {
    hint: `Increase ${HTTP_TIMEOUT_ENV} for slow links, or check the API connection.`,
  });
}

async function apiRequest<T>(
  config: CliConfig,
  path: string,
  init: RequestInit | undefined,
  read: (res: Response) => Promise<T>,
): Promise<T> {
  // Keep direct CliConfig callers safe even if they bypass loadConfig().
  const timeoutMs = parseHttpTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(init?.headers);
    headers.set("Content-Type", "application/json");
    headers.set("User-Agent", CLI_USER_AGENT);
    headers.set("Authorization", `Bearer ${config.token}`);

    const res = await fetch(`${normalizeBaseUrl(config.apiUrl)}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch((err: unknown) => {
        if (isAbortError(err)) throw timeoutError(timeoutMs);
        return "";
      });
      throw new ApiError(res.status, body, res.headers.get("x-request-id") ?? undefined, resourceNounForPath(path));
    }

    return await read(res);
  } catch (err) {
    if (err instanceof CliError) throw err;
    if (isAbortError(err)) throw timeoutError(timeoutMs);
    throw new CliError("server", `Network error: ${stringifyError(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function resourceNounForPath(path: string): string | undefined {
  if (path.startsWith("/api/cli-tokens")) return "token";
  if (path.startsWith("/api/repos")) return "repo";
  if (path.startsWith("/api/sandbox")) return "sandbox";
  if (path.startsWith("/api/sessions")) return "session";
  return undefined;
}

export async function apiFetch<T = unknown>(config: CliConfig, path: string, init?: RequestInit): Promise<T> {
  return apiRequest(config, path, init, (res) => res.json() as Promise<T>);
}

export async function apiFetchText(config: CliConfig, path: string, init?: RequestInit): Promise<string> {
  return apiRequest(config, path, init, (res) => res.text());
}

export async function resolveBusinessId(
  config: CliConfig,
  options: { business?: string | undefined },
): Promise<string> {
  if (options.business && options.business.trim()) return options.business.trim();
  const whoami = await apiFetch<WhoamiResponse>(config, "/api/auth/whoami");
  if (whoami.businessId && whoami.businessId.trim()) return whoami.businessId;
  throw new CliError("user", "--business is required when the authenticated token has no business context.");
}
