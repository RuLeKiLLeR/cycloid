#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const COOKIE_NAME = "session_token";
const TOKEN_ENV = "DOGFOOD_SESSION_TOKEN";
const AUTH_STATUS_TIMEOUT_MS = 10_000;

function requiredEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalEnv(env, name) {
  const value = env[name]?.trim();
  return value || null;
}

function parseUrl(name, raw) {
  try {
    return new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
}

function parseRequiredUrl(env, name) {
  return parseUrl(name, requiredEnv(env, name));
}

function assertCookieSafe(value) {
  if (/[\r\n;]/.test(value)) {
    throw new Error("runtime session token contains characters that are not valid in a Cookie header");
  }
}

function resolveSessionToken(env) {
  const configuredToken = optionalEnv(env, TOKEN_ENV);
  if (!configuredToken) throw new Error(`${TOKEN_ENV} is required`);
  assertCookieSafe(configuredToken);
  return configuredToken;
}

async function assertSessionAccepted(baseUrl, sessionToken, fetchImpl) {
  const statusUrl = new URL("/auth/status", baseUrl);
  const response = await fetchImpl(statusUrl, {
    signal: AbortSignal.timeout(AUTH_STATUS_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      cookie: `${COOKIE_NAME}=${sessionToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`auth status probe failed with HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data?.authenticated !== true) {
    throw new Error("auth status probe rejected runtime session token");
  }
}

async function assertValidateUrlAccepted(validateUrl, sessionToken, fetchImpl) {
  if (!validateUrl) return;
  const response = await fetchImpl(validateUrl, {
    signal: AbortSignal.timeout(AUTH_STATUS_TIMEOUT_MS),
    headers: {
      accept: "application/json,text/html;q=0.9,*/*;q=0.8",
      cookie: `${COOKIE_NAME}=${sessionToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`auth validate probe failed with HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return;

  const data = await response.json();
  if (data?.authenticated !== true) {
    throw new Error("auth validate probe rejected runtime session token");
  }
}

function storageStateForSession(baseUrl, sessionToken) {
  return {
    cookies: [
      {
        name: COOKIE_NAME,
        value: sessionToken,
        domain: baseUrl.hostname,
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: baseUrl.protocol === "https:",
        sameSite: "Lax",
      },
    ],
    origins: [
      {
        origin: baseUrl.origin,
        localStorage: [{ name: "layout.authenticated_hint", value: "1" }],
      },
    ],
  };
}

export async function main(env = process.env, fetchImpl = globalThis.fetch) {
  const baseUrl = parseRequiredUrl(env, "ARCANIST_BASE_URL");
  const validateUrl = optionalEnv(env, "ARCANIST_AUTH_VALIDATE_URL");
  const parsedValidateUrl = validateUrl ? parseUrl("ARCANIST_AUTH_VALIDATE_URL", validateUrl) : null;
  const statePath = requiredEnv(env, "ARCANIST_AUTH_STATE_PATH");
  const sessionToken = resolveSessionToken(env);

  await assertSessionAccepted(baseUrl, sessionToken, fetchImpl);
  await assertValidateUrlAccepted(parsedValidateUrl, sessionToken, fetchImpl);

  const state = storageStateForSession(baseUrl, sessionToken);
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
