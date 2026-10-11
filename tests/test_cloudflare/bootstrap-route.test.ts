import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_o: unknown, c: unknown) => c,
  withSentry: (_o: unknown, h: unknown) => h,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

// Mock only the service so the route's .catch() branch is exercised in isolation
// (no full bootstrap query graph). settings/db and db/errors are NOT mocked, so
// the real UserRowMissingError class is shared with the route's instanceof check.
vi.mock("../../apps/control-plane-worker/src/services/bootstrap", () => ({
  assembleBootstrap: vi.fn(),
}));

import { UserRowMissingError } from "../../apps/control-plane-worker/src/db/errors";
import { bootstrapRoutes } from "../../apps/control-plane-worker/src/routes/bootstrap";
import { assembleBootstrap } from "../../apps/control-plane-worker/src/services/bootstrap";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";

const handler = bootstrapRoutes.find((r) => r.method === "GET" && r.pattern.test("/api/bootstrap"))!.handler;
const env = { DB: {} } as unknown as Env;
const auth = { userId: "42", user: { id: 42, login: "ghost" } } as unknown as AuthInfo;

function request(): Request {
  return new Request("https://example.com/api/bootstrap", { headers: { "x-request-id": "req-bootstrap" } });
}

describe("GET /api/bootstrap route handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps UserRowMissingError to 401 (stale cached session for a deleted user)", async () => {
    vi.mocked(assembleBootstrap).mockRejectedValue(new UserRowMissingError(42));

    const res = await handler(request(), env, {} as never, auth);

    expect(res.status).toBe(401);
  });

  it("maps a generic assembly failure to 500", async () => {
    vi.mocked(assembleBootstrap).mockRejectedValue(new Error("D1 unavailable"));

    const res = await handler(request(), env, {} as never, auth);

    expect(res.status).toBe(500);
  });

  it("returns the payload on success", async () => {
    vi.mocked(assembleBootstrap).mockResolvedValue({ authenticated: true, settings: {} } as never);

    const res = await handler(request(), env, {} as never, auth);

    expect(res.status).toBe(200);
  });
});
