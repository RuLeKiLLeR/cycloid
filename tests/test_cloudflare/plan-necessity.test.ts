import { describe, expect, it, vi } from "vitest";

import {
  assessPlanNecessity,
  PLAN_NECESSITY_MODEL,
  PLAN_NECESSITY_SYSTEM_PROMPT,
  PLAN_NECESSITY_TOOL_NAME,
} from "../../apps/control-plane-worker/src/services/plan-necessity";
import type { Env } from "../../apps/control-plane-worker/src/types";

function response(body: Record<string, unknown>, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-request-id": "req_test",
      ...(init?.headers ?? {}),
    },
  });
}

function structuredOutputResponse(output: Record<string, unknown>): Response {
  return response({
    output_text: JSON.stringify(output),
    usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
  });
}

const ENV = { ARCANIST_OPENAI_API_KEY: "sk-test" };

describe("assessPlanNecessity", () => {
  it("returns planNeeded=true with the expected OpenAI request for a multi-step prompt", async () => {
    const fetchImpl = vi.fn(async () =>
      structuredOutputResponse({ plan_needed: true, reason: "Multiple dependent phases." }),
    );
    const result = await assessPlanNecessity(
      ENV,
      "Migrate the sessions table to the new schema, backfill data, and update all DAOs.",
      {},
      { fetchImpl },
    );

    expect(result).toEqual({ planNeeded: true, reason: "Multiple dependent phases." });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(requestInit.body)) as {
      model: string;
      text: { format: { name: string } };
      reasoning: { effort: string };
      max_output_tokens: number;
      store: boolean;
    };
    expect(body.model).toBe(PLAN_NECESSITY_MODEL);
    expect(body.text.format.name).toBe(PLAN_NECESSITY_TOOL_NAME);
    expect(body.reasoning.effort).toBe("low");
    expect(body.max_output_tokens).toBe(200);
    expect(body.store).toBe(false);
  });

  it("returns planNeeded=false for a trivial prompt", async () => {
    const fetchImpl = vi.fn(async () => structuredOutputResponse({ plan_needed: false, reason: "Single-step fix." }));
    const result = await assessPlanNecessity(ENV, "Fix the typo in the README.", {}, { fetchImpl });
    expect(result).toEqual({ planNeeded: false, reason: "Single-step fix." });
  });

  it("keeps nontrivial compound analysis out of the trivial-compound exception", () => {
    expect(PLAN_NECESSITY_SYSTEM_PROMPT).toContain("localized, mechanical, or immediately answerable work");
    expect(PLAN_NECESSITY_SYSTEM_PROMPT).toContain("audit, review, investigate, compare, or find issues");
  });

  it.each([undefined, "", "   ", "CHANGE_ME"])("returns null for an unusable platform key", async (key) => {
    const fetchImpl = vi.fn();
    const env = { ARCANIST_OPENAI_API_KEY: key } as Pick<Env, "ARCANIST_OPENAI_API_KEY">;

    expect(await assessPlanNecessity(env, "Do a task", {}, { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null for an empty prompt without calling the provider", async () => {
    const fetchImpl = vi.fn();
    expect(await assessPlanNecessity(ENV, "   ", {}, { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("truncates long prompts to 12,000 characters", async () => {
    const fetchImpl = vi.fn(async () => structuredOutputResponse({ plan_needed: true, reason: "Several steps." }));
    const prompt = "a".repeat(12_001);

    await assessPlanNecessity(ENV, prompt, {}, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(requestInit.body)) as { input: string };
    expect(body.input).toBe(`Task prompt:\n${prompt.slice(0, 12_000)}`);
  });

  it("returns null when the provider output fails validation", async () => {
    const fetchImpl = vi.fn(async () => structuredOutputResponse({ plan_needed: "yes", reason: 42 }));
    expect(await assessPlanNecessity(ENV, "Refactor the auth flow", {}, { fetchImpl })).toBeNull();
  });

  it("returns null when the provider returns a whitespace-only reason", async () => {
    const fetchImpl = vi.fn(async () => structuredOutputResponse({ plan_needed: true, reason: " \t " }));
    expect(await assessPlanNecessity(ENV, "Refactor the auth flow", {}, { fetchImpl })).toBeNull();
  });

  it("returns null when the provider call errors", async () => {
    const fetchImpl = vi.fn(async () => response({ error: { message: "boom" } }, { status: 400 }));
    expect(await assessPlanNecessity(ENV, "Refactor the auth flow", {}, { fetchImpl })).toBeNull();
  });
});
