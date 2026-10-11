import { getSchemaVersion } from "../services/schema-version";
import { runWarmProbe } from "../services/warm";
import { jsonErrorResponse, jsonResponse } from "../utils";
import type { Route } from "./shared";
import { parsePattern } from "./shared";

const healthResponse = () => jsonResponse({ ok: true, service: "cycloid-control-plane-worker" });

export const publicRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/health"),
    auth: "public",
    handler: async () => healthResponse(),
  },
  {
    method: "GET",
    pattern: parsePattern("/api/health"),
    auth: "public",
    handler: async () => healthResponse(),
  },
  {
    method: "GET",
    pattern: parsePattern("/api/version"),
    auth: "public",
    handler: async () => jsonResponse({ version: "0.1.0" }),
  },
  {
    method: "GET",
    pattern: parsePattern("/api/health/schema"),
    auth: "automation",
    handler: async (_req, env) => {
      try {
        const schema = await getSchemaVersion(env);
        const response = jsonResponse({ ok: true, ...schema });
        response.headers.set("cache-control", "no-store");
        return response;
      } catch (err) {
        // Fail closed: an unreadable d1_migrations table is not a healthy schema.
        return jsonErrorResponse(`Schema version unavailable: ${String(err)}`, 500);
      }
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/health/warm"),
    auth: "automation",
    handler: async (_req, env) => {
      await runWarmProbe(env);
      const response = jsonResponse({ ok: true });
      response.headers.set("cache-control", "no-store");
      response.headers.set("x-cycloid-warm-probe", "1");
      return response;
    },
  },
];
