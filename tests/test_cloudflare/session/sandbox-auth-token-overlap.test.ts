import { describe, expect, it } from "vitest";

import {
  parseAuthTokenGenerations,
  rollAuthTokenGenerations,
  type SandboxAuthTokenGeneration,
  selectValidAuthTokenGenerations,
  serializeAuthTokenGenerations,
} from "../../../apps/control-plane-worker/src/session/sandbox-auth-token-overlap";

const OVERLAP_MS = 90_000;
const MAX = 3;

describe("parseAuthTokenGenerations", () => {
  it("returns [] for null/undefined/empty", () => {
    expect(parseAuthTokenGenerations(null)).toEqual([]);
    expect(parseAuthTokenGenerations(undefined)).toEqual([]);
    expect(parseAuthTokenGenerations("")).toEqual([]);
  });

  it("returns [] for malformed JSON without throwing", () => {
    expect(parseAuthTokenGenerations("{not json")).toEqual([]);
  });

  it("returns [] for non-array JSON", () => {
    expect(parseAuthTokenGenerations('{"hash":"a","expiresAt":1}')).toEqual([]);
  });

  it("filters out entries missing or with wrong-typed fields", () => {
    const raw = JSON.stringify([
      { hash: "ok", expiresAt: 100 },
      { hash: "", expiresAt: 100 }, // empty hash
      { hash: "noexp" }, // missing expiresAt
      { hash: "badexp", expiresAt: "soon" }, // wrong type
      { expiresAt: 100 }, // missing hash
      "garbage",
    ]);
    expect(parseAuthTokenGenerations(raw)).toEqual([{ hash: "ok", expiresAt: 100 }]);
  });

  it("round-trips through serialize", () => {
    const list: SandboxAuthTokenGeneration[] = [
      { hash: "a", expiresAt: 10 },
      { hash: "b", expiresAt: 20 },
    ];
    expect(parseAuthTokenGenerations(serializeAuthTokenGenerations(list))).toEqual(list);
  });
});

describe("selectValidAuthTokenGenerations", () => {
  it("drops expired (expiresAt <= now) and keeps future", () => {
    const now = 1_000;
    const list: SandboxAuthTokenGeneration[] = [
      { hash: "future", expiresAt: now + 1 },
      { hash: "exactly-now", expiresAt: now }, // not strictly > now -> dropped
      { hash: "past", expiresAt: now - 1 },
    ];
    expect(selectValidAuthTokenGenerations(list, now)).toEqual([{ hash: "future", expiresAt: now + 1 }]);
  });

  it("returns [] when all expired", () => {
    expect(selectValidAuthTokenGenerations([{ hash: "a", expiresAt: 5 }], 10)).toEqual([]);
  });
});

describe("rollAuthTokenGenerations", () => {
  it("prepends the outgoing hash newest-first with expiresAt = now + overlapMs", () => {
    const now = 1_000;
    const result = rollAuthTokenGenerations({
      existing: [],
      outgoingHash: "gen1",
      now,
      overlapMs: OVERLAP_MS,
      maxGenerations: MAX,
    });
    expect(result).toEqual([{ hash: "gen1", expiresAt: now + OVERLAP_MS }]);
  });

  it("keeps newest-first ordering across multiple rolls", () => {
    let list: SandboxAuthTokenGeneration[] = [];
    list = rollAuthTokenGenerations({
      existing: list,
      outgoingHash: "g1",
      now: 0,
      overlapMs: OVERLAP_MS,
      maxGenerations: MAX,
    });
    list = rollAuthTokenGenerations({
      existing: list,
      outgoingHash: "g2",
      now: 1,
      overlapMs: OVERLAP_MS,
      maxGenerations: MAX,
    });
    list = rollAuthTokenGenerations({
      existing: list,
      outgoingHash: "g3",
      now: 2,
      overlapMs: OVERLAP_MS,
      maxGenerations: MAX,
    });
    expect(list.map((g) => g.hash)).toEqual(["g3", "g2", "g1"]);
  });

  it("caps at maxGenerations, dropping the oldest", () => {
    let list: SandboxAuthTokenGeneration[] = [];
    for (let i = 1; i <= 5; i++) {
      list = rollAuthTokenGenerations({
        existing: list,
        outgoingHash: `g${i}`,
        now: i,
        overlapMs: OVERLAP_MS,
        maxGenerations: MAX,
      });
    }
    expect(list.map((g) => g.hash)).toEqual(["g5", "g4", "g3"]);
  });

  it("prunes expired entries before capping", () => {
    const now = 100_000;
    const existing: SandboxAuthTokenGeneration[] = [
      { hash: "fresh", expiresAt: now + 1 },
      { hash: "stale", expiresAt: now - 1 },
    ];
    const result = rollAuthTokenGenerations({
      existing,
      outgoingHash: "new",
      now,
      overlapMs: OVERLAP_MS,
      maxGenerations: MAX,
    });
    expect(result.map((g) => g.hash)).toEqual(["new", "fresh"]);
  });

  it("just prunes expired when outgoingHash is null (no real rotation)", () => {
    const now = 100;
    const existing: SandboxAuthTokenGeneration[] = [
      { hash: "fresh", expiresAt: now + 1 },
      { hash: "stale", expiresAt: now - 1 },
    ];
    expect(
      rollAuthTokenGenerations({ existing, outgoingHash: null, now, overlapMs: OVERLAP_MS, maxGenerations: MAX }),
    ).toEqual([{ hash: "fresh", expiresAt: now + 1 }]);
  });

  it("does not duplicate when the outgoing hash is already the newest entry", () => {
    const now = 10;
    const existing: SandboxAuthTokenGeneration[] = [{ hash: "g1", expiresAt: now + OVERLAP_MS }];
    const result = rollAuthTokenGenerations({
      existing,
      outgoingHash: "g1",
      now,
      overlapMs: OVERLAP_MS,
      maxGenerations: MAX,
    });
    expect(result).toEqual(existing);
  });

  it("re-rolls a hash that exists deeper in the list to the newest slot without duplicating", () => {
    const now = 10;
    const existing: SandboxAuthTokenGeneration[] = [
      { hash: "g2", expiresAt: now + OVERLAP_MS },
      { hash: "g1", expiresAt: now + OVERLAP_MS },
    ];
    const result = rollAuthTokenGenerations({
      existing,
      outgoingHash: "g1",
      now,
      overlapMs: OVERLAP_MS,
      maxGenerations: MAX,
    });
    expect(result.map((g) => g.hash)).toEqual(["g1", "g2"]);
    expect(result.filter((g) => g.hash === "g1")).toHaveLength(1);
    // refreshed to the new expiry
    expect(result[0].expiresAt).toBe(now + OVERLAP_MS);
  });

  it("falls back to single-generation overlap when maxGenerations = 1", () => {
    let list: SandboxAuthTokenGeneration[] = [];
    list = rollAuthTokenGenerations({
      existing: list,
      outgoingHash: "g1",
      now: 0,
      overlapMs: OVERLAP_MS,
      maxGenerations: 1,
    });
    list = rollAuthTokenGenerations({
      existing: list,
      outgoingHash: "g2",
      now: 1,
      overlapMs: OVERLAP_MS,
      maxGenerations: 1,
    });
    expect(list.map((g) => g.hash)).toEqual(["g2"]);
  });
});
