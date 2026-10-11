import type { Command } from "commander";

import { apiFetch } from "../api.js";
import { ApiError, CliError } from "../errors.js";
import {
  confirmOrThrow,
  emit,
  isJson,
  randomIdempotencyKey,
  resolveBusinessContext,
  type RuntimeOptions,
} from "../runtime.js";

const MAX_ALL_PAGES = 1000;

export async function listTokensCommand(
  options: { limit?: string; cursor?: string; all?: boolean; json?: boolean } & RuntimeOptions,
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const data: Array<Record<string, unknown>> = [];
  let cursor: string | undefined = options.cursor;
  let nextCursor: string | null = null;
  let pageCount = 0;
  do {
    pageCount += 1;
    if (options.all === true && pageCount > MAX_ALL_PAGES) {
      throw new CliError("user", `tokens list --all exceeded ${MAX_ALL_PAGES} pages without reaching the end.`);
    }
    const query = new URLSearchParams();
    if (options.limit) query.set("limit", options.limit);
    if (cursor) query.set("cursor", cursor);
    const payload = await apiFetch<{ data: Array<Record<string, unknown>>; nextCursor: string | null }>(
      config,
      `/api/cli-tokens${query.size ? `?${query.toString()}` : ""}`,
    );
    data.push(...payload.data);
    nextCursor = payload.nextCursor;
    cursor = nextCursor ?? undefined;
  } while (options.all === true && nextCursor);
  const payload = { data, nextCursor: options.all === true ? null : nextCursor };
  emit(command, options, payload, (listPayload) => {
    if (listPayload.data.length === 0) {
      console.log("No CLI tokens found.");
      return;
    }
    for (const token of listPayload.data) {
      console.log(
        `${String(token.id)}\t${String(token.scope)}\t${String(token.tokenPrefix)}\t${String(token.revokedAt ? "revoked" : "active")}`,
      );
    }
    if (listPayload.nextCursor) console.log(`Next cursor: ${listPayload.nextCursor}`);
  });
}

export async function createTokenCommand(
  options: {
    scope?: "read" | "write";
    expiresInDays?: string;
    idempotencyKey?: string;
    json?: boolean;
  } & RuntimeOptions,
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const expiresInDays = options.expiresInDays === undefined ? undefined : Number(options.expiresInDays);
  if (expiresInDays !== undefined && (!Number.isInteger(expiresInDays) || expiresInDays <= 0)) {
    throw new CliError("user", "expiresInDays must be a positive integer.");
  }
  let payload: Record<string, unknown>;
  try {
    payload = await apiFetch<Record<string, unknown>>(config, "/api/cli-tokens", {
      method: "POST",
      headers: { "Idempotency-Key": options.idempotencyKey ?? randomIdempotencyKey() },
      body: JSON.stringify({
        scope: options.scope ?? "read",
        ...(expiresInDays !== undefined ? { expiresInDays } : {}),
      }),
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.data?.serverCode === "duplicate_request") {
      throw new CliError(err.code, err.message, {
        exitCode: err.exitCode,
        requestId: err.requestId,
        data: err.data,
        hint: "Use a new --idempotency-key for a new token, or retry the original command only if the first result was lost.",
      });
    }
    throw err;
  }
  emit(command, options, payload, (tokenPayload) => {
    console.log(`Token: ${String(tokenPayload.token)}`);
    console.log(`ID: ${String(tokenPayload.id)}`);
    console.log(`Scope: ${String(tokenPayload.scope)}`);
  });
}

export async function revokeTokenCommand(
  tokenId: string,
  options: { yes?: boolean; json?: boolean } & RuntimeOptions,
  command?: Command,
): Promise<void> {
  if (isJson(command, options) && options.yes !== true) {
    throw new CliError("user", "`tokens revoke --json` requires --yes.");
  }
  if (options.yes !== true) {
    await confirmOrThrow(`Revoke CLI token ${tokenId}?`);
  }
  const { config } = resolveBusinessContext(command, options);
  const payload = await apiFetch<Record<string, unknown>>(config, `/api/cli-tokens/${tokenId}/revoke`, {
    method: "POST",
  });
  emit(command, options, payload, () => console.log(`Revoked token ${tokenId}.`));
}
