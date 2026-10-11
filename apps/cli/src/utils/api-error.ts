export type ParsedApiErrorBody = {
  message?: string;
  serverCode?: string;
  rawError?: string;
};

export function parseApiErrorBody(body: string): ParsedApiErrorBody | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as { error?: unknown; message?: unknown; code?: unknown };
    const topLevelMessage = typeof record.message === "string" && record.message ? record.message : undefined;

    if (typeof record.error === "string" && record.error) {
      return {
        serverCode: typeof record.code === "string" && record.code ? record.code : record.error,
        rawError: record.error,
        message: topLevelMessage ?? record.error,
      };
    }
    if (record.error && typeof record.error === "object") {
      const error = record.error as { code?: unknown; message?: unknown };
      const message = typeof error.message === "string" && error.message ? error.message : topLevelMessage;
      const serverCode = typeof error.code === "string" && error.code ? error.code : undefined;
      return message || serverCode
        ? {
            ...(message ? { message } : {}),
            ...(serverCode ? { serverCode } : {}),
            ...(serverCode ? { rawError: serverCode } : {}),
          }
        : null;
    }
    return topLevelMessage ? { message: topLevelMessage } : null;
  } catch {
    return null;
  }
}
