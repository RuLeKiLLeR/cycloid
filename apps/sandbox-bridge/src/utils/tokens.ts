const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return estimateTokensForCharLength(text.length);
}

export function estimateTokensForCharLength(charLength: number): number {
  return Math.ceil(charLength / CHARS_PER_TOKEN);
}

export function estimateJsonTokens(obj: unknown): number {
  return estimateTokens(JSON.stringify(obj));
}
