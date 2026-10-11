import { describe, expect, it } from "vitest";

import { FakeStorage } from "./helpers/worker-harness";

describe("worker harness FakeStorage", () => {
  it("rejects transactionSync while an async transaction is pending", async () => {
    const storage = new FakeStorage();
    let releaseTransaction: () => void;
    const transactionBlocker = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });

    const pendingTransaction = storage.transaction(async (txn) => {
      await transactionBlocker;
      await txn.put("async-key", "async-value");
    });

    expect(() => storage.transactionSync(() => "sync-value")).toThrow(
      "FakeStorage transactionSync cannot run while an async transaction is pending",
    );

    releaseTransaction();
    await pendingTransaction;

    expect(storage.transactionSync(() => "sync-value")).toBe("sync-value");
  });
});
