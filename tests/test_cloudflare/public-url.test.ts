import { describe, expect, it } from "vitest";

import {
  resolveConfiguredPublicAppBaseUrl,
  resolveConfiguredPublicSessionUrl,
  resolvePublicAppBaseUrl,
  resolvePublicArtifactBaseUrl,
  resolvePublicSessionUrl,
} from "../../apps/control-plane-worker/src/services/public-url";

describe("resolvePublicAppBaseUrl", () => {
  it("falls back to the production app for local and tunnel frontend URLs without a public control plane URL", () => {
    expect(resolvePublicAppBaseUrl({ FRONTEND_URL: "http://localhost:5173" })).toBe("https://app.trycycloid.com");
    expect(resolvePublicAppBaseUrl({ FRONTEND_URL: "https://temporary.ngrok-free.dev" })).toBe(
      "https://app.trycycloid.com",
    );
    expect(resolvePublicAppBaseUrl({ FRONTEND_URL: "https://worker.trycloudflare.com" })).toBe(
      "https://app.trycycloid.com",
    );
  });

  it("does not use a public control plane tunnel for app URLs", () => {
    expect(
      resolvePublicAppBaseUrl({
        FRONTEND_URL: "http://localhost:5173",
        CONTROL_PLANE_URL: "https://temporary.ngrok-free.dev",
      }),
    ).toBe("https://app.trycycloid.com");
  });

  it("uses localhost frontend URLs for local app links", () => {
    expect(resolvePublicAppBaseUrl({ WORKER_ENV: "local", FRONTEND_URL: "http://localhost:5173" })).toBe(
      "http://localhost:5173",
    );
  });

  it("keeps stable HTTPS app URLs and trims a trailing slash", () => {
    expect(resolvePublicAppBaseUrl({ FRONTEND_URL: "https://staging.trycycloid.com/" })).toBe(
      "https://staging.trycycloid.com",
    );
  });
});

describe("resolvePublicArtifactBaseUrl", () => {
  it("uses explicit stable artifact URLs before app URLs", () => {
    expect(
      resolvePublicArtifactBaseUrl({
        PUBLIC_ARTIFACT_BASE_URL: "https://artifacts.trycycloid.com/",
        FRONTEND_URL: "https://staging.trycycloid.com",
      }),
    ).toBe("https://artifacts.trycycloid.com");
  });

  it("does not use ephemeral control-plane tunnels for reviewer-facing artifact URLs", () => {
    expect(
      resolvePublicArtifactBaseUrl({
        FRONTEND_URL: "http://localhost:5173",
        CONTROL_PLANE_URL: "https://temporary.ngrok-free.dev",
      }),
    ).toBe("https://app.trycycloid.com");
  });

  it("does not allow local artifact URLs to use a public control-plane tunnel", () => {
    expect(
      resolvePublicArtifactBaseUrl({
        PUBLIC_ARTIFACT_BASE_URL: "https://temporary.ngrok-free.dev",
        FRONTEND_URL: "http://localhost:5173",
        CONTROL_PLANE_URL: "https://app.trycycloid.com",
      }),
    ).toBe("https://app.trycycloid.com");
  });

  it("uses the local control-plane tunnel for local artifact URLs", () => {
    expect(
      resolvePublicArtifactBaseUrl({
        WORKER_ENV: "local",
        FRONTEND_URL: "http://localhost:5173",
        CONTROL_PLANE_URL: "https://temporary.ngrok-free.dev",
      }),
    ).toBe("https://temporary.ngrok-free.dev");
  });

  it("allows an explicit local artifact tunnel in local mode", () => {
    expect(
      resolvePublicArtifactBaseUrl({
        WORKER_ENV: "local",
        PUBLIC_ARTIFACT_BASE_URL: "https://artifacts.ngrok-free.dev",
        FRONTEND_URL: "http://localhost:5173",
        CONTROL_PLANE_URL: "https://temporary.ngrok-free.dev",
      }),
    ).toBe("https://artifacts.ngrok-free.dev");
  });
});

describe("resolveConfiguredPublicAppBaseUrl", () => {
  it("returns null for local and tunnel frontend URLs", () => {
    expect(resolveConfiguredPublicAppBaseUrl({ FRONTEND_URL: "http://localhost:5173" })).toBeNull();
    expect(resolveConfiguredPublicAppBaseUrl({ FRONTEND_URL: "https://temporary.ngrok-free.dev" })).toBeNull();
  });

  it("returns stable frontend URLs unchanged", () => {
    expect(resolveConfiguredPublicAppBaseUrl({ FRONTEND_URL: "https://qa.app.trycycloid.com/" })).toBe(
      "https://qa.app.trycycloid.com",
    );
  });
});

describe("resolvePublicSessionUrl", () => {
  it("builds a stable public session URL", () => {
    expect(resolvePublicSessionUrl({ FRONTEND_URL: "https://qa.app.trycycloid.com/" }, "sess_123")).toBe(
      "https://qa.app.trycycloid.com/sessions/sess_123",
    );
  });

  it("does not use a local frontend URL for public session links", () => {
    expect(resolvePublicSessionUrl({ FRONTEND_URL: "http://localhost:5173" }, "sess_123")).toBe(
      "https://app.trycycloid.com/sessions/sess_123",
    );
  });

  it("uses a local frontend URL for local session links", () => {
    expect(resolvePublicSessionUrl({ WORKER_ENV: "local", FRONTEND_URL: "http://localhost:5173" }, "sess_123")).toBe(
      "http://localhost:5173/sessions/sess_123",
    );
  });
});

describe("resolveConfiguredPublicSessionUrl", () => {
  it("returns null when there is no stable configured app URL", () => {
    expect(resolveConfiguredPublicSessionUrl({ FRONTEND_URL: "http://localhost:5173" }, "sess_123")).toBeNull();
  });

  it("returns a configured stable session URL when available", () => {
    expect(resolveConfiguredPublicSessionUrl({ FRONTEND_URL: "https://app.trycycloid.com" }, "sess_123")).toBe(
      "https://app.trycycloid.com/sessions/sess_123",
    );
  });
});
