// OpenAI-gateway + sandbox-bridge cost estimate shape.
// This is not the authoritative billing shape for Anthropic sidecar billing or
// Baseten API billing, which carry provider-specific fields and provenance.
export type ModelFlexPricing = {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
};

export type ModelPricing = {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  flex?: ModelFlexPricing;
  longContext?: {
    thresholdTokens: number;
    inputPerMillion: number;
    outputPerMillion: number;
    cacheReadPerMillion?: number;
    cacheWritePerMillion?: number;
    flex?: ModelFlexPricing;
  };
};
