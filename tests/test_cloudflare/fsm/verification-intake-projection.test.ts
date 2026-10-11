// ARC-1330 W11-V10 — the QA-findings re-intake parity projection: the pure head-scoped predicate + the
// best-effort dual-run parity emit (match/diverge/store_read_failed), FSM_MODE=live only.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  emitVerificationIntakeStanddownParity,
  hasRegisteredVerificationFinding,
  verificationFindingPrefixForHead,
} from "../../../apps/control-plane-worker/src/session/fsm/verification-intake-projection";
import { registerDispositionsIfAbsent } from "../../../apps/control-plane-worker/src/session/pr-review-item-disposition-db";
import { SqliteD1 } from "../sqlite-d1-helper";

const MIGRATIONS_DIR = resolve(__dirname, "../../../apps/control-plane-worker/migrations");

function createMigratedSqlite(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

function asD1(sqlite: Database.Database): D1Database {
  return new SqliteD1(sqlite) as unknown as D1Database;
}

describe("verification-intake-projection — pure predicate (W11-V10)", () => {
  it("verificationFindingPrefixForHead namespaces by head", () => {
    expect(verificationFindingPrefixForHead("headH")).toBe("verification:headH:");
  });

  it("hasRegisteredVerificationFinding matches a head-scoped finding regardless of the run/attempt discriminator", () => {
    // FSM keys on <run>, legacy on <attempt> — a head-scoped PREFIX match tolerates both so a real
    // re-intake never reads as divergence.
    expect(hasRegisteredVerificationFinding(["verification:headH:6"], "headH")).toBe(true);
    expect(hasRegisteredVerificationFinding(["verification:headH:2"], "headH")).toBe(true);
    // A finding for a DIFFERENT head is not this verdict's re-intake.
    expect(hasRegisteredVerificationFinding(["verification:otherHead:6"], "headH")).toBe(false);
    // A review item (not a verification finding) does not count.
    expect(hasRegisteredVerificationFinding(["bot:12345"], "headH")).toBe(false);
    expect(hasRegisteredVerificationFinding([], "headH")).toBe(false);
  });
});

describe("verification-intake-projection — dual-run parity emit (W11-V10)", () => {
  let db: D1Database;
  let emitted: Array<Record<string, unknown>>;
  const PR_URL = "https://github.com/acme/repo/pull/7";

  beforeEach(() => {
    db = asD1(createMigratedSqlite());
    emitted = [];
    vi.restoreAllMocks();
  });

  async function importWithEmitSpy() {
    const mod = await import("../../../apps/control-plane-worker/src/observability/events-exporter");
    vi.spyOn(mod, "postStructuredEventToDd").mockImplementation(async (_env, payload) => {
      emitted.push(payload as Record<string, unknown>);
      return true;
    });
  }

  it("is a no-op under an unbound DB (never samples)", async () => {
    await importWithEmitSpy();
    await emitVerificationIntakeStanddownParity({ DB: {} } as never, {
      sessionId: "s",
      prUrl: PR_URL,
      headSha: "headH",
    });
    expect(emitted).toEqual([]);
  });

  it("emits result:match when the FSM registered a head-scoped finding for the PR", async () => {
    await importWithEmitSpy();
    await registerDispositionsIfAbsent(db, [{ sessionId: "s", prUrl: PR_URL, sourceId: "verification:headH:6" }], 1);

    await emitVerificationIntakeStanddownParity({ DB: db, FSM_MODE: "live", DD_API_KEY: "k" } as never, {
      sessionId: "s",
      prUrl: PR_URL,
      headSha: "headH",
    });

    expect(emitted).toMatchObject([
      { event: "fsm.verification_intake_parity", result: "match", fsm_finding_registered: true },
    ]);
  });

  it("emits result:diverge when no head-scoped finding was registered (the FSM re-intake did not fire)", async () => {
    await importWithEmitSpy();
    // A finding for a stale head only — not this verdict's head.
    await registerDispositionsIfAbsent(db, [{ sessionId: "s", prUrl: PR_URL, sourceId: "verification:oldHead:1" }], 1);

    await emitVerificationIntakeStanddownParity({ DB: db, FSM_MODE: "live", DD_API_KEY: "k" } as never, {
      sessionId: "s",
      prUrl: PR_URL,
      headSha: "headH",
    });

    expect(emitted).toMatchObject([
      { event: "fsm.verification_intake_parity", result: "diverge", fsm_finding_registered: false },
    ]);
  });
});
