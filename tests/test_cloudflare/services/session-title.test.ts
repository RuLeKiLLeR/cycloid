import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../../../apps/control-plane-worker/src/logger";
import {
  formatGeneratedSessionTitle,
  generateSessionTitle,
  SESSION_TITLE_MODEL,
} from "../../../apps/control-plane-worker/src/services/session-title";
import { GPT54_MINI_SIDECAR_REASONING_EFFORT } from "../../../shared/constants/models";

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

const PLATFORM_KEYS = {
  ARCANIST_OPENAI_API_KEY: "sk-oai-test",
};

describe("session title generation", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("formats concise titles in sentence case", () => {
    expect(
      formatGeneratedSessionTitle({
        title: "Update Session Title Generation",
        ticketKey: null,
      }),
    ).toEqual({
      title: "Update session title generation",
      ticketKey: null,
    });
  });

  it("normalizes generated titles to sentence case without flattening common product terms", () => {
    expect(
      formatGeneratedSessionTitle({
        title: "FIX GITHUB PR CALLBACK ROUTING FOR CLOUDFLARE",
        ticketKey: null,
      }),
    ).toEqual({
      title: "Fix GitHub PR callback routing for Cloudflare",
      ticketKey: null,
    });

    expect(
      formatGeneratedSessionTitle({
        title: "Guardrail Runtime Evidence Classifier Fail-Open Flip",
        ticketKey: null,
      }),
    ).toMatchObject({
      title: "Guardrail runtime evidence classifier fail-open flip",
    });
  });

  it("passes through a shape-valid ticket key and drops a malformed one", () => {
    expect(formatGeneratedSessionTitle({ title: "Fix dashboard docs", ticketKey: "ENG-9001" })).toEqual({
      title: "Fix dashboard docs",
      ticketKey: "ENG-9001",
    });
    expect(formatGeneratedSessionTitle({ title: "Fix dashboard docs", ticketKey: "not a ticket" })).toEqual({
      title: "Fix dashboard docs",
      ticketKey: null,
    });
  });

  it("uses the fixed OpenAI Nano title model at low effort", async () => {
    const log = createMockLogger();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ title: "Fix OAuth Callback Redirect" }),
                },
              ],
            },
          ],
        }),
      ),
    );

    const result = await generateSessionTitle(
      "Fix the login redirect flow and add a regression test for the OAuth callback",
      "gpt-5.4-mini",
      PLATFORM_KEYS,
      log,
    );

    expect(result).toEqual({
      title: "Fix OAuth callback redirect",
      ticketKey: null,
      provider: "openai",
      model: SESSION_TITLE_MODEL,
    });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(fetchCall[1].body);
    expect(body.model).toBe(SESSION_TITLE_MODEL);
    expect(body.reasoning).toEqual({ effort: GPT54_MINI_SIDECAR_REASONING_EFFORT });
    expect(body.instructions).toContain("sentence case");
    expect(body.instructions).toContain("title the concrete outcome or likely work item");
    expect(body.instructions).toContain(
      'Avoid titles beginning with "Investigate", "Triage", or "Look into" when a more specific subject is present',
    );
    expect(body.text.format.name).toBe("generate_session_title");
  });

  it("does not switch title providers based on the original session model", async () => {
    const log = createMockLogger();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ title: "Add migration safety tests" }),
                },
              ],
            },
          ],
        }),
      ),
    );

    const result = await generateSessionTitle(
      "Add migration safety tests for the database rollout",
      "gpt-5.4",
      PLATFORM_KEYS,
      log,
    );

    expect(result).toEqual({
      title: "Add migration safety tests",
      ticketKey: null,
      provider: "openai",
      model: SESSION_TITLE_MODEL,
    });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(fetchCall[1].body);
    expect(body.model).toBe(SESSION_TITLE_MODEL);
    expect(body.reasoning).toEqual({ effort: GPT54_MINI_SIDECAR_REASONING_EFFORT });
    expect(body.text.format.name).toBe("generate_session_title");
  });

  it("bounds the prompt body sent to the title model", async () => {
    const log = createMockLogger();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ title: "Summarize long request" }),
                },
              ],
            },
          ],
        }),
      ),
    );

    const longPrompt = `${"word ".repeat(1_000)}tail-token`;
    await expect(generateSessionTitle(longPrompt, "gpt-5.4-mini", PLATFORM_KEYS, log)).resolves.toMatchObject({
      title: "Summarize long request",
    });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.input).not.toContain("tail-token");
    expect(body.input.length).toBeLessThanOrEqual("Request:\n".length + 4_000);
  });

  it("returns null when the provider call fails", async () => {
    const log = createMockLogger();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network unavailable"));

    await expect(generateSessionTitle("Fix the queue", "gpt-5.4-mini", PLATFORM_KEYS, log)).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("StructuredOutputError") }),
      "Session title generation failed",
    );
  });

  it("logs invalid structured output as failed LLM completion telemetry", async () => {
    const log = createMockLogger();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ notTitle: "infra" }),
                },
              ],
            },
          ],
        }),
      ),
    );

    await expect(generateSessionTitle("Fix the queue", "gpt-5.4-mini", PLATFORM_KEYS, log)).resolves.toBeNull();
    expect(log.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "llm_call.completed", outcome: "success" }),
      expect.any(String),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "llm_call.completed",
        callType: "session_title",
        outcome: "failure",
        failureCategory: "output_shape",
        failureKind: "output_shape",
      }),
      "Session title generation returned invalid structured output",
    );
  });
});
