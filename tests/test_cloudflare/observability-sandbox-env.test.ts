import { describe, expect, it } from "vitest";

import {
  buildSandboxObservabilityReadiness,
  resolveSandboxObservabilityEnv,
} from "../../apps/control-plane-worker/src/observability/sandbox-env";
import type { Env } from "../../apps/control-plane-worker/src/types";

function env(overrides: Partial<Env>): Env {
  return overrides as Env;
}

describe("sandbox observability env", () => {
  it("injects only the non-secret Braintrust project and never the platform telemetry secrets", () => {
    expect(
      resolveSandboxObservabilityEnv(
        env({
          DD_API_KEY: "dd-api-key",
          DD_SITE: "datadoghq.com",
          BRAINTRUST_API_KEY: "braintrust-key",
          BRAINTRUST_API_URL: "https://braintrust-api.example.com",
          BRAINTRUST_APP_URL: "https://braintrust-app.example.com",
          BRAINTRUST_ORG_NAME: "cycloid-org",
          SENTRY_DSN: "https://sentry.example.com/1",
        }),
      ),
    ).toEqual({
      BRAINTRUST_PROJECT: "cycloid",
    });
  });

  it("does not inject the retired OTEL collector env keys", () => {
    const sandboxEnv = resolveSandboxObservabilityEnv(
      env({
        OTEL_COLLECTOR_URL: "https://collector.example.com",
        COLLECTOR_AUTH_KEY: "collector-key",
      } as unknown as Env),
    );

    expect(sandboxEnv).toEqual({ BRAINTRUST_PROJECT: "cycloid" });
  });

  it("reports Datadog logs readiness from the worker-held DD_API_KEY the broker forwards with", () => {
    expect(buildSandboxObservabilityReadiness(env({}))).toEqual({
      traceExport: false,
      traceExportConfigured: false,
      ddLogs: false,
      tracingState: "disabled",
    });
    expect(buildSandboxObservabilityReadiness(env({ DD_API_KEY: "dd-api-key" }))).toEqual({
      traceExport: false,
      traceExportConfigured: false,
      ddLogs: true,
      tracingState: "disabled",
    });
  });
});
