export const ANSI_ESCAPE_RE = /\x1B(?:\][^\u0007]*(?:\u0007|\x1B\\)|[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsiEscapeCodes(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}
