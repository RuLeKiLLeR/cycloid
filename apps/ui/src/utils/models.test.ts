import { describe, expect, it } from "vitest";

import type { BootstrapModelOption } from "../../../../shared/types/bootstrap";
import type { Provider } from "../types";
import { buildModelOptions } from "./models";

function model(id: string, name: string, backends?: string[]): BootstrapModelOption {
  return { id, name, label: name, backends } as unknown as BootstrapModelOption;
}

describe("buildModelOptions", () => {
  it("sorts models within a group by natural/numeric order, not registry order", () => {
    const providers: Provider[] = [
      {
        id: "openai",
        name: "OpenAI",
        hasApiKey: true,
        models: [
          // Deliberately out of order, mimicking raw MODEL_REGISTRY declaration order.
          model("m1", "GPT-5.4", ["codex"]),
          model("m2", "GPT-5.6", ["codex"]),
          model("m3", "GPT-5.6 Sol", ["codex"]),
          model("m4", "GPT-5.6 Terra", ["codex"]),
          model("m5", "GPT-5.6 Luna", ["codex"]),
          model("m6", "GPT-5.5", ["codex"]),
          model("m7", "GPT-5.10", ["codex"]),
        ],
      } as unknown as Provider,
    ];

    expect(buildModelOptions(providers).map((o) => o.label)).toEqual([
      "GPT-5.4",
      "GPT-5.5",
      "GPT-5.6",
      "GPT-5.6 Luna",
      "GPT-5.6 Sol",
      "GPT-5.6 Terra",
      "GPT-5.10",
    ]);
  });

  it("preserves first-seen group order while sorting within each group", () => {
    const providers: Provider[] = [
      {
        id: "openai",
        name: "OpenAI",
        hasApiKey: true,
        models: [model("c2", "GPT-5.6", ["codex"]), model("c1", "GPT-5.4", ["codex"])],
      } as unknown as Provider,
      {
        id: "anthropic",
        name: "Anthropic",
        hasApiKey: true,
        models: [model("a2", "Opus 4.8", ["claude_code"]), model("a1", "Haiku 4.5", ["claude_code"])],
      } as unknown as Provider,
    ];

    const options = buildModelOptions(providers);
    // Codex group stays first (first-seen), Claude Code second; each sorted internally.
    expect(options.map((o) => `${o.groupLabel}:${o.label}`)).toEqual([
      "Codex:GPT-5.4",
      "Codex:GPT-5.6",
      "Claude Code:Haiku 4.5",
      "Claude Code:Opus 4.8",
    ]);
  });
});
