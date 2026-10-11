import { handleOpenAIResponses } from "../openai-gateway/service";
import { parsePattern, type Route } from "./shared";

export const openAIGatewayRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/openai/responses"),
    auth: "public",
    handler: (request, env, _match, _auth, ctx) => handleOpenAIResponses(request, env, ctx),
  },
  {
    method: "GET",
    pattern: parsePattern("/openai/responses"),
    auth: "public",
    handler: (request, env, _match, _auth, ctx) => handleOpenAIResponses(request, env, ctx),
  },
  {
    method: "POST",
    pattern: parsePattern("/openai/responses/compact"),
    auth: "public",
    handler: (request, env, _match, _auth, ctx) => handleOpenAIResponses(request, env, ctx, "compact"),
  },
];
