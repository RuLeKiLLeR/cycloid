import { d1Changed } from "../db/errors";

export type PrBodyRegionName = "visualEvidence";

export interface PrBodyIdentity {
  repoOwner: string;
  repoName: string;
  installationId: number;
  prNumber: number;
  prUrl: string;
}

export interface PrBodyRegionRow {
  region: PrBodyRegionName;
  body: string;
  updatedAt: number;
}

interface PrBodyDocumentDbRow {
  base_body: string;
  updated_at: number;
}

interface PrBodyRegionDbRow {
  region: string;
  body: string;
  updated_at: number;
}

export interface PrBodyDocument {
  baseBody: string;
  updatedAt: number;
}

const LEASE_TTL_MS = 30_000;

function bindIdentity(stmt: D1PreparedStatement, identity: PrBodyIdentity): D1PreparedStatement {
  return stmt.bind(identity.repoOwner, identity.repoName, identity.installationId, identity.prNumber);
}

export async function upsertPrBodyDocument(
  db: D1Database,
  identity: PrBodyIdentity,
  baseBody: string,
  nowMs: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pr_body_documents (
        repo_owner, repo_name, installation_id, pr_number, pr_url, base_body, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_owner, repo_name, installation_id, pr_number)
      DO UPDATE SET pr_url = excluded.pr_url, base_body = excluded.base_body, updated_at = excluded.updated_at`,
    )
    .bind(
      identity.repoOwner,
      identity.repoName,
      identity.installationId,
      identity.prNumber,
      identity.prUrl,
      baseBody,
      nowMs,
    )
    .run();
}

export async function upsertPrBodyRegion(
  db: D1Database,
  identity: PrBodyIdentity,
  region: PrBodyRegionName,
  body: string,
  nowMs: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pr_body_regions (
        repo_owner, repo_name, installation_id, pr_number, region, pr_url, body, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_owner, repo_name, installation_id, pr_number, region)
      DO UPDATE SET pr_url = excluded.pr_url, body = excluded.body, updated_at = excluded.updated_at`,
    )
    .bind(
      identity.repoOwner,
      identity.repoName,
      identity.installationId,
      identity.prNumber,
      region,
      identity.prUrl,
      body,
      nowMs,
    )
    .run();
}

export async function getPrBodyDocument(db: D1Database, identity: PrBodyIdentity): Promise<PrBodyDocument | null> {
  const row = await bindIdentity(
    db.prepare(
      `SELECT base_body, updated_at
       FROM pr_body_documents
       WHERE repo_owner = ? AND repo_name = ? AND installation_id = ? AND pr_number = ?
       LIMIT 1`,
    ),
    identity,
  ).first<PrBodyDocumentDbRow>();
  return row ? { baseBody: row.base_body, updatedAt: row.updated_at } : null;
}

export async function listPrBodyRegions(db: D1Database, identity: PrBodyIdentity): Promise<PrBodyRegionRow[]> {
  const result = await bindIdentity(
    db.prepare(
      `SELECT region, body, updated_at
       FROM pr_body_regions
       WHERE repo_owner = ? AND repo_name = ? AND installation_id = ? AND pr_number = ?
       ORDER BY region ASC`,
    ),
    identity,
  ).all<PrBodyRegionDbRow>();
  return (result.results ?? []).flatMap((row): PrBodyRegionRow[] => {
    if (row.region !== "visualEvidence") return [];
    return [{ region: row.region, body: row.body, updatedAt: row.updated_at }];
  });
}

export async function tryAcquirePrBodyLease(
  db: D1Database,
  identity: PrBodyIdentity,
  leaseOwner: string,
  nowMs: number,
): Promise<boolean> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO pr_body_locks (
        repo_owner, repo_name, installation_id, pr_number, lease_owner, lease_expires_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, 0, ?)`,
    )
    .bind(identity.repoOwner, identity.repoName, identity.installationId, identity.prNumber, nowMs)
    .run();

  const result = await db
    .prepare(
      `UPDATE pr_body_locks
       SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
       WHERE repo_owner = ? AND repo_name = ? AND installation_id = ? AND pr_number = ?
         AND (lease_owner IS NULL OR lease_expires_at <= ? OR lease_owner = ?)`,
    )
    .bind(
      leaseOwner,
      nowMs + LEASE_TTL_MS,
      nowMs,
      identity.repoOwner,
      identity.repoName,
      identity.installationId,
      identity.prNumber,
      nowMs,
      leaseOwner,
    )
    .run();
  return d1Changed(result);
}

export async function releasePrBodyLease(
  db: D1Database,
  identity: PrBodyIdentity,
  leaseOwner: string,
  nowMs: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE pr_body_locks
       SET lease_owner = NULL, lease_expires_at = 0, updated_at = ?
       WHERE repo_owner = ? AND repo_name = ? AND installation_id = ? AND pr_number = ? AND lease_owner = ?`,
    )
    .bind(nowMs, identity.repoOwner, identity.repoName, identity.installationId, identity.prNumber, leaseOwner)
    .run();
}
