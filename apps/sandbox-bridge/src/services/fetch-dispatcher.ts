import { Agent, setGlobalDispatcher } from "undici";

// Previously, a stuck LLM/MCP request kept a connection open for 5 minutes
// (undici default) before surfacing; Codex retries once, so a single failed
// prompt took ~10 minutes to fail. 30s headers timeout cuts this to ~1 minute
// and gives useful UND_ERR_HEADERS_TIMEOUT signal far sooner.
const HEADERS_TIMEOUT_MS = 30_000;

// Streaming LLM responses can have long silences during reasoning. Keep body
// timeout generous so legitimate long completions don't get cut off.
const BODY_TIMEOUT_MS = 600_000;

interface FetchDispatcherConfig {
  headersTimeoutMs: number;
  bodyTimeoutMs: number;
}

export function configureFetchDispatcher(): FetchDispatcherConfig {
  const config: FetchDispatcherConfig = {
    headersTimeoutMs: HEADERS_TIMEOUT_MS,
    bodyTimeoutMs: BODY_TIMEOUT_MS,
  };
  setGlobalDispatcher(
    new Agent({
      headersTimeout: config.headersTimeoutMs,
      bodyTimeout: config.bodyTimeoutMs,
    }),
  );
  return config;
}
