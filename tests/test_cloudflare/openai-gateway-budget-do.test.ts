import { beforeEach, describe, expect, it, vi } from "vitest";

import { FakeDurableState, FakeStorage, mockCloudflareWorkers } from "./helpers/worker-harness";

mockCloudflareWorkers();

describe("OpenAIGatewayBudgetDO", () => {
  let OpenAIGatewayBudgetDO: typeof import("../../apps/control-plane-worker/src/openai-gateway/budget-do").OpenAIGatewayBudgetDO;

  beforeEach(async () => {
    vi.resetModules();
    ({ OpenAIGatewayBudgetDO } = await import("../../apps/control-plane-worker/src/openai-gateway/budget-do"));
  });

  function createDo() {
    const state = new FakeDurableState(new FakeStorage());
    return new OpenAIGatewayBudgetDO(state as unknown as DurableObjectState, {} as never);
  }

  async function post(
    instance: InstanceType<typeof OpenAIGatewayBudgetDO>,
    path: string,
    body: Record<string, unknown>,
  ) {
    return instance.fetch(
      new Request(`https://internal${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  }

  it("reserves estimated spend", async () => {
    const instance = createDo();
    const response = await post(instance, "/budget/reserve", {
      estimateUsdMicros: 10_000_000,
      monthlyLimitUsdMicros: 100_000_000,
      now: Date.UTC(2026, 4, 1),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      reservedUsdMicros: 10_000_000,
      state: { reservedUsdMicros: 10_000_000, spentUsdMicros: 0 },
    });
  });

  it("credits back when actual cost is lower than estimate", async () => {
    const instance = createDo();
    await post(instance, "/budget/reserve", {
      estimateUsdMicros: 10_000_000,
      monthlyLimitUsdMicros: 100_000_000,
    });
    const response = await post(instance, "/budget/settle", {
      reservedUsdMicros: 10_000_000,
      actualUsdMicros: 3_000_000,
    });

    await expect(response.json()).resolves.toMatchObject({
      state: { reservedUsdMicros: 0, spentUsdMicros: 3_000_000 },
    });
  });

  it("debits budget when actual cost is higher than estimate", async () => {
    const instance = createDo();
    await post(instance, "/budget/reserve", {
      estimateUsdMicros: 10_000_000,
      monthlyLimitUsdMicros: 100_000_000,
    });
    const response = await post(instance, "/budget/settle", {
      reservedUsdMicros: 10_000_000,
      actualUsdMicros: 15_000_000,
    });

    await expect(response.json()).resolves.toMatchObject({
      state: { reservedUsdMicros: 0, spentUsdMicros: 15_000_000 },
    });
  });

  it("does not double-settle the same ledger id", async () => {
    const instance = createDo();
    await post(instance, "/budget/reserve", {
      estimateUsdMicros: 10_000_000,
      monthlyLimitUsdMicros: 100_000_000,
    });

    await post(instance, "/budget/settle", {
      ledgerId: "ledger-1",
      reservedUsdMicros: 10_000_000,
      actualUsdMicros: 3_000_000,
    });
    const duplicate = await post(instance, "/budget/settle", {
      ledgerId: "ledger-1",
      reservedUsdMicros: 10_000_000,
      actualUsdMicros: 3_000_000,
    });

    await expect(duplicate.json()).resolves.toMatchObject({
      duplicate: true,
      state: { reservedUsdMicros: 0, spentUsdMicros: 3_000_000 },
    });
  });

  it("releases reservations without adding spend", async () => {
    const instance = createDo();
    await post(instance, "/budget/reserve", {
      estimateUsdMicros: 10_000_000,
      monthlyLimitUsdMicros: 100_000_000,
    });
    const response = await post(instance, "/budget/release", { reservedUsdMicros: 10_000_000 });

    await expect(response.json()).resolves.toMatchObject({
      state: { reservedUsdMicros: 0, spentUsdMicros: 0 },
    });
  });

  it("does not double-release the same ledger id", async () => {
    const instance = createDo();
    await post(instance, "/budget/reserve", {
      estimateUsdMicros: 10_000_000,
      monthlyLimitUsdMicros: 100_000_000,
    });
    // A second outstanding reservation shares the DO so a double-release would
    // silently eat its funds rather than clamping at zero.
    await post(instance, "/budget/reserve", {
      estimateUsdMicros: 5_000_000,
      monthlyLimitUsdMicros: 100_000_000,
    });

    await post(instance, "/budget/release", { ledgerId: "ledger-1", reservedUsdMicros: 10_000_000 });
    const duplicate = await post(instance, "/budget/release", { ledgerId: "ledger-1", reservedUsdMicros: 10_000_000 });

    await expect(duplicate.json()).resolves.toMatchObject({
      duplicate: true,
      state: { reservedUsdMicros: 5_000_000, spentUsdMicros: 0 },
    });
  });

  it("still releases when no ledger id is supplied", async () => {
    const instance = createDo();
    await post(instance, "/budget/reserve", {
      estimateUsdMicros: 10_000_000,
      monthlyLimitUsdMicros: 100_000_000,
    });
    const response = await post(instance, "/budget/release", { reservedUsdMicros: 10_000_000 });

    await expect(response.json()).resolves.toMatchObject({
      state: { reservedUsdMicros: 0, spentUsdMicros: 0 },
    });
  });

  it("releases independently for different ledger ids", async () => {
    const instance = createDo();
    await post(instance, "/budget/reserve", {
      estimateUsdMicros: 10_000_000,
      monthlyLimitUsdMicros: 100_000_000,
    });
    await post(instance, "/budget/reserve", {
      estimateUsdMicros: 5_000_000,
      monthlyLimitUsdMicros: 100_000_000,
    });

    await post(instance, "/budget/release", { ledgerId: "ledger-a", reservedUsdMicros: 10_000_000 });
    const second = await post(instance, "/budget/release", { ledgerId: "ledger-b", reservedUsdMicros: 5_000_000 });

    await expect(second.json()).resolves.toMatchObject({
      state: { reservedUsdMicros: 0, spentUsdMicros: 0 },
    });
  });

  it("does not cross-suppress a same-ledger release across reservation months", async () => {
    const instance = createDo();
    const mayReserve = await post(instance, "/budget/reserve", {
      estimateUsdMicros: 10_000_000,
      monthlyLimitUsdMicros: 100_000_000,
      now: Date.UTC(2026, 4, 15),
    });
    const juneReserve = await post(instance, "/budget/reserve", {
      estimateUsdMicros: 10_000_000,
      monthlyLimitUsdMicros: 100_000_000,
      now: Date.UTC(2026, 5, 15),
    });
    const mayMonth = ((await mayReserve.json()) as { month: string }).month;
    const juneMonth = ((await juneReserve.json()) as { month: string }).month;

    await post(instance, "/budget/release", {
      ledgerId: "ledger-shared",
      reservedUsdMicros: 10_000_000,
      month: mayMonth,
      now: Date.UTC(2026, 4, 15),
    });
    const juneRelease = await post(instance, "/budget/release", {
      ledgerId: "ledger-shared",
      reservedUsdMicros: 10_000_000,
      month: juneMonth,
      now: Date.UTC(2026, 5, 15),
    });

    await expect(juneRelease.json()).resolves.toMatchObject({
      state: { month: "2026-06", reservedUsdMicros: 0, spentUsdMicros: 0 },
    });
  });

  it("frees the reservation exactly once when settle follows release for a ledger", async () => {
    const instance = createDo();
    await post(instance, "/budget/reserve", {
      estimateUsdMicros: 10_000_000,
      monthlyLimitUsdMicros: 100_000_000,
    });
    await post(instance, "/budget/reserve", {
      estimateUsdMicros: 5_000_000,
      monthlyLimitUsdMicros: 100_000_000,
    });

    await post(instance, "/budget/release", { ledgerId: "ledger-flip", reservedUsdMicros: 10_000_000 });
    // A branch-flipping retry can settle after an earlier release; reserved must
    // not be subtracted twice, but the recovered spend must still land.
    const settle = await post(instance, "/budget/settle", {
      ledgerId: "ledger-flip",
      reservedUsdMicros: 10_000_000,
      actualUsdMicros: 4_000_000,
    });

    await expect(settle.json()).resolves.toMatchObject({
      state: { reservedUsdMicros: 5_000_000, spentUsdMicros: 4_000_000 },
    });
  });

  it("frees the reservation exactly once when release follows settle for a ledger", async () => {
    const instance = createDo();
    await post(instance, "/budget/reserve", {
      estimateUsdMicros: 10_000_000,
      monthlyLimitUsdMicros: 100_000_000,
    });
    await post(instance, "/budget/reserve", {
      estimateUsdMicros: 5_000_000,
      monthlyLimitUsdMicros: 100_000_000,
    });

    await post(instance, "/budget/settle", {
      ledgerId: "ledger-flip",
      reservedUsdMicros: 10_000_000,
      actualUsdMicros: 4_000_000,
    });
    const release = await post(instance, "/budget/release", { ledgerId: "ledger-flip", reservedUsdMicros: 10_000_000 });

    await expect(release.json()).resolves.toMatchObject({
      state: { reservedUsdMicros: 5_000_000, spentUsdMicros: 4_000_000 },
    });
  });

  it("settles reservations against the reservation month", async () => {
    const instance = createDo();
    const reserve = await post(instance, "/budget/reserve", {
      estimateUsdMicros: 10_000_000,
      monthlyLimitUsdMicros: 100_000_000,
      now: Date.UTC(2026, 4, 31, 23, 59, 59),
    });
    const reserveBody = (await reserve.json()) as { month: string };

    const response = await post(instance, "/budget/settle", {
      reservedUsdMicros: 10_000_000,
      actualUsdMicros: 3_000_000,
      month: reserveBody.month,
      now: Date.UTC(2026, 5, 1, 0, 0, 1),
    });

    await expect(response.json()).resolves.toMatchObject({
      state: { month: "2026-05", reservedUsdMicros: 0, spentUsdMicros: 3_000_000 },
    });
  });

  it("rejects concurrent reservations that would exceed the monthly limit", async () => {
    const instance = createDo();
    const requests = Array.from({ length: 11 }, () =>
      post(instance, "/budget/reserve", {
        estimateUsdMicros: 10_000_000,
        monthlyLimitUsdMicros: 100_000_000,
      }),
    );

    const responses = await Promise.all(requests);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(10);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
  });
});
