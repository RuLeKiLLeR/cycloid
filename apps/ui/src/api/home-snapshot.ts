import type { SsoOrg } from "../../../../shared/types/bootstrap";
import type { Repo } from "../types";

export const HOME_SNAPSHOT_SCHEMA_VERSION = 1;
export const HOME_SNAPSHOT_KEY_PREFIX = "cycloid.home-snapshot.";
export const HOME_SNAPSHOT_MAX_BYTES = 1_000_000;

type HomeSnapshot = {
  userId: string;
  businessId: string;
  repos: Repo[];
  ssoOrgs: SsoOrg[];
  defaultRepoUrl: string | null;
  ts: number;
  schemaVersion: number;
};

type HomeSnapshotInput = {
  businessId: string;
  repos: Repo[];
  ssoOrgs: SsoOrg[];
  defaultRepoUrl: string | null;
};

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function snapshotKey(userId: string): string {
  return `${HOME_SNAPSHOT_KEY_PREFIX}${userId}`;
}

function removeSnapshotKey(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Persistence is best-effort only.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRepo(value: unknown): value is Repo {
  if (!isRecord(value)) return false;
  return (
    typeof value.fullName === "string" &&
    typeof value.url === "string" &&
    typeof value.private === "boolean" &&
    typeof value.defaultBranch === "string" &&
    (value.ownerType === "User" || value.ownerType === "Organization")
  );
}

function isSsoOrg(value: unknown): value is SsoOrg {
  if (!isRecord(value)) return false;
  return (
    typeof value.orgId === "number" &&
    (typeof value.login === "string" || value.login === null) &&
    (typeof value.authorizeUrl === "string" || value.authorizeUrl === null)
  );
}

function parseHomeSnapshot(value: unknown, userId: string): HomeSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== HOME_SNAPSHOT_SCHEMA_VERSION) return null;
  if (value.userId !== userId) return null;
  if (typeof value.businessId !== "string") return null;
  if (!Array.isArray(value.repos) || !value.repos.every(isRepo)) return null;
  if (!Array.isArray(value.ssoOrgs) || !value.ssoOrgs.every(isSsoOrg)) return null;
  if (typeof value.defaultRepoUrl !== "string" && value.defaultRepoUrl !== null) return null;
  if (typeof value.ts !== "number" || !Number.isFinite(value.ts)) return null;
  return {
    userId: value.userId,
    businessId: value.businessId,
    repos: value.repos,
    ssoOrgs: value.ssoOrgs,
    defaultRepoUrl: value.defaultRepoUrl,
    ts: value.ts,
    schemaVersion: value.schemaVersion,
  };
}

export function readHomeSnapshot(userId: string | null): HomeSnapshot | null {
  if (!userId) return null;
  const key = snapshotKey(userId);
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  if (raw.length > HOME_SNAPSHOT_MAX_BYTES) {
    removeSnapshotKey(key);
    return null;
  }
  try {
    const parsed = parseHomeSnapshot(JSON.parse(raw), userId);
    if (!parsed) removeSnapshotKey(key);
    return parsed;
  } catch {
    removeSnapshotKey(key);
    return null;
  }
}

export function writeHomeSnapshot(
  userId: string | null,
  snapshot: HomeSnapshotInput,
  nowMs: () => number = Date.now,
): void {
  if (!userId) return;
  const value: HomeSnapshot = {
    ...snapshot,
    userId,
    ts: nowMs(),
    schemaVersion: HOME_SNAPSHOT_SCHEMA_VERSION,
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return;
  }
  if (serialized.length > HOME_SNAPSHOT_MAX_BYTES) return;
  try {
    storage()?.setItem(snapshotKey(userId), serialized);
  } catch {
    // Quota, private-mode, and disabled-storage failures degrade to network.
  }
}

export function purgeHomeSnapshots(): void {
  const store = storage();
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(HOME_SNAPSHOT_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // Persistence is best-effort only.
  }
}

export function purgeHomeSnapshotsForApiPrefix(keyPrefix: string): void {
  if (keyPrefix.startsWith("/api/repos?") || keyPrefix.startsWith("/api/bootstrap")) {
    purgeHomeSnapshots();
  }
}
