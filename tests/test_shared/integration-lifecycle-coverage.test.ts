import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LIFECYCLE_DEBUG_INTEGRATION_IDS } from "../../shared/constants/integration-helpers";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

const WRITER_PATHS: Record<string, readonly string[]> = {
  github: ["apps/control-plane-worker/src/integrations/github-health.ts"],
  slack: [
    "apps/control-plane-worker/src/webhooks/handlers.ts",
    "apps/control-plane-worker/src/auth/routes.ts",
    "apps/sandbox-bridge/src/services/first-party-dynamic-tools.ts",
  ],
  linear: [
    "apps/control-plane-worker/src/webhooks/handlers.ts",
    "apps/control-plane-worker/src/auth/routes.ts",
    "apps/sandbox-bridge/src/services/first-party-dynamic-tools.ts",
  ],
  jira: ["apps/control-plane-worker/src/auth/routes.ts"],
  notion: ["apps/control-plane-worker/src/integrations/runtime.ts"],
  sentry: ["apps/control-plane-worker/src/integrations/runtime.ts"],
  datadog: ["apps/control-plane-worker/src/integrations/runtime.ts"],
  launchdarkly: ["apps/control-plane-worker/src/integrations/runtime.ts"],
  cloudflare: ["apps/control-plane-worker/src/integrations/runtime.ts"],
  braintrust: ["apps/control-plane-worker/src/integrations/runtime.ts"],
  stripe: ["apps/control-plane-worker/src/integrations/runtime.ts"],
  terraform: ["apps/control-plane-worker/src/integrations/runtime.ts"],
  vercel: ["apps/control-plane-worker/src/integrations/runtime.ts"],
  openai: ["apps/control-plane-worker/src/integrations/runtime.ts"],
  anthropic: ["apps/control-plane-worker/src/integrations/runtime.ts"],
  baseten: ["apps/control-plane-worker/src/integrations/runtime.ts"],
  codex_subscription: ["apps/control-plane-worker/src/integrations/runtime.ts"],
};

describe("integration lifecycle writer coverage", () => {
  it("keeps a production writer path for every instrumented integration", () => {
    for (const integrationId of LIFECYCLE_DEBUG_INTEGRATION_IDS) {
      const paths = WRITER_PATHS[integrationId];
      expect(paths, `${integrationId} is missing an explicit writer-path mapping`).toBeDefined();

      const hasWriterReference = paths.some((relativePath) => {
        const absolutePath = resolve(TEST_DIR, "..", "..", relativePath);
        const source = readFileSync(absolutePath, "utf8");
        return (
          source.includes(`integrationId: "${integrationId}"`) ||
          source.includes(`createLifecycleSuccessEvents("${integrationId}"`) ||
          source.includes(`createLifecycleFailureEvent("${integrationId}"`) ||
          // Model providers (openai, anthropic) are instrumented via the shared
          // dynamic lifecycle path keyed by the resolved provider id; their anchor
          // is the PROVIDER_DISPLAY_NAMES entry in runtime.ts.
          source.includes(`  ${integrationId}: "`)
        );
      });

      expect(hasWriterReference, `${integrationId} no longer has a concrete lifecycle writer path`).toBe(true);
    }
  });
});
