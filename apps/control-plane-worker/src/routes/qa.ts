import { handleQaIntegrationHealth, handleSeedQaEnvironment } from "../qa/seed";
import type { Route } from "./shared";
import { parsePattern } from "./shared";

export const qaRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/api/internal/qa/seed"),
    auth: "automation",
    handler: async (request, env) => handleSeedQaEnvironment(request, env),
  },
  {
    method: "GET",
    pattern: parsePattern("/api/internal/qa/integration-health"),
    auth: "automation",
    handler: async (request, env) => handleQaIntegrationHealth(request, env),
  },
];
