import type { ClientErrorDetails } from "../../../../shared/types/sandbox.js";
import { isRecord } from "../../../../shared/utils/type-guards.js";
import type { ErrorDetails } from "../ws/types.js";

function toClientErrorCause(errorDetails: ErrorDetails): NonNullable<ClientErrorDetails["cause"]> {
  return {
    message: errorDetails.message,
    ...(errorDetails.name ? { name: errorDetails.name } : {}),
    ...(errorDetails.errno ? { errno: errorDetails.errno } : {}),
    ...(errorDetails.code ? { code: errorDetails.code } : {}),
    ...(errorDetails.syscall ? { syscall: errorDetails.syscall } : {}),
    ...(errorDetails.hostname ? { hostname: errorDetails.hostname } : {}),
    ...(errorDetails.address ? { address: errorDetails.address } : {}),
    ...(errorDetails.port !== undefined ? { port: errorDetails.port } : {}),
    ...(errorDetails.providerID ? { providerID: errorDetails.providerID } : {}),
    ...(errorDetails.statusCode !== undefined ? { statusCode: errorDetails.statusCode } : {}),
    ...(errorDetails.isRetryable !== undefined ? { isRetryable: errorDetails.isRetryable } : {}),
  };
}

export function toClientErrorDetails(errorDetails: ErrorDetails | null | undefined): ClientErrorDetails | null {
  if (!errorDetails) return null;
  return {
    ...toClientErrorCause(errorDetails),
    ...(isRecord(errorDetails.cause) && typeof errorDetails.cause.message === "string"
      ? { cause: toClientErrorCause(errorDetails.cause as ErrorDetails) }
      : {}),
  };
}

export function toClientErrorDetailsFromUnknown(errorDetails: unknown): ClientErrorDetails | null {
  if (!isRecord(errorDetails) || typeof errorDetails.message !== "string") return null;
  return toClientErrorDetails(errorDetails as ErrorDetails);
}
