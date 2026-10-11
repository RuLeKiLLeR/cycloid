import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Verify that the files we instrumented actually import and use Sentry.captureException
// This is a structural test to ensure the instrumentation wasn't accidentally removed.

function readSource(relativePath: string): string {
  return readFileSync(relativePath, "utf-8");
}

describe("sentry gap instrumentation", () => {
  it("durable-object.ts imports Sentry", () => {
    const source = readSource("apps/control-plane-worker/src/session/durable-object.ts");
    expect(source).toContain('import * as Sentry from "@sentry/cloudflare"');
    expect(source).toContain("private async persistRichStatusToD1");
    expect(source).toContain("syncRichStatusProjection");
    expect(source).toContain("scheduleSessionProjectionSync");
    expect(source).toContain('operation: "getSessionPrompts"');
    expect(source).toContain("await this.setSentryUserContext(session.ownerUserId)");
    expect(source).toContain("Failed to hydrate Sentry user context");
  });

  it("fetch-router.ts preserves fetch-route Sentry instrumentation", () => {
    const source = readSource("apps/control-plane-worker/src/session/fetch-router.ts");
    expect(source).toContain('import * as Sentry from "@sentry/cloudflare"');
    expect(source).toContain('operation: "generateInstallationToken"');
    expect(source).toContain("await self.applySentryUserContext(request)");
    expect(source).toContain("shouldHydrateSentryUserContextOnEntry");
  });

  it("session-projection.ts tags scheduled projection failures with Sentry", () => {
    const source = readSource("apps/control-plane-worker/src/services/session-projection.ts");
    expect(source).toContain('import { runWithSentryTag } from "../observability/run-with-sentry-tag"');
    expect(source).toContain('runWithSentryTag("session-projection-sync"');
    expect(source).not.toContain(".catch(() => undefined)");
  });

  it("prompt-queue.ts captures PR publish handoff failures with Sentry", () => {
    const source = readSource("apps/control-plane-worker/src/session/prompt-queue.ts");
    const notificationSource = readSource("apps/control-plane-worker/src/session/pr-notifications.ts");
    expect(source).toContain('import * as Sentry from "@sentry/cloudflare"');
    // ARC-960: post_execution PR creation/update handoffs are tracked via
    // host.waitUntil and their failures captured through runWithSentryTag, which
    // merges the originating operation into the Sentry tags.
    expect(source).toContain("runWithSentryTag");
    expect(source).toContain('"triggerPrCreation"');
    expect(source).toContain('"triggerPrUpdate"');
    expect(notificationSource).toContain('operation: "notifySlackPrCreated"');
  });

  it("sessions.ts imports and uses Sentry", () => {
    const source = readSource("apps/control-plane-worker/src/routes/sessions.ts");
    expect(source).toContain('import * as Sentry from "@sentry/cloudflare"');
    expect(source).toContain('operation: "fetchRepoTree"');
  });

  it("archive.ts imports and uses Sentry", () => {
    const source = readSource("apps/control-plane-worker/src/services/archive.ts");
    expect(source).toContain('import * as Sentry from "@sentry/cloudflare"');
    expect(source).toContain('operation: "s3PutObject"');
    expect(source).toContain('operation: "s3GetArtifact"');
  });

  it("router.ts tags sessionId and sets user email/username on Sentry context", () => {
    const source = readSource("apps/control-plane-worker/src/router.ts");
    expect(source).toContain('Sentry.setTag("sessionId"');
    expect(source).toContain("email: auth.user?.email");
    expect(source).toContain("username: auth.user?.login");
  });
});
