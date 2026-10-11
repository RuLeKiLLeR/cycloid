#!/usr/bin/env node

import { readFileSync } from "node:fs";

const tokenPath = process.env.DOGFOOD_SESSION_TOKEN_FILE?.trim() || "/tmp/cycloid-dogfood-session-token";
const defaultRepo = process.env.DOGFOOD_DEFAULT_REPO?.trim() || "trycycloid/cycloid";
const baseUrl = process.env.DOGFOOD_API_URL?.trim() || "http://127.0.0.1:3000";

function readToken() {
  const token = process.env.DOGFOOD_SESSION_TOKEN?.trim();
  if (token) return token;
  try {
    return readFileSync(tokenPath, "utf8").trim();
  } catch {
    return "";
  }
}

function fail(message) {
  console.error(`[dogfood-healthcheck] ${message}`);
  process.exit(1);
}

async function fetchJson(path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    signal: AbortSignal.timeout(1200),
    headers: {
      accept: "application/json",
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  return response.json();
}

const token = readToken();
if (!token) fail(`DOGFOOD_SESSION_TOKEN is missing and ${tokenPath} is not readable`);

try {
  await fetchJson("/api/health");
  const bootstrap = await fetchJson("/api/bootstrap", {
    headers: { cookie: `session_token=${token}` },
  });

  if (bootstrap?.authenticated !== true) fail("bootstrap rejected the dogfood session token");
  if (bootstrap?.settings?.defaultRepo !== defaultRepo) {
    fail(`bootstrap defaultRepo=${bootstrap?.settings?.defaultRepo ?? "null"} expected ${defaultRepo}`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
