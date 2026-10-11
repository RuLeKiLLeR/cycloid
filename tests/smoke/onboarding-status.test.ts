import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

import type { OnboardingStep } from "../../shared/constants/onboarding.js";
import {
  createWorkerEnv,
  restoreSmokeTestFetchMock,
  seedAuthUser,
  sessionTokenHeaders,
  workerFetch,
  type WorkerModule,
} from "./helpers";

describe("smoke: onboarding status", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(() => {
    expect(workerModule).toBeDefined();
  });

  afterEach(() => {
    restoreSmokeTestFetchMock();
  });

  it("returns 401 without auth", async () => {
    const { env } = createWorkerEnv(workerModule);
    const res = await workerFetch(workerModule, env, "/api/onboarding/status");
    expect(res.status).toBe(401);
  });

  it("returns a generic denial when business membership is missing", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    db.addUser(1010, "partial-user");
    seedAuthUser(db, "partial-token", 1010, "partial-user");
    db.businessMembers.delete(1010);

    const res = await workerFetch(workerModule, env, "/api/onboarding/status?owner=acme&repo=repo-one", {
      headers: sessionTokenHeaders("partial-token"),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Access unavailable. Contact your administrator.");
  });

  it("returns onboarding steps for authenticated user", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    db.addUser(1001, "test-user");
    seedAuthUser(db, "onb-token", 1001, "test-user");

    const res = await workerFetch(workerModule, env, "/api/onboarding/status", {
      headers: sessionTokenHeaders("onb-token"),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; steps: OnboardingStep[] };
    expect(body.ok).toBe(true);
    expect(body.steps).toBeInstanceOf(Array);
    expect(body.steps.length).toBeGreaterThan(0);

    // Each step has the required shape
    for (const step of body.steps) {
      expect(step).toHaveProperty("id");
      expect(step).toHaveProperty("title");
      expect(step).toHaveProperty("owner");
      expect(step).toHaveProperty("required");
      expect(step).toHaveProperty("status");
      expect(step).toHaveProperty("reasonCode");
      expect(step).toHaveProperty("actionType");
    }
  });

  it("accepts an owner query param for GitHub App installation check", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    db.addUser(1002, "test-user-2");
    seedAuthUser(db, "onb-token-2", 1002, "test-user-2");
    db.setBusinessMembership(1002, "biz-1");
    db.userIntegrations.set("1002:github", {
      user_id: 1002,
      integration_id: "github",
      oauth_access_token: "gho_test",
      oauth_refresh_token: null,
      oauth_expires_at: null,
      api_key: null,
      external_user_id: null,
      service_url: null,
      encrypted: 0,
      connected_at: Date.now(),
      updated_at: Date.now(),
    });

    // "acme" is pre-seeded as a GitHub installation in createWorkerEnv
    const res = await workerFetch(workerModule, env, "/api/onboarding/status?owner=acme&repo=repo-one", {
      headers: sessionTokenHeaders("onb-token-2"),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; steps: OnboardingStep[] };
    const businessStep = body.steps.find((s) => s.id === "github_business_authorized")!;
    const appStep = body.steps.find((s) => s.id === "github_app_installed")!;
    const repoStep = body.steps.find((s) => s.id === "github_repo_access")!;
    expect(businessStep.status).toBe("connected");
    expect(businessStep.reasonCode).toBe("github_business_authorized");
    expect(appStep.status).toBe("connected");
    expect(appStep.reasonCode).toBe("github_app_installed");
    expect(repoStep.status).toBe("connected");
    expect(repoStep.reasonCode).toBe("github_repo_access_verified");
  });

  it("shows github_app not installed for unknown owner", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    db.addUser(1003, "test-user-3");
    seedAuthUser(db, "onb-token-3", 1003, "test-user-3");
    db.setBusinessMembership(1003, "biz-1");
    db.userIntegrations.set("1003:github", {
      user_id: 1003,
      integration_id: "github",
      oauth_access_token: "gho_test",
      oauth_refresh_token: null,
      oauth_expires_at: null,
      api_key: null,
      external_user_id: null,
      service_url: null,
      encrypted: 0,
      connected_at: Date.now(),
      updated_at: Date.now(),
    });

    const res = await workerFetch(workerModule, env, "/api/onboarding/status?owner=unknown-org&repo=repo-one", {
      headers: sessionTokenHeaders("onb-token-3"),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; steps: OnboardingStep[] };
    const appStep = body.steps.find((s) => s.id === "github_app_installed")!;
    expect(appStep.status).toBe("not_connected");
    expect(appStep.reasonCode).toBe("github_app_not_installed");
  });

  it("surfaces pending webhook sync after setup callback when the installation row is still missing", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    db.addUser(1004, "test-user-4");
    seedAuthUser(db, "onb-token-4", 1004, "test-user-4");
    db.setBusinessMembership(1004, "biz-1");
    db.userIntegrations.set("1004:github", {
      user_id: 1004,
      integration_id: "github",
      oauth_access_token: "gho_test",
      oauth_refresh_token: null,
      oauth_expires_at: null,
      api_key: null,
      external_user_id: null,
      service_url: null,
      encrypted: 0,
      connected_at: Date.now(),
      updated_at: Date.now(),
    });

    const res = await workerFetch(
      workerModule,
      env,
      "/api/onboarding/status?owner=pending-org&repo=repo-one&setup=complete",
      { headers: sessionTokenHeaders("onb-token-4") },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; steps: OnboardingStep[] };
    const appStep = body.steps.find((s) => s.id === "github_app_installed")!;
    expect(appStep.status).toBe("not_connected");
    expect(appStep.reasonCode).toBe("github_app_install_pending_webhook_sync");
  });

  it("surfaces repo access denied when GitHub returns 404 for the selected repo", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    db.addUser(1005, "test-user-5");
    seedAuthUser(db, "onb-token-5", 1005, "test-user-5");
    db.setBusinessMembership(1005, "biz-1");
    db.userIntegrations.set("1005:github", {
      user_id: 1005,
      integration_id: "github",
      oauth_access_token: "gho_test",
      oauth_refresh_token: null,
      oauth_expires_at: null,
      api_key: null,
      external_user_id: null,
      service_url: null,
      encrypted: 0,
      connected_at: Date.now(),
      updated_at: Date.now(),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.github.com/repos/")) {
        return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    };

    try {
      const res = await workerFetch(workerModule, env, "/api/onboarding/status?owner=acme&repo=missing-repo", {
        headers: sessionTokenHeaders("onb-token-5"),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { ok: boolean; steps: OnboardingStep[] };
      const repoStep = body.steps.find((s) => s.id === "github_repo_access")!;
      expect(repoStep.status).toBe("not_connected");
      expect(repoStep.reasonCode).toBe("github_repo_access_denied");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces repo access lookup_failed when GitHub verification errors", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    db.addUser(1006, "test-user-6");
    seedAuthUser(db, "onb-token-6", 1006, "test-user-6");
    db.setBusinessMembership(1006, "biz-1");
    db.userIntegrations.set("1006:github", {
      user_id: 1006,
      integration_id: "github",
      oauth_access_token: "gho_test",
      oauth_refresh_token: null,
      oauth_expires_at: null,
      api_key: null,
      external_user_id: null,
      service_url: null,
      encrypted: 0,
      connected_at: Date.now(),
      updated_at: Date.now(),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.github.com/repos/")) {
        return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    };

    try {
      const res = await workerFetch(workerModule, env, "/api/onboarding/status?owner=acme&repo=flaky-repo", {
        headers: sessionTokenHeaders("onb-token-6"),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { ok: boolean; steps: OnboardingStep[] };
      const repoStep = body.steps.find((s) => s.id === "github_repo_access")!;
      expect(repoStep.status).toBe("lookup_failed");
      expect(repoStep.reasonCode).toBe("github_repo_access_check_failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
