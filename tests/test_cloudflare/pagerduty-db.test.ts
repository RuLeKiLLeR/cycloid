import { describe, expect, it } from "vitest";

import {
  getPagerDutyWebhookInstallationByBusiness,
  getPagerDutyWebhookInstallationByToken,
  revokePagerDutyWebhookInstallationByBusiness,
  upsertPagerDutyWebhookInstallation,
} from "../../apps/control-plane-worker/src/webhooks/db";
import { createControlPlaneD1, seedBusiness, seedUser } from "./helpers/seed-db";

function makeDb(): D1Database {
  const { sqlite, d1 } = createControlPlaneD1();
  seedBusiness(sqlite, { id: "biz-1" });
  seedUser(sqlite, { id: 42, businessId: "biz-1" });
  return d1;
}

const INSTALL = {
  businessId: "biz-1",
  installationToken: "tok-pd-1",
  connectedByUserId: 42,
  repoOwner: "acme",
  repoName: "api",
  modelId: "gpt-5-mini",
  webhookSigningSecretEncrypted: "pd-test-secret",
};

describe("pagerduty_webhook_installations DAOs", () => {
  it("upserts and resolves the active installation by token and business", async () => {
    const db = makeDb();
    await upsertPagerDutyWebhookInstallation(db, INSTALL);

    const tokenRow = await getPagerDutyWebhookInstallationByToken(db, INSTALL.installationToken);
    const businessRow = await getPagerDutyWebhookInstallationByBusiness(db, INSTALL.businessId);
    expect(tokenRow).toMatchObject({
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "api",
      modelId: "gpt-5-mini",
      webhookSigningSecretEncrypted: "pd-test-secret",
      status: "active",
    });
    expect(businessRow?.installationToken).toBe("tok-pd-1");
  });

  it("rotates the installation token and updates repo config on re-upsert", async () => {
    const db = makeDb();
    await upsertPagerDutyWebhookInstallation(db, INSTALL);
    await upsertPagerDutyWebhookInstallation(db, {
      ...INSTALL,
      installationToken: "tok-pd-2",
      repoOwner: "acme",
      repoName: "worker",
      modelId: null,
    });

    expect(await getPagerDutyWebhookInstallationByToken(db, "tok-pd-1")).toBeNull();
    const row = await getPagerDutyWebhookInstallationByToken(db, "tok-pd-2");
    expect(row).toMatchObject({
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "worker",
      modelId: null,
      status: "active",
    });
  });

  it("does not resolve revoked installations by token", async () => {
    const db = makeDb();
    await upsertPagerDutyWebhookInstallation(db, INSTALL);

    expect(await revokePagerDutyWebhookInstallationByBusiness(db, "biz-1")).toBe(true);
    expect(await getPagerDutyWebhookInstallationByToken(db, INSTALL.installationToken)).toBeNull();
    expect((await getPagerDutyWebhookInstallationByBusiness(db, "biz-1"))?.status).toBe("revoked");
  });

  it("returns false when revokeByBusiness has nothing to revoke", async () => {
    const db = makeDb();
    expect(await revokePagerDutyWebhookInstallationByBusiness(db, "biz-1")).toBe(false);
  });
});
