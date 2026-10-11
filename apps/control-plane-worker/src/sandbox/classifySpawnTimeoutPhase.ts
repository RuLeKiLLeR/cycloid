import type { ErrorCode } from "../../../../shared/types/sandbox.js";

export type SpawnTimeoutOrigin = "provider_error" | "deadline";

type ClassifySpawnTimeoutPhaseInput = {
  origin: SpawnTimeoutOrigin;
  providerObjectId: string | null | undefined;
};

export function classifySpawnTimeoutPhase(input: ClassifySpawnTimeoutPhaseInput): ErrorCode {
  if (input.origin === "provider_error") {
    return "spawn_provider_error";
  }
  return input.providerObjectId ? "spawn_deadline_no_bridge" : "spawn_deadline_no_object";
}
