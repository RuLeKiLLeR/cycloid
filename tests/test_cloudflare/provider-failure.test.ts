import { describe, expect, it } from "vitest";

import { classifyProviderHttpFailure } from "../../apps/control-plane-worker/src/integrations/provider-failure";

describe("classifyProviderHttpFailure", () => {
  describe("token/app-scoped endpoints (resourceScoped: false)", () => {
    const opts = { resourceScoped: false };

    it("treats 401 as durable auth", () => {
      expect(classifyProviderHttpFailure(401, opts)).toEqual({
        durability: "durable_auth",
        diagnostic: "provider_auth_rejected",
      });
    });

    it("treats 403 as durable auth", () => {
      expect(classifyProviderHttpFailure(403, opts).durability).toBe("durable_auth");
    });

    it("treats 429 as rate limited (never durable)", () => {
      expect(classifyProviderHttpFailure(429, opts)).toEqual({
        durability: "rate_limited",
        diagnostic: "provider_rate_limited",
      });
    });

    it("treats 5xx as transient (never durable)", () => {
      expect(classifyProviderHttpFailure(500, opts).durability).toBe("transient");
      expect(classifyProviderHttpFailure(503, opts).durability).toBe("transient");
    });

    it("treats other 4xx as client error", () => {
      expect(classifyProviderHttpFailure(400, opts).durability).toBe("client_error");
      expect(classifyProviderHttpFailure(404, opts).durability).toBe("client_error");
    });
  });

  describe("resource-scoped endpoints (resourceScoped: true)", () => {
    const opts = { resourceScoped: true };

    it("treats 401 as durable auth", () => {
      expect(classifyProviderHttpFailure(401, opts).durability).toBe("durable_auth");
    });

    it("treats 403 as resource scope, NOT durable auth", () => {
      expect(classifyProviderHttpFailure(403, opts)).toEqual({
        durability: "resource_scope",
        diagnostic: "provider_resource_forbidden",
      });
    });

    it("treats 429 / 5xx the same as token-scoped (rate limited / transient)", () => {
      expect(classifyProviderHttpFailure(429, opts).durability).toBe("rate_limited");
      expect(classifyProviderHttpFailure(502, opts).durability).toBe("transient");
    });
  });
});
