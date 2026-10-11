import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENT_RUNTIME_BACKEND_NAMES,
  AGENT_RUNTIME_BACKENDS,
  type AgentRuntimeBackend,
} from "../../shared/agent/agent-runtime-backend";
import {
  DEFAULT_SESSION_START_MODEL_ID_BY_BACKEND,
  PUBLIC_SESSION_START_MODEL_PROVIDER_GROUPS,
  SESSION_START_MODEL_IDS_BY_BACKEND,
} from "../../shared/constants/models";

const repoRoot = resolve(__dirname, "../..");
const apiDocs = readFileSync(resolve(repoRoot, "docs/api.md"), "utf8");

function publicSessionStartModelIds(): string[] {
  return PUBLIC_SESSION_START_MODEL_PROVIDER_GROUPS.flatMap((group) => group.models.map((model) => model.id)).sort();
}

describe("HTTP API model documentation", () => {
  it("documents every session-start backend and its default model", () => {
    for (const backend of AGENT_RUNTIME_BACKENDS) {
      const name = AGENT_RUNTIME_BACKEND_NAMES[backend as AgentRuntimeBackend];
      const defaultModel = DEFAULT_SESSION_START_MODEL_ID_BY_BACKEND[backend as AgentRuntimeBackend];
      expect(apiDocs).toContain(`\`${backend}\``);
      expect(apiDocs).toContain(name);
      expect(apiDocs).toContain(`\`${defaultModel}\``);
    }
  });

  it("documents every public session-start model id", () => {
    for (const modelId of publicSessionStartModelIds()) {
      expect(apiDocs).toContain(`\`${modelId}\``);
    }
  });

  it("documents every backend session-start model id", () => {
    for (const backend of AGENT_RUNTIME_BACKENDS) {
      for (const modelId of SESSION_START_MODEL_IDS_BY_BACKEND[backend as AgentRuntimeBackend]) {
        expect(apiDocs).toContain(`\`${modelId}\``);
      }
    }
  });
});
