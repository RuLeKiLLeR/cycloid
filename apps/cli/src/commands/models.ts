import type { Command } from "commander";

import { DEFAULT_SESSION_START_MODEL_ID_BY_BACKEND } from "../../../../shared/constants/models.js";
import { apiFetch } from "../api.js";
import { emit, resolveBusinessContext, type RuntimeOptions } from "../runtime.js";

type BootstrapModelGroup = {
  id: string;
  name?: string;
  models: Array<Record<string, unknown> & { id: string; backends?: string[] }>;
};

export async function modelsListCommand(
  options: { json?: boolean } & RuntimeOptions = {},
  command?: Command,
): Promise<void> {
  const { config } = resolveBusinessContext(command, options);
  const groups = await apiFetch<BootstrapModelGroup[]>(config, "/api/models");
  const models = groups.flatMap((group) =>
    group.models.map((model) => {
      const backends = model.backends ?? [group.id];
      return {
        ...model,
        backend: group.id,
        provider: group.id,
        backends,
        default: backends.some(
          (backend) =>
            DEFAULT_SESSION_START_MODEL_ID_BY_BACKEND[
              backend as keyof typeof DEFAULT_SESSION_START_MODEL_ID_BY_BACKEND
            ] === model.id,
        ),
      };
    }),
  );
  emit(command, options, { models }, (payload) => {
    for (const model of payload.models) {
      console.log(`${String(model.id)}\t${String(model.backend)}${model.default ? "\tdefault" : ""}`);
    }
  });
}
