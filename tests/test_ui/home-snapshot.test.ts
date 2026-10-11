import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  HOME_SNAPSHOT_KEY_PREFIX,
  HOME_SNAPSHOT_MAX_BYTES,
  HOME_SNAPSHOT_SCHEMA_VERSION,
  purgeHomeSnapshots,
  readHomeSnapshot,
  writeHomeSnapshot,
} from "../../apps/ui/src/api/home-snapshot.js";
import type { Repo } from "../../apps/ui/src/types.js";
import type { SsoOrg } from "../../shared/types/bootstrap.js";

const TEST_REPO: Repo = {
  fullName: "trycycloid/cycloid",
  url: "https://github.com/trycycloid/cycloid",
  private: true,
  defaultBranch: "main",
  ownerType: "Organization",
};

const TEST_SSO_ORG: SsoOrg = {
  orgId: 42,
  login: "trycycloid",
  authorizeUrl: "/auth/github/sso?org=42",
};

function key(userId: string): string {
  return `${HOME_SNAPSHOT_KEY_PREFIX}${userId}`;
}

function installStorage(): Storage {
  const values = new Map<string, string>();
  const store: Storage = {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((name: string) => values.get(name) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((name: string) => {
      values.delete(name);
    }),
    setItem: vi.fn((name: string, value: string) => {
      values.set(name, value);
    }),
  };
  vi.stubGlobal("localStorage", store);
  return store;
}

beforeEach(() => {
  installStorage();
});

describe("home snapshot", () => {
  it("writes and reads the minimal user-scoped snapshot", () => {
    writeHomeSnapshot(
      "user-1",
      {
        businessId: "biz-1",
        repos: [TEST_REPO],
        ssoOrgs: [TEST_SSO_ORG],
        defaultRepoUrl: TEST_REPO.url,
      },
      () => 123,
    );

    expect(readHomeSnapshot("user-1")).toEqual({
      userId: "user-1",
      businessId: "biz-1",
      repos: [TEST_REPO],
      ssoOrgs: [TEST_SSO_ORG],
      defaultRepoUrl: TEST_REPO.url,
      ts: 123,
      schemaVersion: HOME_SNAPSHOT_SCHEMA_VERSION,
    });
  });

  it("skips writes until the resolved user id is known", () => {
    writeHomeSnapshot(null, {
      businessId: "biz-1",
      repos: [TEST_REPO],
      ssoOrgs: [],
      defaultRepoUrl: TEST_REPO.url,
    });

    expect(localStorage.length).toBe(0);
  });

  it("rejects and removes malformed snapshots", () => {
    localStorage.setItem(key("user-1"), "{nope");

    expect(readHomeSnapshot("user-1")).toBeNull();
    expect(localStorage.getItem(key("user-1"))).toBeNull();
  });

  it("rejects and removes schema-version mismatches", () => {
    localStorage.setItem(
      key("user-1"),
      JSON.stringify({
        userId: "user-1",
        businessId: "biz-1",
        repos: [TEST_REPO],
        ssoOrgs: [],
        defaultRepoUrl: TEST_REPO.url,
        ts: 1,
        schemaVersion: HOME_SNAPSHOT_SCHEMA_VERSION + 1,
      }),
    );

    expect(readHomeSnapshot("user-1")).toBeNull();
    expect(localStorage.getItem(key("user-1"))).toBeNull();
  });

  it("rejects and removes identity mismatches", () => {
    localStorage.setItem(
      key("user-1"),
      JSON.stringify({
        userId: "user-2",
        businessId: "biz-1",
        repos: [TEST_REPO],
        ssoOrgs: [],
        defaultRepoUrl: TEST_REPO.url,
        ts: 1,
        schemaVersion: HOME_SNAPSHOT_SCHEMA_VERSION,
      }),
    );

    expect(readHomeSnapshot("user-1")).toBeNull();
    expect(localStorage.getItem(key("user-1"))).toBeNull();
  });

  it("rejects and removes oversized stored snapshots", () => {
    localStorage.setItem(key("user-1"), "x".repeat(HOME_SNAPSHOT_MAX_BYTES + 1));

    expect(readHomeSnapshot("user-1")).toBeNull();
    expect(localStorage.getItem(key("user-1"))).toBeNull();
  });

  it("skips oversized writes", () => {
    writeHomeSnapshot("user-1", {
      businessId: "biz-1",
      repos: [
        {
          ...TEST_REPO,
          fullName: `trycycloid/${"a".repeat(HOME_SNAPSHOT_MAX_BYTES)}`,
        },
      ],
      ssoOrgs: [],
      defaultRepoUrl: TEST_REPO.url,
    });

    expect(localStorage.getItem(key("user-1"))).toBeNull();
  });

  it("degrades when localStorage operations throw", () => {
    const store = installStorage();
    const getItem = vi.spyOn(store, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readHomeSnapshot("user-1")).toBeNull();
    getItem.mockRestore();

    const setItem = vi.spyOn(store, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() =>
      writeHomeSnapshot("user-1", {
        businessId: "biz-1",
        repos: [TEST_REPO],
        ssoOrgs: [],
        defaultRepoUrl: TEST_REPO.url,
      }),
    ).not.toThrow();
    setItem.mockRestore();
  });

  it("purges only home snapshot keys", () => {
    localStorage.setItem(key("user-1"), "snapshot");
    localStorage.setItem("cycloid:theme", "dark");

    purgeHomeSnapshots();

    expect(localStorage.getItem(key("user-1"))).toBeNull();
    expect(localStorage.getItem("cycloid:theme")).toBe("dark");
  });
});
