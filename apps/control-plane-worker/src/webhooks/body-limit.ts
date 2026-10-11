import { jsonErrorResponse } from "../utils";

// Reject oversized webhook bodies before spending HMAC + JSON work on them.
// Slack/Jira/Linear payloads are small; GitHub documents a 25 MB payload ceiling.
export const DEFAULT_WEBHOOK_MAX_BYTES = 1024 * 1024; // 1 MiB
export const GITHUB_WEBHOOK_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Read a webhook request body with a size cap. Fast-rejects via Content-Length
 * when present, then enforces the cap on the actual bytes (the header may be
 * absent on chunked transfers or simply lie). Returns the body string, or a 413
 * Response the caller should return as-is -- mirrors verifySlackRequest's
 * `string | Response` contract.
 */
export async function readCappedWebhookBody(
  request: Request,
  maxBytes: number = DEFAULT_WEBHOOK_MAX_BYTES,
): Promise<string | Response> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      return jsonErrorResponse("Payload too large", 413);
    }
  }

  if (request.body === null) {
    return "";
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let rawBody = "";
  let bytesRead = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return rawBody + decoder.decode();
    }

    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return jsonErrorResponse("Payload too large", 413);
    }

    rawBody += decoder.decode(value, { stream: true });
  }
}
