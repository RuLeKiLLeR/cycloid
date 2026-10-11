import { beforeEach, describe, expect, it, vi } from "vitest";

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";
import {
  buildCustomerSessionStartAlertText,
  notifyCustomerSessionStarted,
  shouldNotifyCustomerSessionStarted,
} from "../../apps/control-plane-worker/src/session/customer-session-start-alert";
import { CUSTOMER_SESSION_TRACKING_CHANNEL_ID } from "../../apps/control-plane-worker/src/slack/internal-channels";

const mockPostInternalAlert = vi.fn();

vi.mock("../../apps/control-plane-worker/src/slack/internal-alerts", () => ({
  postInternalAlert: (...args: unknown[]) => mockPostInternalAlert(...args),
}));

const productionEnv = {
  WORKER_ENV: "production",
  FRONTEND_URL: "https://app.trycycloid.com",
  SLACK_BOT_TOKEN: "xoxb-test",
} as const;

describe("customer session start alert", () => {
  beforeEach(() => {
    mockPostInternalAlert.mockReset().mockResolvedValue({ ok: true, ts: "1.2", channel: "C0BDFUCL9JP" });
  });

  it("notifies for external production implementation and verification sessions", () => {
    expect(
      shouldNotifyCustomerSessionStarted(productionEnv, { businessId: "customer-business", agentRole: null }),
    ).toBe(true);
    // Internal Cycloid/Cycloid-QA dogfood traffic is excluded.
    expect(
      shouldNotifyCustomerSessionStarted(productionEnv, {
        businessId: SEEDED_BUSINESS_IDS.cycloid,
        agentRole: null,
      }),
    ).toBe(false);
    expect(
      shouldNotifyCustomerSessionStarted(productionEnv, {
        businessId: SEEDED_BUSINESS_IDS.cycloidQa,
        agentRole: null,
      }),
    ).toBe(false);
    expect(
      shouldNotifyCustomerSessionStarted({ WORKER_ENV: "qa" }, { businessId: "customer-business", agentRole: null }),
    ).toBe(false);
    expect(
      shouldNotifyCustomerSessionStarted(productionEnv, {
        businessId: "customer-business",
        agentRole: "verification",
      }),
    ).toBe(true);
    expect(
      shouldNotifyCustomerSessionStarted(productionEnv, {
        businessId: SEEDED_BUSINESS_IDS.cycloid,
        agentRole: "verification",
      }),
    ).toBe(false);
    expect(
      shouldNotifyCustomerSessionStarted(productionEnv, {
        businessId: SEEDED_BUSINESS_IDS.cycloidQa,
        agentRole: "verification",
      }),
    ).toBe(false);
    expect(
      shouldNotifyCustomerSessionStarted(
        { WORKER_ENV: "qa" },
        {
          businessId: "customer-business",
          agentRole: "verification",
        },
      ),
    ).toBe(false);
  });

  it("skips the prod smoke-test repo so the tracking channel is not spammed", () => {
    expect(
      shouldNotifyCustomerSessionStarted(productionEnv, {
        businessId: "customer-business",
        agentRole: "verification",
        repoOwner: "jeman-verification",
        repoName: "verification-prod",
      }),
    ).toBe(false);
    expect(
      shouldNotifyCustomerSessionStarted(productionEnv, {
        businessId: "customer-business",
        agentRole: null,
        repoOwner: "jeman-verification",
        repoName: "verification-prod",
      }),
    ).toBe(false);
    // Case-insensitive match.
    expect(
      shouldNotifyCustomerSessionStarted(productionEnv, {
        businessId: "customer-business",
        agentRole: null,
        repoOwner: "Jeman-Verification",
        repoName: "Verification-Prod",
      }),
    ).toBe(false);
  });

  it("renders the customer session message clearly", () => {
    const text = buildCustomerSessionStartAlertText(productionEnv, {
      sessionId: "sess-1",
      ownerUserId: "71931997",
      businessId: "biz-customer",
      repoOwner: "acme",
      repoName: "app",
      entrypoint: "slack",
    });

    expect(text).toContain("*Customer session started*");
    expect(text).toContain(
      "<https://app.trycycloid.com/admin/support-view?sessionId=sess-1&targetUserId=71931997|sess-1>",
    );
    // Body is a monospace code block with space-padded labels so columns align.
    expect(text).toContain("```");
    expect(text).toContain("Repo:       acme/app");
    expect(text).toContain("User:       71931997");
    expect(text).toContain("Entrypoint: slack");
    // Business duplicates the User line, so it is no longer rendered.
    expect(text).not.toContain("Business:");
    // Only external customers reach this channel; no audience tagging.
    expect(text).not.toContain("Audience:");
    expect(text).not.toContain("Internal");
  });

  it("renders a distinct verification session message", () => {
    const text = buildCustomerSessionStartAlertText(productionEnv, {
      sessionId: "sess-verify",
      ownerUserId: "71931997",
      businessId: "biz-customer",
      repoOwner: "acme",
      repoName: "app",
      entrypoint: "auto_qa",
      agentRole: "verification",
    });

    expect(text).toContain("🔍 *Verification session started*");
    expect(text).not.toContain("👤 *Customer session started*");
    expect(text).toContain(
      "<https://app.trycycloid.com/admin/support-view?sessionId=sess-verify&targetUserId=71931997|sess-verify>",
    );
    expect(text).toContain("Repo:       acme/app");
    expect(text).toContain("User:       71931997");
    expect(text).toContain("Entrypoint: auto_qa");
  });

  it("renders code review sessions independently from verification", () => {
    const text = buildCustomerSessionStartAlertText(productionEnv, {
      sessionId: "sess-review",
      ownerUserId: "71931997",
      businessId: "biz-customer",
      repoOwner: "acme",
      repoName: "app",
      entrypoint: "github",
      agentRole: "review",
    });

    expect(text).toContain("🔎 *Code review session started*");
    expect(text).not.toContain("Verification session started");
    expect(text).not.toContain("Customer session started");
  });

  it("URL-encodes the support-view launch parameters", () => {
    const text = buildCustomerSessionStartAlertText(productionEnv, {
      sessionId: "sess/with space",
      ownerUserId: "user+1@example.com",
      businessId: "biz-customer",
      repoOwner: "acme",
      repoName: "app",
      entrypoint: "api",
    });

    expect(text).toContain(
      "<https://app.trycycloid.com/admin/support-view?sessionId=sess%2Fwith+space&targetUserId=user%2B1%40example.com|sess/with space>",
    );
  });

  it("never renders an 'unknown' entrypoint, even when none is supplied", () => {
    const text = buildCustomerSessionStartAlertText(productionEnv, {
      sessionId: "sess-2",
      ownerUserId: "71931997",
      businessId: "biz-customer",
      repoOwner: "acme",
      repoName: "app",
    });

    expect(text).not.toContain("Entrypoint: unknown");
    expect(text).toContain("Entrypoint: api");
  });

  it("posts to the customer session tracking channel", async () => {
    await expect(
      notifyCustomerSessionStarted(productionEnv, {
        sessionId: "sess-1",
        ownerUserId: "71931997",
        businessId: "biz-customer",
        repoOwner: "acme",
        repoName: "app",
        entrypoint: "api",
      }),
    ).resolves.toBe(true);

    expect(mockPostInternalAlert).toHaveBeenCalledWith(
      productionEnv,
      CUSTOMER_SESSION_TRACKING_CHANNEL_ID,
      expect.stringContaining("User:       71931997"),
      undefined,
      expect.objectContaining({
        sessionId: "sess-1",
        ownerUserId: "71931997",
        businessId: "biz-customer",
        repoOwner: "acme",
        repoName: "app",
      }),
    );
  });

  it("does not post for internal Cycloid businesses", async () => {
    await expect(
      notifyCustomerSessionStarted(productionEnv, {
        sessionId: "sess-internal",
        ownerUserId: "shiv",
        businessId: SEEDED_BUSINESS_IDS.cycloid,
      }),
    ).resolves.toBe(false);

    expect(mockPostInternalAlert).not.toHaveBeenCalled();
  });
});
