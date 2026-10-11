import { parseApiErrorBody } from "./utils/api-error.js";

export type CliErrorCode = "user" | "auth" | "not_found" | "conflict" | "server";

// Exit code for a user interrupt (Ctrl-C / SIGINT): 128 + SIGINT(2).
export const EXIT_CODE_INTERRUPTED = 130;

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly exitCode: number;
  readonly hint?: string;
  readonly requestId?: string;
  readonly data?: Record<string, unknown>;

  constructor(
    code: CliErrorCode,
    message: string,
    options: { exitCode?: number; hint?: string; requestId?: string; data?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = options.exitCode ?? exitCodeForErrorCode(code);
    this.hint = options.hint;
    this.requestId = options.requestId;
    this.data = options.data;
  }
}

export class ApiError extends CliError {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, requestId?: string, resourceNoun?: string) {
    const code = codeForHttpStatus(status);
    const parsed = parseApiErrorBody(body);
    super(code, messageForApiError(status, body, parsed), {
      exitCode: exitCodeForHttpStatus(status),
      hint: hintForHttpStatus(status, resourceNoun),
      requestId,
      data: parsed?.serverCode ? { serverCode: parsed.serverCode } : undefined,
    });
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function exitCodeForErrorCode(code: CliErrorCode): number {
  switch (code) {
    case "auth":
      return 2;
    case "not_found":
      return 3;
    case "conflict":
      return 4;
    case "server":
      return 10;
    case "user":
    default:
      return 1;
  }
}

export function codeForHttpStatus(status: number): CliErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 500) return "server";
  return "user";
}

function exitCodeForHttpStatus(status: number): number {
  return exitCodeForErrorCode(codeForHttpStatus(status));
}

function messageForApiError(status: number, body: string, parsed = parseApiErrorBody(body)): string {
  if (parsed?.message) return parsed.message;
  if (parsed?.serverCode) return parsed.serverCode;
  return body ? `API error ${status}: ${body}` : `API error ${status}`;
}

function hintForHttpStatus(status: number, resourceNoun?: string): string | undefined {
  if (status === 401 || status === 403) return "Run `cycloid auth login` or set `ARCANIST_TOKEN`.";
  if (status === 404) {
    if (resourceNoun === "token") return "List tokens with `cycloid tokens list`.";
    if (resourceNoun === "sandbox") return "Check sandbox state with `cycloid sandbox status`.";
    if (resourceNoun === "repo") return "Check accessible repositories with `cycloid repos list`.";
    return "List sessions with `cycloid sessions list`.";
  }
  if (status === 409) return "Check the current resource state and retry the command when it is ready.";
  if (status >= 500) return "Retry later or check the control-plane logs.";
  return undefined;
}

export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof Error) return new CliError("user", err.message);
  return new CliError("user", String(err));
}

export function formatJsonError(err: CliError): string {
  return JSON.stringify({
    error: {
      code: err.code,
      message: err.message,
      ...(err.hint ? { hint: err.hint } : {}),
      ...(err.requestId ? { requestId: err.requestId } : {}),
      ...(err.data ? { data: err.data } : {}),
    },
  });
}
