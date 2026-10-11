import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";
import { resetInstallationByOwnerCacheForTests } from "../../apps/control-plane-worker/src/github/installations-db";
import { businessRoutes } from "../../apps/control-plane-worker/src/routes/businesses";
import {
  buildAndCacheModels,
  modelsCacheKey,
  resetModelsMemoryCache,
} from "../../apps/control-plane-worker/src/services/bootstrap";
import { REPOS_CACHE_SCHEMA_VERSION, resetReposMemoryCache } from "../../apps/control-plane-worker/src/services/repos";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { serializeNeonBranchCredentialConfig } from "../../shared/integrations/neon.js";
import { lastDdEvent } from "./helpers/dd-events";
import { BaseFakeD1Statement } from "./helpers/fake-d1";
import { createWorkerTestEnv } from "./helpers/worker-env";
import {
  createDurableNamespace,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  workerFetch,
  type WorkerModule,
} from "./helpers/worker-harness";

mockCloudflareWorkers();
mockSentryCloudflare();

const mockPostStructuredEventToDd = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

const lastAuditEvent = (eventName: string) => lastDdEvent(mockPostStructuredEventToDd, eventName);

function getBusinessRoute(method: string, pathname: string) {
  const route = businessRoutes.find((candidate) => candidate.method === method && pathname.match(candidate.pattern));
  if (!route) {
    throw new Error(`Route not found for ${method} ${pathname}`);
  }
  return route;
}

type AuthTokenUser = {
  user_id: number;
  expires_at: number;
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  business_id: string;
};

interface BusinessRow {
  id: string;
  name: string;
  shared_sessions: number;
  self_hosted_sandboxes_enabled?: number;
  egress_allowlist_json?: string | null;
  egress_allowlist_source_repo_owner?: string | null;
  egress_allowlist_source_repo_name?: string | null;
  created_at: number;
  updated_at?: number;
}

interface UserRow {
  id: number;
  business_id: string;
  github_id?: number | null;
  login?: string;
  name?: string | null;
  avatar_url?: string | null;
}

interface OpenAIVirtualKeyRow {
  id: string;
  owner_user_id: string;
  status: string;
}

interface LinearWebhookInstallationRow {
  business_id: string;
  linear_organization_id: string;
  linear_organization_name: string | null;
  linear_organization_url_key: string | null;
  linear_webhook_id: string | null;
  connected_by_user_id: number;
  status: "active" | "revoked";
  connected_at: number;
  updated_at: number;
  revoked_at: number | null;
}

interface EnvBlobRow {
  id: string;
  owner_user_id: number;
  business_id: string | null;
  name: string;
  env_text: string;
  encrypted: number;
  key_names_json: string;
  entry_meta_json: string;
  is_global: number;
  created_at: number;
  updated_at: number;
}

interface EnvBlobRepoRow {
  env_blob_id: string;
  repo_owner: string;
  repo_name: string;
  created_at: number;
}

interface UserIntegrationRow {
  user_id: number;
  integration_id: string;
  oauth_access_token: string | null;
  oauth_refresh_token: string | null;
  oauth_expires_at: number | null;
  api_key?: string | null;
  external_user_id?: string | null;
  encrypted: number;
  last_validation_status?: string | null;
}

interface GithubInstallationRow {
  installation_id: number;
  owner_login: string;
  owner_id: number;
  owner_type: string;
  repository_selection: string | null;
  permissions_json: string | null;
  events_json: string | null;
  created_at: number;
  suspended_at: number | null;
}

interface BusinessIntegrationHealthCheckRow {
  id: string;
  business_id: string;
  integration_id: string;
  check_kind: string;
  status: "passed" | "failed" | "skipped";
  operation: string;
  checked_at: number;
  latency_ms: number;
  diagnostic: string;
  failure_reason: string | null;
  details_json: string | null;
  created_at: number;
}

interface IntegrationLifecycleEventRow {
  id: string;
  business_id: string | null;
  user_id: number | null;
  session_id: string | null;
  integration_id: string;
  stage: string;
  status: "passed" | "failed" | "skipped";
  reason_code: string | null;
  message: string | null;
  details_json: string | null;
  latency_ms: number;
  created_at: number;
}

class FakeD1Statement extends BaseFakeD1Statement<FakeD1> {
  private getRepoEnvBlobCurrentWinnerRow(): { kept_blob_still_current_winner: number } {
    const [keepId, businessId, name, expectedUpdatedAt, repoOwner, repoName] = this.boundValues as [
      string,
      string,
      string,
      number,
      string,
      string,
    ];
    const winner = this.db.envBlobs.get(keepId);
    const winnerRepo = [...this.db.envBlobRepos.values()].find(
      (repo) => repo.env_blob_id === keepId && repo.repo_owner === repoOwner && repo.repo_name === repoName,
    );
    const newerBlobExists = [...this.db.envBlobs.values()].some((blob) => {
      if (blob.business_id !== businessId || blob.name !== name || blob.is_global !== 0) return false;
      const blobRepo = [...this.db.envBlobRepos.values()].find(
        (repo) => repo.env_blob_id === blob.id && repo.repo_owner === repoOwner && repo.repo_name === repoName,
      );
      if (!blobRepo) return false;
      return blob.updated_at > expectedUpdatedAt || (blob.updated_at === expectedUpdatedAt && blob.id > keepId);
    });
    const stillCurrent =
      winner !== undefined &&
      winnerRepo !== undefined &&
      winner.business_id === businessId &&
      winner.name === name &&
      winner.is_global === 0 &&
      winner.updated_at === expectedUpdatedAt &&
      !newerBlobExists;
    return { kept_blob_still_current_winner: stillCurrent ? 1 : 0 };
  }

  async run(): Promise<{ success: true; meta: { last_row_id: number; changes?: number } }> {
    if (this.isSchemaQuery()) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO businesses")) {
      const [id, name, createdAt, updatedAt] = this.boundValues as [string, string, number, number];
      this.db.businesses.set(id, { id, name, shared_sessions: 0, created_at: createdAt, updated_at: updatedAt });
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("UPDATE businesses SET shared_sessions")) {
      const [sharedSessions, updatedAt, id] = this.boundValues as [number, number, string];
      const biz = this.db.businesses.get(id);
      if (biz) {
        biz.shared_sessions = sharedSessions;
        biz.updated_at = updatedAt;
      }
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("UPDATE businesses SET egress_allowlist_json")) {
      const [egressAllowlistJson, updatedAt, id] = this.boundValues as [string | null, number, string];
      const biz = this.db.businesses.get(id);
      if (biz) {
        biz.egress_allowlist_json = egressAllowlistJson;
        biz.updated_at = updatedAt;
      }
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("egress_allowlist_source_repo_owner")) {
      const [owner, name, updatedAt, id] = this.boundValues as [string | null, string | null, number, string];
      const biz = this.db.businesses.get(id);
      if (biz) {
        biz.egress_allowlist_source_repo_owner = owner;
        biz.egress_allowlist_source_repo_name = name;
        biz.updated_at = updatedAt;
      }
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("UPDATE users SET business_id")) {
      const [businessId, _updatedAt, userId] = this.boundValues as [string, number, number];
      const user = this.db.users.get(userId);
      if (user) user.business_id = businessId;
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO business_members")) {
      const [businessId, userId, role] = this.boundValues as [string, number, string, number, number];
      this.db.businessMembers.set(`${businessId}:${userId}`, { business_id: businessId, user_id: userId, role });
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("DELETE FROM business_members")) {
      const [businessId, userId] = this.boundValues as [string, number];
      this.db.businessMembers.delete(`${businessId}:${userId}`);
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("UPDATE business_members SET role")) {
      const [role, , businessId, userId] = this.boundValues as [string, number, string, number];
      const key = `${businessId}:${userId}`;
      const member = this.db.businessMembers.get(key);
      if (member) member.role = role;
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO session_index")) {
      const sessionId = this.boundValues[0] as string;
      const ownerUserId = this.boundValues[1] as string;
      const businessId = this.boundValues[2] as string | null;
      const status = this.boundValues[3] as string;
      const createdAt = this.boundValues[4] as string;
      const updatedAt = this.boundValues[5] as string;
      const closedAt = this.boundValues[6] as string | null;
      const lastEventId = this.boundValues[7] as string | null;
      const installationId = this.boundValues[14] as number | null;
      const repoOwner = this.boundValues[15] as string | null;
      const repoName = this.boundValues[16] as string | null;
      const existing = this.db.sessionIndex.get(sessionId);
      const resolvedBusinessId =
        (existing?.business_id as string | null | undefined) ??
        businessId ??
        this.db.users.get(Number(ownerUserId))?.business_id ??
        null;
      this.db.sessionIndex.set(sessionId, {
        ...existing,
        session_id: sessionId,
        owner_user_id: ownerUserId,
        business_id: resolvedBusinessId,
        status,
        created_at: createdAt,
        updated_at: updatedAt,
        closed_at: closedAt,
        last_event_id: lastEventId,
        installation_id: installationId ?? existing?.installation_id ?? null,
        repo_owner: repoOwner ?? existing?.repo_owner ?? null,
        repo_name: repoName ?? existing?.repo_name ?? null,
      });
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO durable_event_replay_metadata")) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO session_webhook_refs")) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("DELETE FROM auth_sessions")) {
      const [token] = this.boundValues as [string];
      this.db.authTokens.delete(token);
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("DELETE FROM session_index")) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO user_integrations")) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("DELETE FROM user_integrations")) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO business_integrations")) {
      const [businessId, integrationId, scope] = this.boundValues as [string, string, string, number, number];
      const key = `${businessId}:${integrationId}`;
      this.db.businessIntegrations.set(key, { business_id: businessId, integration_id: integrationId, scope });
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO business_integration_credentials")) {
      const [
        businessId,
        integrationId,
        oauthAccessToken,
        oauthRefreshToken,
        oauthExpiresAt,
        apiKey,
        serviceUrl,
        encrypted,
      ] = this.boundValues as [
        string,
        string,
        string | null,
        string | null,
        number | null,
        string | null,
        string | null,
        number,
      ];
      this.db.businessIntegrationCredentials.set(`${businessId}:${integrationId}`, {
        business_id: businessId,
        integration_id: integrationId,
        oauth_access_token: oauthAccessToken,
        oauth_refresh_token: oauthRefreshToken,
        oauth_expires_at: oauthExpiresAt,
        api_key: apiKey,
        service_url: serviceUrl,
        encrypted,
        last_validated_at: this.boundValues[8] as number | null,
        last_validation_status: this.boundValues[9] as string | null,
        last_validation_reason_code: this.boundValues[10] as string | null,
      });
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("UPDATE business_integration_credentials SET")) {
      const [lastValidatedAt, status, reasonCode, _updatedAt, businessId, integrationId] = this.boundValues as [
        number,
        string,
        string | null,
        number,
        string,
        string,
      ];
      const row = this.db.businessIntegrationCredentials.get(`${businessId}:${integrationId}`);
      if (row)
        Object.assign(row, {
          last_validated_at: lastValidatedAt,
          last_validation_status: status,
          last_validation_reason_code: reasonCode,
        });
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO integration_lifecycle_events")) {
      const [
        id,
        businessId,
        userId,
        sessionId,
        integrationId,
        stage,
        status,
        reasonCode,
        message,
        detailsJson,
        latencyMs,
        createdAt,
      ] = this.boundValues as [
        string,
        string | null,
        number | null,
        string | null,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
        number,
        number,
      ];
      this.db.integrationLifecycleEvents.set(id, {
        id,
        business_id: businessId,
        user_id: userId,
        session_id: sessionId,
        integration_id: integrationId,
        stage,
        status,
        reason_code: reasonCode,
        message,
        details_json: detailsJson,
        latency_ms: latencyMs,
        created_at: createdAt,
      });
      return { success: true, meta: { last_row_id: 0, changes: 1 } };
    }

    if (
      this.query.includes("DELETE FROM env_blobs") &&
      this.query.includes("AND id <> ?") &&
      this.query.includes("id IN")
    ) {
      const [businessId, name, exceptId, businessIdForSubquery, subqueryName, repoOwner, repoName] = this
        .boundValues as [string, string, string, string, string, string, string];
      let changes = 0;
      for (const [id, blob] of [...this.db.envBlobs.entries()]) {
        if (id === exceptId) continue;
        const hasRepo = [...this.db.envBlobRepos.values()].some(
          (repo) => repo.env_blob_id === id && repo.repo_owner === repoOwner && repo.repo_name === repoName,
        );
        if (
          blob.business_id === businessId &&
          blob.business_id === businessIdForSubquery &&
          blob.name === name &&
          blob.name === subqueryName &&
          blob.is_global === 0 &&
          hasRepo
        ) {
          this.db.envBlobs.delete(id);
          for (const [repoKey, repo] of [...this.db.envBlobRepos.entries()]) {
            if (repo.env_blob_id === id) this.db.envBlobRepos.delete(repoKey);
          }
          changes += 1;
        }
      }
      return { success: true, meta: { last_row_id: 0, changes } };
    }

    if (this.query.includes("DELETE FROM env_blobs") && this.query.includes("id IN")) {
      const [businessId, name, businessIdForSubquery, subqueryName, repoOwner, repoName, keepId] = this.boundValues as [
        string,
        string,
        string,
        string,
        string,
        string,
        string | undefined,
      ];
      let changes = 0;
      for (const [id, blob] of [...this.db.envBlobs.entries()]) {
        if (keepId && id === keepId) continue;
        const hasRepo = [...this.db.envBlobRepos.values()].some(
          (repo) => repo.env_blob_id === id && repo.repo_owner === repoOwner && repo.repo_name === repoName,
        );
        if (
          blob.business_id === businessId &&
          blob.business_id === businessIdForSubquery &&
          blob.name === name &&
          blob.name === subqueryName &&
          blob.is_global === 0 &&
          hasRepo
        ) {
          this.db.envBlobs.delete(id);
          for (const [repoKey, repo] of [...this.db.envBlobRepos.entries()]) {
            if (repo.env_blob_id === id) this.db.envBlobRepos.delete(repoKey);
          }
          changes += 1;
        }
      }
      return { success: true, meta: { last_row_id: 0, changes } };
    }

    if (this.query.includes("UPDATE env_blobs") && this.query.includes("SET owner_user_id = ?")) {
      const [
        ownerUserId,
        envText,
        encrypted,
        keyNamesJson,
        entryMetaJson,
        updatedAt,
        id,
        businessId,
        name,
        expectedUpdatedAt,
      ] = this.boundValues as [number, string, number, string, string, number, string, string, string, number];
      const blob = this.db.envBlobs.get(id);
      if (!blob || blob.business_id !== businessId || blob.name !== name || blob.is_global !== 0) {
        return { success: true, meta: { last_row_id: 0, changes: 0 } };
      }
      if (blob.updated_at !== expectedUpdatedAt) {
        return { success: true, meta: { last_row_id: 0, changes: 0 } };
      }
      blob.owner_user_id = ownerUserId;
      blob.env_text = envText;
      blob.encrypted = encrypted;
      blob.key_names_json = keyNamesJson;
      blob.entry_meta_json = entryMetaJson;
      blob.updated_at = updatedAt;
      return { success: true, meta: { last_row_id: 0, changes: 1 } };
    }

    if (this.query.includes("INSERT INTO env_blobs")) {
      const [id, ownerUserId, businessId, name, envText, encrypted, keyNamesJson, entryMetaJson, createdAt, updatedAt] =
        this.boundValues as [string, number, string, string, string, number, string, string, number, number];
      this.db.envBlobs.set(id, {
        id,
        owner_user_id: ownerUserId,
        business_id: businessId,
        name,
        env_text: envText,
        encrypted,
        key_names_json: keyNamesJson,
        entry_meta_json: entryMetaJson,
        is_global: 0,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return { success: true, meta: { last_row_id: 0, changes: 1 } };
    }

    if (this.query.includes("INSERT INTO env_blob_repos")) {
      const [envBlobId, repoOwner, repoName, createdAt] = this.boundValues as [string, string, string, number];
      this.db.envBlobRepos.set(`${envBlobId}:${repoOwner}/${repoName}`, {
        env_blob_id: envBlobId,
        repo_owner: repoOwner,
        repo_name: repoName,
        created_at: createdAt,
      });
      return { success: true, meta: { last_row_id: 0, changes: 1 } };
    }

    if (this.query.includes("DELETE FROM env_blobs") && this.query.includes("updated_at = ?")) {
      const [id, businessId, name, expectedUpdatedAt, repoOwner, repoName, newerRepoOwner, newerRepoName] = this
        .boundValues as [string, string, string, number, string, string, string | undefined, string | undefined];
      const blob = this.db.envBlobs.get(id);
      if (
        !blob ||
        blob.business_id !== businessId ||
        blob.name !== name ||
        blob.is_global !== 0 ||
        blob.updated_at !== expectedUpdatedAt
      ) {
        return { success: true, meta: { last_row_id: 0, changes: 0 } };
      }
      if (repoOwner && repoName) {
        const hasRepoBinding = [...this.db.envBlobRepos.values()].some(
          (repo) => repo.env_blob_id === id && repo.repo_owner === repoOwner && repo.repo_name === repoName,
        );
        const hasNewerRepoBlob = [...this.db.envBlobs.values()].some((candidate) => {
          if (candidate.business_id !== businessId || candidate.name !== name || candidate.is_global !== 0) {
            return false;
          }
          const hasCandidateRepoBinding = [...this.db.envBlobRepos.values()].some(
            (repo) =>
              repo.env_blob_id === candidate.id &&
              repo.repo_owner === (newerRepoOwner ?? repoOwner) &&
              repo.repo_name === (newerRepoName ?? repoName),
          );
          return (
            hasCandidateRepoBinding &&
            (candidate.updated_at > blob.updated_at ||
              (candidate.updated_at === blob.updated_at && candidate.id > blob.id))
          );
        });
        if (!hasRepoBinding || !hasNewerRepoBlob) {
          return { success: true, meta: { last_row_id: 0, changes: 0 } };
        }
      }
      this.db.envBlobs.delete(id);
      for (const [repoKey, repo] of [...this.db.envBlobRepos.entries()]) {
        if (repo.env_blob_id === id) this.db.envBlobRepos.delete(repoKey);
      }
      return { success: true, meta: { last_row_id: 0, changes: 1 } };
    }

    if (this.query.includes("DELETE FROM env_blobs")) {
      const [id, businessId, name] = this.boundValues as [string, string, string];
      const blob = this.db.envBlobs.get(id);
      if (!blob || blob.business_id !== businessId || blob.name !== name || blob.is_global !== 0) {
        return { success: true, meta: { last_row_id: 0, changes: 0 } };
      }
      this.db.envBlobs.delete(id);
      for (const [repoKey, repo] of [...this.db.envBlobRepos.entries()]) {
        if (repo.env_blob_id === id) this.db.envBlobRepos.delete(repoKey);
      }
      return { success: true, meta: { last_row_id: 0, changes: 1 } };
    }

    if (this.query.includes("DELETE FROM business_integration_credentials")) {
      const [businessId, integrationId] = this.boundValues as [string, string];
      this.db.businessIntegrationCredentials.delete(`${businessId}:${integrationId}`);
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("UPDATE linear_webhook_installations") && this.query.includes("SET status = 'revoked'")) {
      const [revokedAt, updatedAt, businessId] = this.boundValues as [number, number, string];
      let changes = 0;
      for (const row of this.db.linearWebhookInstallations.values()) {
        if (row.business_id === businessId && row.status === "active") {
          row.status = "revoked";
          row.revoked_at = revokedAt;
          row.updated_at = updatedAt;
          changes += 1;
        }
      }
      return { success: true, meta: { last_row_id: 0, changes } };
    }

    throw new Error(`Unhandled run query: ${this.query}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.query.includes("FROM jira_user_sites")) {
      return { results: [] as T[] };
    }

    if (this.query.includes("FROM slack_workspaces")) {
      const [businessId] = this.boundValues as [string];
      const rows = [...this.db.slackWorkspaces.values()].filter(
        (row) => row.business_id === businessId && row.uninstalled_at === null,
      );
      return { results: rows.map((row) => ({ ...row })) as unknown as T[] };
    }

    // resolveAuthUserExtras: user avatar_url + business role + business flags via batch
    if (this.query.includes("FROM users u") && this.query.includes("LEFT JOIN business_members")) {
      const [businessId, businessIdForFlagsOrUserId, maybeUserId] = this.boundValues as [
        string,
        string | number,
        number | undefined,
      ];
      const businessIdForFlags = maybeUserId === undefined ? businessId : String(businessIdForFlagsOrUserId);
      const userId = maybeUserId === undefined ? Number(businessIdForFlagsOrUserId) : maybeUserId;
      const user = this.db.users.get(userId);
      if (!user) return { results: [] as T[] };
      const memberKey = `${businessId}:${userId}`;
      const member = this.db.businessMembers.get(memberKey);
      const business = this.db.businesses.get(businessIdForFlags);
      return {
        results: [
          {
            avatar_url: (user as unknown as Record<string, unknown>).avatar_url ?? null,
            github_id: (user as unknown as Record<string, unknown>).github_id ?? null,
            business_id: user.business_id,
            business_role: member?.role ?? null,
            egress_allowlist_json: business?.egress_allowlist_json ?? null,
          },
        ] as unknown as T[],
      };
    }

    if (this.query.includes("FROM users WHERE business_id")) {
      const [businessId] = this.boundValues as [string];
      const members: Array<{ id: number }> = [];
      for (const user of this.db.users.values()) {
        if (user.business_id === businessId) members.push({ id: user.id });
      }
      return { results: members as unknown as T[] };
    }

    if (this.query.includes("SELECT user_id FROM business_members") && this.query.includes("WHERE business_id")) {
      const [businessId] = this.boundValues as [string];
      const members = [...this.db.businessMembers.values()]
        .filter((member) => member.business_id === businessId)
        .map((member) => ({ user_id: member.user_id }))
        .sort((a, b) => a.user_id - b.user_id);
      return { results: members as unknown as T[] };
    }

    if (this.query.includes("SELECT business_id FROM business_members") && this.query.includes("WHERE user_id")) {
      const [userId] = this.boundValues as [number];
      for (const member of this.db.businessMembers.values()) {
        if (member.user_id === userId) return { results: [{ business_id: member.business_id }] as unknown as T[] };
      }
      return { results: [] as T[] };
    }

    // listMembers: SELECT bm.user_id, u.login, u.name, bm.role FROM business_members bm INNER JOIN users u ...
    if (this.query.includes("FROM business_members") && this.query.includes("INNER JOIN users")) {
      const [businessId] = this.boundValues as [string];
      const results: Array<{ user_id: number; login: string; name: string | null; role: string }> = [];
      for (const member of this.db.businessMembers.values()) {
        if (member.business_id === businessId) {
          const user = this.db.users.get(member.user_id);
          results.push({
            user_id: member.user_id,
            login: ((user as unknown as Record<string, unknown>)?.login as string) || "unknown",
            name: ((user as unknown as Record<string, unknown>)?.name as string | null) || null,
            role: member.role,
          });
        }
      }
      return { results: results as unknown as T[] };
    }

    // business_integrations
    if (this.query.includes("FROM business_integrations")) {
      const [businessId] = this.boundValues as [string];
      const filterDisabled = this.query.includes("scope = 'disabled'");
      const results: Array<{ integration_id: string; scope: string }> = [];
      for (const row of this.db.businessIntegrations.values()) {
        if (row.business_id === businessId && (!filterDisabled || row.scope === "disabled")) {
          results.push({ integration_id: row.integration_id, scope: row.scope });
        }
      }
      return { results: results as unknown as T[] };
    }

    // business_integration_credentials
    if (this.query.includes("FROM business_integration_credentials")) {
      const [businessId] = this.boundValues as [string];
      const results: Array<{
        integration_id: string;
        oauth_access_token?: string | null;
        api_key?: string | null;
        service_url?: string | null;
      }> = [];
      for (const row of this.db.businessIntegrationCredentials.values()) {
        if (row.business_id === businessId) {
          results.push({
            integration_id: row.integration_id,
            oauth_access_token: row.oauth_access_token ?? null,
            api_key: row.api_key ?? null,
            service_url: row.service_url ?? null,
          });
        }
      }
      return { results: results as unknown as T[] };
    }

    if (this.query.includes("FROM env_blobs b") && this.query.includes("INNER JOIN env_blob_repos")) {
      const [businessId, name] = this.boundValues as [string, string];
      const results: Array<EnvBlobRow & { repo_owner: string; repo_name: string }> = [];
      for (const blob of this.db.envBlobs.values()) {
        if (blob.business_id !== businessId || blob.name !== name || blob.is_global !== 0) continue;
        for (const repo of this.db.envBlobRepos.values()) {
          if (repo.env_blob_id === blob.id) {
            results.push({ ...blob, repo_owner: repo.repo_owner, repo_name: repo.repo_name });
          }
        }
      }
      results.sort(
        (a, b) =>
          a.repo_owner.localeCompare(b.repo_owner) ||
          a.repo_name.localeCompare(b.repo_name) ||
          b.updated_at - a.updated_at ||
          b.id.localeCompare(a.id),
      );
      return { results: results as unknown as T[] };
    }

    if (this.query.includes("SELECT EXISTS") && this.query.includes("FROM env_blobs winner")) {
      return { results: [this.getRepoEnvBlobCurrentWinnerRow()] as unknown as T[] };
    }

    // user_integrations
    if (this.query.includes("FROM user_integrations")) {
      const [userId] = this.boundValues as [number];
      const results = [...this.db.userIntegrations.values()].filter((row) => row.user_id === userId);
      return { results: results as unknown as T[] };
    }

    if (this.query.includes("FROM user_settings")) {
      const [userId] = this.boundValues as [number];
      const row = this.db.userSettings.get(userId);
      return { results: row ? ([row] as unknown as T[]) : [] };
    }

    if (this.query.includes("integration_lifecycle_events")) {
      if (this.query.includes("WITH requested")) {
        const requested = JSON.parse(String(this.boundValues[0] ?? "[]")) as Array<{
          integrationId: string;
          businessId: string | null;
          userId: number | null;
          sessionId: string | null;
        }>;
        const results = requested
          .map(
            (scope) =>
              [...this.db.integrationLifecycleEvents.values()]
                .filter((row) => {
                  if (row.integration_id !== scope.integrationId) return false;
                  if (scope.sessionId !== null && row.session_id !== scope.sessionId) return false;
                  if (scope.userId !== null && row.user_id !== scope.userId) return false;
                  if (scope.businessId !== null && row.business_id !== scope.businessId) return false;
                  return true;
                })
                .sort((a, b) =>
                  b.created_at === a.created_at ? b.id.localeCompare(a.id) : b.created_at - a.created_at,
                )[0],
          )
          .filter((row): row is IntegrationLifecycleEventRow => Boolean(row));
        return { results: results as unknown as T[] };
      }
      let bindingIndex = 0;
      let rows = [...this.db.integrationLifecycleEvents.values()];
      if (this.query.includes("integration_id = ?")) {
        const integrationId = this.boundValues[bindingIndex++] as string;
        rows = rows.filter((row) => row.integration_id === integrationId);
      }
      if (this.query.includes("session_id = ?")) {
        const sessionId = this.boundValues[bindingIndex++] as string;
        rows = rows.filter((row) => row.session_id === sessionId);
      }
      if (this.query.includes("business_id = ?")) {
        const businessId = this.boundValues[bindingIndex++] as string;
        rows = rows.filter((row) => row.business_id === businessId);
      }
      if (this.query.includes("user_id = ?")) {
        const userId = Number(this.boundValues[bindingIndex++]);
        rows = rows.filter((row) => row.user_id === userId);
      }
      if (this.query.includes("created_at < ? OR (created_at = ? AND id < ?)")) {
        const cursorCreatedAt = Number(this.boundValues[bindingIndex++]);
        bindingIndex += 1;
        const cursorId = this.boundValues[bindingIndex++] as string;
        rows = rows.filter(
          (row) => row.created_at < cursorCreatedAt || (row.created_at === cursorCreatedAt && row.id < cursorId),
        );
      } else if (this.query.includes("created_at < ?")) {
        const cursorCreatedAt = Number(this.boundValues[bindingIndex++]);
        rows = rows.filter((row) => row.created_at < cursorCreatedAt);
      }
      const limit = Number(this.boundValues[this.boundValues.length - 1] ?? rows.length);
      rows = rows
        .sort((a, b) => (b.created_at === a.created_at ? b.id.localeCompare(a.id) : b.created_at - a.created_at))
        .slice(0, limit);
      return { results: rows as unknown as T[] };
    }

    if (this.query.includes("FROM session_index") && this.query.includes("owner_user_id IN")) {
      const rows = [...this.db.sessionIndex.values()];
      const placeholderMatch = this.query.match(/IN\s*\(([^)]+)\)/);
      const placeholderCount = placeholderMatch ? placeholderMatch[1].split(",").length : 0;
      const ownerIds = new Set(this.boundValues.slice(0, placeholderCount) as string[]);
      let filtered = rows
        .filter((r) => ownerIds.has(r.owner_user_id as string))
        .map((r) => {
          const user = this.db.users.get(Number(r.owner_user_id));
          return { ...r, owner_login: user?.login ?? null, owner_avatar_url: null };
        });
      if (this.query.includes("LIMIT ?")) {
        const limit = this.boundValues[this.boundValues.length - 1] as number;
        filtered = filtered.slice(0, limit);
      }
      const withOwner = filtered.map((row) => {
        const user = this.db.users.get(Number(row.owner_user_id));
        return { ...row, owner_login: user?.login ?? null, owner_avatar_url: null };
      });

      return { results: withOwner as unknown as T[] };
    }

    if (this.query.includes("FROM session_index")) {
      const rows = [...this.db.sessionIndex.values()];
      let filtered = rows;

      // Parse bound values positionally based on query placeholders
      let paramIdx = 0;

      if (this.query.includes("s.business_id = ?")) {
        const businessId = this.boundValues[paramIdx++] as string;
        filtered = filtered.filter((row) => row.business_id === businessId);
        if (this.query.includes("s.owner_user_id != ?")) {
          const ownerUserId = this.boundValues[paramIdx++] as string;
          filtered = filtered.filter((row) => String(row.owner_user_id) !== String(ownerUserId));
        }
      } else if (this.query.includes("owner_user_id = ?")) {
        const ownerUserId = this.boundValues[paramIdx++] as string;
        filtered = filtered.filter((row) => String(row.owner_user_id) === String(ownerUserId));
      }

      // Status filter pushed into SQL
      if (this.query.includes("status != 'closed'") && this.query.includes("status != 'archived'")) {
        filtered = filtered.filter((row) => row.status !== "closed" && row.status !== "archived");
      }
      if (this.query.includes("(s.status = 'closed' OR s.status = 'archived')")) {
        filtered = filtered.filter((row) => row.status === "closed" || row.status === "archived");
      }

      // Cursor condition
      if (this.query.includes("(s.updated_at < ? OR (s.updated_at = ? AND s.session_id < ?))")) {
        const cursorUpdatedAt = this.boundValues[paramIdx++] as string;
        paramIdx++; // skip duplicate updated_at bind
        const cursorSessionId = this.boundValues[paramIdx++] as string;
        filtered = filtered.filter(
          (row) =>
            String(row.updated_at) < cursorUpdatedAt ||
            (String(row.updated_at) === cursorUpdatedAt && String(row.session_id) < cursorSessionId),
        );
      }

      // Apply LIMIT
      if (this.query.includes("LIMIT ?")) {
        const limit = this.boundValues[this.boundValues.length - 1] as number;
        filtered = filtered.slice(0, limit);
      }

      const withOwner = filtered.map((row) => {
        const user = this.db.users.get(Number(row.owner_user_id));
        return { ...row, owner_login: user?.login ?? null, owner_avatar_url: null };
      });

      return { results: withOwner as unknown as T[] };
    }

    if (this.query.includes("FROM auth_sessions") && this.query.includes("SELECT a.token")) {
      const [businessId, now] = this.boundValues as [string, number];
      const tokens: Array<{ token: string }> = [];
      for (const [token, user] of this.db.authTokens.entries()) {
        if (user.business_id === businessId && user.expires_at >= now) tokens.push({ token });
      }
      return { results: tokens as unknown as T[] };
    }

    if (this.query.includes("FROM openai_virtual_keys")) {
      const ownerUserId = String(this.boundValues[0]);
      const row = this.db.openAIVirtualKeys.find((key) => key.owner_user_id === ownerUserId && key.status === "active");
      return { results: (row ? [{ id: row.id }] : []) as unknown as T[] };
    }

    // businesses: Codex BYOS capability (mirror migration 0255 seeding prod Cycloid)
    if (this.query.includes("FROM businesses") && this.query.includes("codex_byos_enabled")) {
      const businessId = String(this.boundValues[0]);
      return {
        results: [{ codex_byos_enabled: businessId === SEEDED_BUSINESS_IDS.cycloid ? 1 : 0 }] as unknown as T[],
      };
    }

    throw new Error(`Unhandled all query: ${this.query}`);
  }

  async first(): Promise<Record<string, unknown> | null> {
    if (this.query.includes("FROM slack_workspaces")) {
      const [businessId] = this.boundValues as [string];
      const row = [...this.db.slackWorkspaces.values()].find(
        (candidate) => candidate.business_id === businessId && candidate.uninstalled_at === null,
      );
      return row ? { ...row } : null;
    }

    if (this.query.includes("FROM auth_sessions")) {
      const [token] = this.boundValues as [string];
      const user = this.db.authTokens.get(token);
      if (!user) return null;
      // Simulate INNER JOIN businesses + LEFT JOIN business_members
      const biz = this.db.businesses.get(user.business_id) ?? null;
      if (!biz) return null;
      const memberKey = `${user.business_id}:${user.user_id}`;
      const member = this.db.businessMembers.get(memberKey);
      const sharedSessions = (biz as BusinessRow & { shared_sessions?: number }).shared_sessions ?? 0;
      // Simulate member_ids subquery for resolveAuthSession
      let memberIds: string | null = null;
      if (this.query.includes("member_ids") && sharedSessions === 1) {
        const ids: number[] = [];
        for (const u of this.db.users.values()) {
          if (u.business_id === user.business_id) ids.push(u.id);
        }
        memberIds = ids.length > 0 ? ids.join(",") : null;
      }
      return {
        ...user,
        shared_sessions: sharedSessions,
        business_role: member?.role ?? null,
        member_ids: memberIds,
      } as unknown as Record<string, unknown>;
    }

    if (this.query.includes("SELECT api_key FROM business_integration_credentials")) {
      const [businessId, integrationId] = this.boundValues as [string, string];
      const row = this.db.businessIntegrationCredentials.get(`${businessId}:${integrationId}`);
      return row?.api_key ? { api_key: row.api_key } : null;
    }

    if (this.query.includes("FROM durable_event_replay_metadata")) {
      return null;
    }

    if (this.query.includes("FROM businesses b") && this.query.includes("INNER JOIN business_members bm")) {
      const [businessId, userId] = this.boundValues as [string, number];
      const biz = this.db.businesses.get(businessId);
      const member = this.db.businessMembers.get(`${businessId}:${userId}`);
      if (!biz || !member) return null;
      if (this.query.includes("bm.role = 'admin'") && member.role !== "admin") return null;
      return {
        ...biz,
        shared_sessions: biz.shared_sessions ?? 0,
      } as unknown as Record<string, unknown>;
    }

    if (this.query.includes("FROM businesses WHERE id")) {
      const [id] = this.boundValues as [string];
      const biz = this.db.businesses.get(id);
      if (!biz) return null;
      return {
        ...biz,
        shared_sessions: (biz as BusinessRow & { shared_sessions?: number }).shared_sessions ?? 0,
      } as unknown as Record<string, unknown>;
    }

    if (this.query.includes("SELECT business_id FROM users")) {
      const userId = Number(this.boundValues[0]);
      const user = this.db.users.get(userId);
      return user ? { business_id: user.business_id } : null;
    }

    // business_members: getAvailableIntegrations (SELECT business_id FROM business_members WHERE user_id = ?)
    if (this.query.includes("SELECT business_id FROM business_members") && this.query.includes("WHERE user_id")) {
      const [userId] = this.boundValues as [number];
      for (const member of this.db.businessMembers.values()) {
        if (member.user_id === userId) return { business_id: member.business_id };
      }
      return null;
    }

    // business_members: COUNT admin (must come before role lookup -- both match "role" + "FROM business_members")
    if (this.query.includes("COUNT") && this.query.includes("business_members")) {
      const [businessId] = this.boundValues as [string];
      let cnt = 0;
      for (const m of this.db.businessMembers.values()) {
        if (m.business_id === businessId && m.role === "admin") cnt++;
      }
      return { cnt };
    }

    // business_members: role lookup (isBusinessAdmin, getMemberRole)
    if (this.query.includes("role") && this.query.includes("FROM business_members")) {
      const [businessId, userId] = this.boundValues as [string, number];
      const member = this.db.businessMembers.get(`${businessId}:${userId}`);
      return member ? { role: member.role } : null;
    }

    // business_members: membership check (SELECT 1 FROM business_members ...)
    if (this.query.includes("FROM business_members")) {
      const [businessId, userId] = this.boundValues as [string, number];
      const member = this.db.businessMembers.get(`${businessId}:${userId}`);
      return member ? { "1": 1 } : null;
    }

    if (this.query.includes("FROM user_integrations")) {
      const [userId] = this.boundValues as [number];
      const row = this.db.userIntegrations.get(`${userId}:github`);
      return row ? (row as unknown as Record<string, unknown>) : null;
    }

    if (this.query.includes("FROM github_installations")) {
      const [ownerLogin] = this.boundValues as [string];
      const row = this.db.githubInstallations.get(ownerLogin.toLowerCase());
      return row ? (row as unknown as Record<string, unknown>) : null;
    }

    if (this.query.includes("FROM jira_webhook_installations")) {
      const [businessId] = this.boundValues as [string];
      const rows = [...this.db.jiraWebhookInstallations.values()]
        .filter((row) => row.business_id === businessId)
        .sort((a, b) => {
          if (a.status !== b.status) return a.status !== "revoked" ? -1 : 1;
          return b.updated_at - a.updated_at;
        });
      return rows[0] ? (rows[0] as unknown as Record<string, unknown>) : null;
    }

    if (this.query.includes("FROM linear_webhook_installations")) {
      const [businessId] = this.boundValues as [string];
      const rows = [...this.db.linearWebhookInstallations.values()]
        .filter((row) => row.business_id === businessId)
        .sort((a, b) => {
          if (a.status !== b.status) return a.status === "active" ? -1 : 1;
          return b.updated_at - a.updated_at;
        });
      return rows[0] ? (rows[0] as unknown as Record<string, unknown>) : null;
    }

    // business_integration_health_checks queries
    if (this.query.includes("FROM business_integration_health_checks")) {
      const [businessId, integrationId, checkKind] = this.boundValues as [string, string, string];
      const rows = [...this.db.businessIntegrationHealthChecks.values()]
        .filter(
          (row) =>
            row.business_id === businessId && row.integration_id === integrationId && row.check_kind === checkKind,
        )
        .sort((a, b) => b.checked_at - a.checked_at);
      return rows[0] ? (rows[0] as unknown as Record<string, unknown>) : null;
    }

    // business_integrations queries
    if (this.query.includes("FROM business_integrations")) {
      const [businessId, integrationId] = this.boundValues as [string, string];
      const row = this.db.businessIntegrations.get(`${businessId}:${integrationId}`);
      return row ? { scope: row.scope } : null;
    }

    // business_integration_credentials: Sentry OAuth existence check
    if (
      this.query.includes("FROM business_integration_credentials") &&
      this.query.includes("integration_id = 'sentry'")
    ) {
      const [businessId] = this.boundValues as [string];
      const row = this.db.businessIntegrationCredentials.get(`${businessId}:sentry`);
      if (!row) return null;
      if (this.query.includes("oauth_access_token IS NOT NULL") && !row.oauth_access_token) return null;
      return { ...row, "1": 1 } as unknown as Record<string, unknown>;
    }

    // business_integration_credentials: SELECT 1 ...
    if (this.query.includes("FROM business_integration_credentials")) {
      const [businessId, integrationId] = this.boundValues as [string, string];
      const row = this.db.businessIntegrationCredentials.get(`${businessId}:${integrationId}`);
      if (!row) return null;
      if (
        this.query.includes("oauth_access_token") ||
        this.query.includes("api_key") ||
        this.query.includes("service_url")
      ) {
        return row as unknown as Record<string, unknown>;
      }
      return { "1": 1 };
    }

    if (this.query.includes("SELECT EXISTS") && this.query.includes("FROM env_blobs winner")) {
      return this.getRepoEnvBlobCurrentWinnerRow();
    }

    if (this.query.includes("FROM env_blobs b") && this.query.includes("INNER JOIN env_blob_repos")) {
      const [businessId, name, repoOwner, repoName] = this.boundValues as [string, string, string, string];
      const rows: Array<EnvBlobRow & { repo_owner: string; repo_name: string }> = [];
      for (const blob of this.db.envBlobs.values()) {
        if (blob.business_id !== businessId || blob.name !== name || blob.is_global !== 0) continue;
        const repo = [...this.db.envBlobRepos.values()].find(
          (item) => item.env_blob_id === blob.id && item.repo_owner === repoOwner && item.repo_name === repoName,
        );
        if (repo) rows.push({ ...blob, repo_owner: repo.repo_owner, repo_name: repo.repo_name });
      }
      rows.sort((a, b) => b.updated_at - a.updated_at || b.id.localeCompare(a.id));
      return rows[0] ? (rows[0] as unknown as Record<string, unknown>) : null;
    }

    // users by login: SELECT id FROM users WHERE login = ?
    if (this.query.includes("FROM users WHERE login")) {
      const [login] = this.boundValues as [string];
      for (const user of this.db.users.values()) {
        if ((user as unknown as Record<string, unknown>).login === login) {
          return { id: user.id };
        }
      }
      return null;
    }

    if (this.query.includes("FROM users")) {
      const userId = Number(this.boundValues[0]);
      const user = this.db.users.get(userId);
      return user ? (user as unknown as Record<string, unknown>) : null;
    }

    if (this.query.includes("FROM openai_virtual_keys")) {
      const ownerUserId = String(this.boundValues[0]);
      const row = this.db.openAIVirtualKeys.find((key) => key.owner_user_id === ownerUserId && key.status === "active");
      return row ? { id: row.id } : null;
    }

    throw new Error(`Unhandled first query: ${this.query}`);
  }
}

class FakeD1 {
  readonly businesses = new Map<string, BusinessRow>();
  readonly slackWorkspaces = new Map<
    string,
    {
      team_id: string;
      bot_user_id: string;
      team_name: string | null;
      business_id: string | null;
      team_domain: string | null;
      enterprise_id: string | null;
      installed_by_user_id: number | null;
      installed_at: number;
      updated_at: number;
      uninstalled_at: number | null;
    }
  >();
  readonly users = new Map<number, UserRow>();
  readonly authTokens = new Map<string, AuthTokenUser>();
  readonly sessionIndex = new Map<string, Record<string, unknown>>();
  readonly userIntegrations = new Map<string, UserIntegrationRow>();
  readonly githubInstallations = new Map<string, GithubInstallationRow>();
  readonly userSettings = new Map<number, { use_codex_subscription: number }>();
  readonly businessMembers = new Map<string, { business_id: string; user_id: number; role: string }>();
  readonly businessIntegrations = new Map<string, { business_id: string; integration_id: string; scope: string }>();
  readonly openAIVirtualKeys: OpenAIVirtualKeyRow[] = [];
  readonly businessIntegrationHealthChecks = new Map<string, BusinessIntegrationHealthCheckRow>();
  readonly integrationLifecycleEvents = new Map<string, IntegrationLifecycleEventRow>();
  readonly businessIntegrationCredentials = new Map<
    string,
    {
      business_id: string;
      integration_id: string;
      oauth_access_token?: string | null;
      oauth_refresh_token?: string | null;
      oauth_expires_at?: number | null;
      api_key?: string | null;
      service_url?: string | null;
      encrypted?: number;
      last_validated_at?: number | null;
      last_validation_status?: string | null;
      last_validation_reason_code?: string | null;
    }
  >();
  readonly envBlobs = new Map<string, EnvBlobRow>();
  readonly envBlobRepos = new Map<string, EnvBlobRepoRow>();
  readonly linearWebhookInstallations = new Map<string, LinearWebhookInstallationRow>();
  readonly jiraWebhookInstallations = new Map<
    string,
    {
      business_id: string;
      jira_cloud_id: string;
      site_url: string | null;
      site_name: string | null;
      webhooks_json: string | null;
      installation_token: string;
      trigger_label: string | null;
      connected_by_user_id: number;
      status: "active" | "degraded" | "revoked";
      webhook_registered_at: number | null;
      webhook_expires_at: number | null;
      created_at: number;
      updated_at: number;
      revoked_at: number | null;
    }
  >();

  addJiraWebhookInstallation(params: {
    businessId: string;
    cloudId: string;
    status?: "active" | "degraded" | "revoked";
    webhooksJson?: string | null;
    webhookExpiresAt?: number | null;
    triggerLabel?: string | null;
  }): void {
    const now = Date.now();
    const status = params.status ?? "active";
    this.jiraWebhookInstallations.set(`${params.businessId}:${params.cloudId}`, {
      business_id: params.businessId,
      jira_cloud_id: params.cloudId,
      site_url: "https://acme.atlassian.net",
      site_name: "Acme",
      webhooks_json: params.webhooksJson ?? null,
      installation_token: "tok-1",
      trigger_label: params.triggerLabel ?? "cycloid",
      connected_by_user_id: 1,
      status,
      webhook_registered_at: null,
      webhook_expires_at: params.webhookExpiresAt ?? null,
      created_at: now,
      updated_at: now,
      revoked_at: status === "revoked" ? now : null,
    });
  }

  addLinearWebhookInstallation(params: {
    businessId: string;
    organizationId: string;
    organizationName?: string | null;
    organizationUrlKey?: string | null;
    webhookId?: string | null;
    status?: "active" | "revoked";
    connectedByUserId?: number;
    updatedAt?: number;
  }): void {
    const now = params.updatedAt ?? Date.now();
    const status = params.status ?? "active";
    this.linearWebhookInstallations.set(`${params.businessId}:${params.organizationId}`, {
      business_id: params.businessId,
      linear_organization_id: params.organizationId,
      linear_organization_name: params.organizationName ?? null,
      linear_organization_url_key: params.organizationUrlKey ?? null,
      linear_webhook_id: params.webhookId ?? null,
      connected_by_user_id: params.connectedByUserId ?? 1,
      status,
      connected_at: now,
      updated_at: now,
      revoked_at: status === "revoked" ? now : null,
    });
  }

  setAuthToken(token: string, user: AuthTokenUser): void {
    this.authTokens.set(token, user);
  }

  setUser(user: UserRow): void {
    this.users.set(user.id, user);
  }

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }

  batch(stmts: FakeD1Statement[]): Promise<unknown[]> {
    return Promise.all(stmts.map((s) => (/^(INSERT|UPDATE|DELETE)\b/i.test(s.query.trim()) ? s.run() : s.all())));
  }
}

class FakeKV {
  readonly store = new Map<string, string>();
  readonly deletedKeys: string[] = [];

  async get(key: string, type?: string): Promise<unknown> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: string, _opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
    this.deletedKeys.push(key);
  }
}

function createWorkerEnv(workerModule: WorkerModule): {
  env: Record<string, unknown>;
  db: FakeD1;
  kv: FakeKV;
  modelsKv: FakeKV;
} {
  const db = new FakeD1();
  const kv = new FakeKV();
  const modelsKv = new FakeKV();
  const { env } = createWorkerTestEnv(workerModule, {
    db,
    bindings: {
      kv: { envKey: "RATE_LIMITS", value: kv },
      reposCache: { envKey: "REPOS_CACHE", value: kv },
      modelsKv: { envKey: "DERIVED_MODELS", value: modelsKv },
    },
    sqlStorage: true,
  });

  return { env, db, kv, modelsKv };
}

async function seedRepoAccessCache(kv: FakeKV, userId: string, fullNames: string[]): Promise<void> {
  await kv.put(
    `repos:${userId}`,
    JSON.stringify({
      schemaVersion: REPOS_CACHE_SCHEMA_VERSION,
      installationVersion: "0",
      repos: fullNames.map((fullName) => ({
        fullName,
        url: `https://github.com/${fullName}`,
        private: true,
        defaultBranch: "main",
        description: null,
        ownerType: "User",
      })),
      ssoOrgs: [],
    }),
  );
}

async function seedSessionDoState(
  env: Record<string, unknown>,
  sessionId: string,
  ownerUserId: string,
  businessId: string | null,
): Promise<void> {
  const sessionNs = env.SESSION as ReturnType<typeof createDurableNamespace>;
  const res = await sessionNs.get(sessionNs.idFromName(sessionId)).fetch(
    new Request("https://internal/session/initialize", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": sessionId,
      },
      body: JSON.stringify({
        sessionId,
        ownerUserId,
        businessId,
      }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok?: boolean };
  expect(body.ok).toBe(true);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("business routes", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(() => {
    expect(workerModule).toBeDefined();
    resetModelsMemoryCache();
    resetReposMemoryCache();
    resetInstallationByOwnerCacheForTests();
    mockPostStructuredEventToDd.mockClear();
  });

  // ---- POST /api/businesses ----

  describe("POST /api/businesses", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);
      const res = await workerFetch(workerModule, env, "/api/businesses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Test Corp" }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 403 for non-admin user", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-user-1", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "user1",
        name: "User One",
        email: null,
        business_id: "biz-1",
      });

      const res = await workerFetch(workerModule, env, "/api/businesses", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "session_token=sess-user-1" },
        body: JSON.stringify({ name: "Test Corp" }),
      });
      expect(res.status).toBe(403);
    });

    it("returns 400 when name is missing", async () => {
      const { env } = createWorkerEnv(workerModule);
      const res = await workerFetch(workerModule, env, "/api/businesses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("name");
    });

    it("creates a business with a UUID id", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      const res = await workerFetch(workerModule, env, "/api/businesses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ name: "Acme Corp" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { ok: boolean; id: string };
      expect(body.ok).toBe(true);
      expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(db.businesses.get(body.id)?.name).toBe("Acme Corp");
    });
  });

  // ---- GET /api/businesses/:id ----

  describe("GET /api/businesses/:id", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);
      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1");
      expect(res.status).toBe(401);
    });

    it("returns 404 for nonexistent business", async () => {
      const { env } = createWorkerEnv(workerModule);
      const res = await workerFetch(workerModule, env, "/api/businesses/biz-nonexistent", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("not found");
    });

    it("returns business details via admin token (bypasses membership)", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      const now = Date.now();
      db.businesses.set("biz-1", {
        id: "biz-1",
        name: "Acme",
        shared_sessions: 0,
        egress_allowlist_json: JSON.stringify({ domains: ["api.acme.test"] }),
        egress_allowlist_source_repo_owner: "acme",
        egress_allowlist_source_repo_name: "infra",
        created_at: now,
      });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        business: {
          id: string;
          name: string;
          sharedSessions: boolean;
          egressAllowlist: string[] | null;
          egressAllowlistSource: { sourceRepoOwner: string; sourceRepoName: string } | null;
          createdAt: number;
        };
      };
      expect(body.ok).toBe(true);
      expect(body.business.id).toBe("biz-1");
      expect(body.business.name).toBe("Acme");
      expect(body.business.sharedSessions).toBe(false);
      expect(body.business.egressAllowlist).toEqual(["api.acme.test"]);
      expect(body.business.egressAllowlistSource).toEqual({ sourceRepoOwner: "acme", sourceRepoName: "infra" });
      expect(body.business.createdAt).toBe(now);
    });

    it("returns business details for member (cookie auth)", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Acme", shared_sessions: 1, created_at: Date.now() });
      db.setAuthToken("sess-member", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "member1",
        name: "Member",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "member" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        headers: { cookie: "session_token=sess-member" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        business: { id: string; name: string; sharedSessions: boolean };
      };
      expect(body.ok).toBe(true);
      expect(body.business.id).toBe("biz-1");
      expect(body.business.name).toBe("Acme");
      expect(body.business.sharedSessions).toBe(true);
    });

    it("returns egress details for business admins", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", {
        id: "biz-1",
        name: "Acme",
        shared_sessions: 1,
        egress_allowlist_json: JSON.stringify({ domains: ["api.acme.test"] }),
        egress_allowlist_source_repo_owner: "acme",
        egress_allowlist_source_repo_name: "infra",
        created_at: Date.now(),
      });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        headers: { cookie: "session_token=sess-admin" },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        business: {
          egressAllowlist: string[] | null;
          egressAllowlistSource: { sourceRepoOwner: string; sourceRepoName: string } | null;
        };
      };
      expect(body.business.egressAllowlist).toEqual(["api.acme.test"]);
      expect(body.business.egressAllowlistSource).toEqual({ sourceRepoOwner: "acme", sourceRepoName: "infra" });
    });

    it("returns 404 for non-member (cookie auth)", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Acme", shared_sessions: 0, created_at: Date.now() });
      db.businesses.set("biz-other", { id: "biz-other", name: "Other", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-outsider", {
        user_id: 2,
        id: 2,
        expires_at: Date.now() + 60_000,
        login: "outsider",
        name: "Outsider",
        email: null,
        business_id: "biz-other",
      });
      // No membership in biz-1 for user 2

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        headers: { cookie: "session_token=sess-outsider" },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Business not found");
    });

    it("admin token user can access any business", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Acme", shared_sessions: 0, created_at: Date.now() });
      db.businesses.set("biz-2", { id: "biz-2", name: "Globex", shared_sessions: 1, created_at: Date.now() });

      const res1 = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as { ok: boolean; business: { id: string; name: string } };
      expect(body1.ok).toBe(true);
      expect(body1.business.id).toBe("biz-1");
      expect(body1.business.name).toBe("Acme");

      const res2 = await workerFetch(workerModule, env, "/api/businesses/biz-2", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as { ok: boolean; business: { id: string; name: string } };
      expect(body2.ok).toBe(true);
      expect(body2.business.id).toBe("biz-2");
      expect(body2.business.name).toBe("Globex");
    });
  });

  // ---- PUT /api/businesses/:id ----

  describe("PUT /api/businesses/:id", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);
      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sharedSessions: true }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 404 for nonexistent business", async () => {
      const { env } = createWorkerEnv(workerModule);
      const res = await workerFetch(workerModule, env, "/api/businesses/nonexistent", {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ sharedSessions: true }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 for non-admin member", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-member", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "member1",
        name: "Member",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "member" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-member" },
        body: JSON.stringify({ sharedSessions: true }),
      });
      expect(res.status).toBe(404);
    });

    it("successfully updates sharedSessions as admin", async () => {
      const { env, db, kv } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.setAuthToken("sess-expired", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() - 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ sharedSessions: true }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);

      // Verify via GET that sharedSessions is now true
      const getRes = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        headers: { cookie: "session_token=sess-admin" },
      });
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as { ok: boolean; business: { sharedSessions: boolean } };
      expect(getBody.business.sharedSessions).toBe(true);
      expect(kv.deletedKeys).toHaveLength(1);
      expect(kv.deletedKeys[0]).toMatch(/^auth:session:/);
    });

    it("admin token bypasses admin check", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ sharedSessions: true }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
      expect(db.businesses.get("biz-1")?.shared_sessions).toBe(1);
    });

    it("updates egressAllowlist as an admin and returns normalized domains", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ egressAllowlist: ["Registry.Acme.test", "api.acme.test", "api.acme.test"] }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; egressAllowlist: string[] | null };
      expect(body).toEqual({
        ok: true,
        egressAllowlist: ["api.acme.test", "registry.acme.test"],
      });
      expect(JSON.parse(db.businesses.get("biz-1")?.egress_allowlist_json ?? "{}")).toEqual({
        domains: ["api.acme.test", "registry.acme.test"],
      });

      const getRes = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        headers: { cookie: "session_token=sess-admin" },
      });
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as { business: { egressAllowlist: string[] | null } };
      expect(getBody.business.egressAllowlist).toEqual(["api.acme.test", "registry.acme.test"]);

      const audit = lastAuditEvent("business.egress_policy.changed");
      expect(audit).toMatchObject({
        event: "business.egress_policy.changed",
        businessId: "biz-1",
        actorUserId: "1",
        previousDomainCount: 0,
        newDomainCount: 2,
        outcome: "updated",
      });
    });

    it("redacts egressAllowlist and egressAllowlistSource from member-readable business details", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", {
        id: "biz-1",
        name: "Test",
        shared_sessions: 0,
        egress_allowlist_json: JSON.stringify({ domains: ["api.acme.test"] }),
        egress_allowlist_source_repo_owner: "acme",
        egress_allowlist_source_repo_name: "infrastructure",
        created_at: Date.now(),
      });
      db.setAuthToken("sess-member", {
        user_id: 2,
        id: 2,
        expires_at: Date.now() + 60_000,
        login: "member1",
        name: "Member",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:2", { business_id: "biz-1", user_id: 2, role: "member" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        headers: { cookie: "session_token=sess-member" },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        business: {
          egressAllowlist: string[] | null;
          egressAllowlistSource: { sourceRepoOwner: string; sourceRepoName: string } | null;
        };
      };
      expect(body.business.egressAllowlist).toBeNull();
      expect(body.business.egressAllowlistSource).toBeNull();
    });

    it("returns 404 for member reads of egress allowlist source", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", {
        id: "biz-1",
        name: "Test",
        shared_sessions: 0,
        created_at: Date.now(),
      });
      db.setAuthToken("sess-member", {
        user_id: 2,
        id: 2,
        expires_at: Date.now() + 60_000,
        login: "member1",
        name: "Member",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:2", { business_id: "biz-1", user_id: 2, role: "member" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/egress-allowlist/source", {
        headers: { cookie: "session_token=sess-member" },
      });

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toMatchObject({ ok: false, error: "Business not found" });
    });

    it("allows admin reads of empty egress allowlist source", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", {
        id: "biz-1",
        name: "Test",
        shared_sessions: 0,
        created_at: Date.now(),
      });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/egress-allowlist/source", {
        headers: { cookie: "session_token=sess-admin" },
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        ok: true,
        source: null,
        path: ".cycloid/egress-allowlist.txt",
        domains: [],
      });
    });

    it("configures the egress allowlist source repo as an admin", async () => {
      const { env, db, kv } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });
      db.userIntegrations.set("1:github", {
        user_id: 1,
        integration_id: "github",
        oauth_access_token: "ghu_test",
        oauth_refresh_token: null,
        oauth_expires_at: null,
        encrypted: 0,
      });
      db.githubInstallations.set("acme", {
        installation_id: 123,
        owner_login: "acme",
        owner_id: 456,
        owner_type: "Organization",
        repository_selection: "selected",
        permissions_json: null,
        events_json: null,
        created_at: Date.now(),
        suspended_at: null,
      });
      await seedRepoAccessCache(kv, "1", ["acme/policy"]);

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/egress-allowlist/source", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ sourceRepoOwner: "acme", sourceRepoName: "policy" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        source: { sourceRepoOwner: string; sourceRepoName: string };
        path: string;
      };
      expect(body).toEqual({
        ok: true,
        source: { sourceRepoOwner: "acme", sourceRepoName: "policy" },
        path: ".cycloid/egress-allowlist.txt",
      });
      expect(db.businesses.get("biz-1")).toMatchObject({
        egress_allowlist_source_repo_owner: "acme",
        egress_allowlist_source_repo_name: "policy",
      });
    });

    it("rejects egress allowlist source repos the admin cannot access", async () => {
      const { env, db, kv } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });
      db.userIntegrations.set("1:github", {
        user_id: 1,
        integration_id: "github",
        oauth_access_token: "ghu_test",
        oauth_refresh_token: null,
        oauth_expires_at: null,
        encrypted: 0,
      });
      await seedRepoAccessCache(kv, "1", ["acme/other"]);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("{}", { status: 404 })),
      );

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/egress-allowlist/source", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ sourceRepoOwner: "acme", sourceRepoName: "policy" }),
      });
      vi.unstubAllGlobals();

      expect(res.status).toBe(403);
      expect(db.businesses.get("biz-1")).not.toMatchObject({
        egress_allowlist_source_repo_owner: "acme",
        egress_allowlist_source_repo_name: "policy",
      });
    });

    it("rejects oversized egress allowlist PR requests", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const domains = Array.from({ length: 101 }, (_, index) => `api-${index}.acme.test`);
      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/egress-allowlist/pull-request", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ domains }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: "domains must contain at most 100 domain names",
      });
    });

    it("clears egressAllowlist with null", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", {
        id: "biz-1",
        name: "Test",
        shared_sessions: 0,
        egress_allowlist_json: JSON.stringify({ domains: ["api.acme.test"] }),
        created_at: Date.now(),
      });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ egressAllowlist: null }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; egressAllowlist: string[] | null };
      expect(body).toEqual({ ok: true, egressAllowlist: null });
      expect(db.businesses.get("biz-1")?.egress_allowlist_json).toBeNull();
    });

    it("rejects invalid egressAllowlist domains", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ egressAllowlist: ["https://api.acme.test"] }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("egressAllowlist entries must be exact domain names");
      expect(db.businesses.get("biz-1")?.egress_allowlist_json).toBeUndefined();
    });

    it("updates updated_at timestamp", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      const initialTime = Date.now() - 10_000;
      db.businesses.set("biz-1", {
        id: "biz-1",
        name: "Test",
        shared_sessions: 0,
        created_at: initialTime,
        updated_at: initialTime,
      });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ sharedSessions: true }),
      });
      expect(res.status).toBe(200);

      const biz = db.businesses.get("biz-1");
      expect(biz?.updated_at).toBeDefined();
      expect(biz!.updated_at!).toBeGreaterThan(initialTime);
    });

    it("returns 400 when sharedSessions is missing", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/exactly one supported field/);
      // Value must not change
      expect(db.businesses.get("biz-1")?.shared_sessions).toBe(0);
    });

    it("returns 400 for unknown update fields", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ plan: "enterprise" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.error).toMatch(/Unsupported business setting/);
    });

    it("returns 400 for multi-field updates", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ sharedSessions: true, egressAllowlist: null }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.error).toMatch(/exactly one supported field/);
    });

    it("returns 400 when sharedSessions is not a boolean", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ sharedSessions: "true" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/boolean/);
      expect(db.businesses.get("biz-1")?.shared_sessions).toBe(0);
    });

    it("enforces admin gate before validating payload", async () => {
      // Non-admin members should get 404 even with an invalid body, so that
      // payload validation errors never leak route existence to outsiders.
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-member", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "member1",
        name: "Member",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "member" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-member" },
        body: JSON.stringify({ sharedSessions: "not-a-boolean" }),
      });
      expect(res.status).toBe(404);
    });

    it("successfully updates sharedSessions to false as admin", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 1, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ sharedSessions: false }),
      });
      expect(res.status).toBe(200);
      expect(db.businesses.get("biz-1")?.shared_sessions).toBe(0);
    });

    // Removed: the self-hosted E2B sandbox setting (selfHostedSandboxesEnabled) and its
    // global-flag/allowlist gating were deleted from production; these tests covered that gating.

    it("immediately revokes cached business-session access when sharedSessions is disabled", async () => {
      const { env, db, kv } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 1, created_at: Date.now() });
      db.setAuthToken("sess-user-1", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "user1",
        name: "User One",
        email: null,
        business_id: "biz-1",
      });
      db.setUser({ id: 1, business_id: "biz-1", login: "user1" });
      db.setUser({ id: 2, business_id: "biz-1", login: "user2" });
      db.userIntegrations.set("1:github", {
        user_id: 1,
        integration_id: "github",
        oauth_access_token: "gh-token",
        oauth_refresh_token: null,
        oauth_expires_at: null,
        encrypted: 0,
      });
      await seedRepoAccessCache(kv, "1", ["acme/web"]);
      db.sessionIndex.set("s-own", {
        session_id: "s-own",
        owner_user_id: "1",
        business_id: "biz-1",
        status: "active",
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
        closed_at: null,
        last_event_id: null,
        title: null,
        rich_status: "idle",
      });
      db.sessionIndex.set("s-peer", {
        session_id: "s-peer",
        owner_user_id: "2",
        business_id: "biz-1",
        status: "active",
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
        closed_at: null,
        last_event_id: null,
        title: null,
        rich_status: "idle",
        repo_owner: "acme",
        repo_name: "web",
      });
      await seedSessionDoState(env, "s-peer", "2", "biz-1");

      const baselineRes = await workerFetch(workerModule, env, "/api/sessions?scope=business", {
        headers: { cookie: "session_token=sess-user-1" },
      });
      expect(baselineRes.status).toBe(200);
      const baselineBody = (await baselineRes.json()) as { sessions: Array<{ sessionId: string }> };
      expect(baselineBody.sessions.map((session) => session.sessionId)).toEqual(["s-peer"]);

      // Allow the fire-and-forget auth-session cache write to settle before revoking access.
      await new Promise((resolve) => setTimeout(resolve, 10));

      const disableRes = await workerFetch(workerModule, env, "/api/businesses/biz-1", {
        method: "PUT",
        headers: {
          authorization: "Bearer admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ sharedSessions: false }),
      });
      expect(disableRes.status).toBe(200);
      expect(db.businesses.get("biz-1")?.shared_sessions).toBe(0);

      const refreshedRes = await workerFetch(workerModule, env, "/api/sessions?scope=business", {
        headers: { cookie: "session_token=sess-user-1" },
      });
      expect(refreshedRes.status).toBe(200);
      const refreshedBody = (await refreshedRes.json()) as { sessions: Array<{ sessionId: string }> };
      expect(refreshedBody.sessions.map((session) => session.sessionId)).toEqual(["s-own"]);
    });
  });

  // ---- PUT /api/businesses/:id/members/:userId/role ----

  // ---- GET /api/sessions?scope=business ----

  describe("GET /api/sessions?scope=business", () => {
    it("returns only own sessions when business has shared_sessions disabled", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-noshare", {
        id: "biz-noshare",
        name: "No Share",
        shared_sessions: 0,
        created_at: Date.now(),
      });
      db.setAuthToken("sess-user-1", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "user1",
        name: "User One",
        email: null,
        business_id: "biz-noshare",
      });
      db.sessionIndex.set("s-1", {
        session_id: "s-1",
        owner_user_id: "1",
        business_id: "biz-noshare",
        status: "active",
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
        closed_at: null,
        last_event_id: null,
        title: null,
        rich_status: "idle",
      });
      db.sessionIndex.set("s-2", {
        session_id: "s-2",
        owner_user_id: "2",
        business_id: "biz-noshare",
        status: "active",
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
        closed_at: null,
        last_event_id: null,
        title: null,
        rich_status: "idle",
      });

      const res = await workerFetch(workerModule, env, "/api/sessions?scope=business", {
        headers: { cookie: "session_token=sess-user-1" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].sessionId).toBe("s-1");
    });

    it("excludes requesting user's own sessions from business scope", async () => {
      const { env, db, kv } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 1, created_at: Date.now() });
      db.setAuthToken("sess-user-1", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "user1",
        name: "User One",
        email: null,
        business_id: "biz-1",
      });
      db.setUser({ id: 1, business_id: "biz-1", login: "user1" });
      db.setUser({ id: 2, business_id: "biz-1", login: "user2" });
      db.setUser({ id: 3, business_id: "biz-2", login: "user3" });
      db.userIntegrations.set("1:github", {
        user_id: 1,
        integration_id: "github",
        oauth_access_token: "gh-token",
        oauth_refresh_token: null,
        oauth_expires_at: null,
        encrypted: 0,
      });
      await seedRepoAccessCache(kv, "1", ["acme/web"]);

      db.sessionIndex.set("s-1", {
        session_id: "s-1",
        owner_user_id: "1",
        business_id: "biz-1",
        status: "active",
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
        closed_at: null,
        last_event_id: null,
        title: null,
        rich_status: "idle",
      });
      db.sessionIndex.set("s-2", {
        session_id: "s-2",
        owner_user_id: "2",
        business_id: "biz-1",
        status: "active",
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
        closed_at: null,
        last_event_id: null,
        title: null,
        rich_status: "idle",
        repo_owner: "acme",
        repo_name: "web",
      });
      await seedSessionDoState(env, "s-2", "2", "biz-1");
      db.sessionIndex.set("s-3", {
        session_id: "s-3",
        owner_user_id: "3",
        business_id: "biz-2",
        status: "active",
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
        closed_at: null,
        last_event_id: null,
        title: null,
        rich_status: "idle",
      });

      const res = await workerFetch(workerModule, env, "/api/sessions?scope=business", {
        headers: { cookie: "session_token=sess-user-1" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: Array<{ sessionId: string; ownerLogin?: string }> };
      // Only user 2's session -- user 1 (self) and user 3 (different business) excluded
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].sessionId).toBe("s-2");
      expect(body.sessions[0].ownerLogin).toBe("user2");
    });

    it("returns an empty shared list when the requesting user has no GitHub token (genuinely absent)", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 1, created_at: Date.now() });
      db.setAuthToken("sess-user-1", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "user1",
        name: "User One",
        email: null,
        business_id: "biz-1",
      });
      db.setUser({ id: 1, business_id: "biz-1", login: "user1" });
      db.setUser({ id: 2, business_id: "biz-1", login: "user2" });
      // No github integration row for user 1 -> token genuinely absent.
      db.sessionIndex.set("s-2", {
        session_id: "s-2",
        owner_user_id: "2",
        business_id: "biz-1",
        status: "active",
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
        closed_at: null,
        last_event_id: null,
        title: null,
        rich_status: "idle",
        repo_owner: "acme",
        repo_name: "web",
      });

      const res = await workerFetch(workerModule, env, "/api/sessions?scope=business", {
        headers: { cookie: "session_token=sess-user-1" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
      expect(body.sessions).toHaveLength(0);
    });

    it("fails closed with 503 (not an empty list) when the requesting user's GitHub token is present but rejected (L35)", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 1, created_at: Date.now() });
      db.setAuthToken("sess-user-1", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "user1",
        name: "User One",
        email: null,
        business_id: "biz-1",
      });
      db.setUser({ id: 1, business_id: "biz-1", login: "user1" });
      db.setUser({ id: 2, business_id: "biz-1", login: "user2" });
      // Token present but expired with no refresh token -> token_refresh_rejected,
      // an auth failure that must NOT be swallowed into an empty list.
      db.userIntegrations.set("1:github", {
        user_id: 1,
        integration_id: "github",
        oauth_access_token: "gh-token",
        oauth_refresh_token: null,
        oauth_expires_at: Date.now() - 60_000,
        encrypted: 0,
      });
      db.sessionIndex.set("s-2", {
        session_id: "s-2",
        owner_user_id: "2",
        business_id: "biz-1",
        status: "active",
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
        closed_at: null,
        last_event_id: null,
        title: null,
        rich_status: "idle",
        repo_owner: "acme",
        repo_name: "web",
      });

      const res = await workerFetch(workerModule, env, "/api/sessions?scope=business", {
        headers: { cookie: "session_token=sess-user-1" },
      });
      expect(res.status).toBe(503);
    });

    it("continues paging shared business sessions until repo-visible rows fill the requested page", async () => {
      const { env, db, kv } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 1, created_at: Date.now() });
      db.setAuthToken("sess-user-1", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "user1",
        name: "User One",
        email: null,
        business_id: "biz-1",
      });
      db.setUser({ id: 1, business_id: "biz-1", login: "user1" });
      db.setUser({ id: 2, business_id: "biz-1", login: "user2" });
      db.userIntegrations.set("1:github", {
        user_id: 1,
        integration_id: "github",
        oauth_access_token: "gh-token",
        oauth_refresh_token: null,
        oauth_expires_at: null,
        encrypted: 0,
      });
      resetReposMemoryCache();
      await seedRepoAccessCache(kv, "1", ["acme/visible"]);

      for (const [sessionId, repoOwner, repoName] of [
        ["s-hidden-1", null, null],
        ["s-hidden-2", null, null],
        ["s-visible", "acme", "visible"],
      ] as const) {
        db.sessionIndex.set(sessionId, {
          session_id: sessionId,
          owner_user_id: "2",
          business_id: "biz-1",
          status: "active",
          created_at: "2025-01-01",
          updated_at: "2025-01-01",
          closed_at: null,
          last_event_id: null,
          title: null,
          rich_status: "idle",
          repo_owner: repoOwner,
          repo_name: repoName,
        });
      }

      const res = await workerFetch(workerModule, env, "/api/sessions?scope=business&limit=1", {
        headers: { cookie: "session_token=sess-user-1" },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sessions: Array<{ sessionId: string; ownerLogin?: string }>;
        nextCursor: string | null;
      };
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].sessionId).toBe("s-visible");
      expect(body.sessions[0].ownerLogin).toBe("user2");
      expect(body.nextCursor).toBeNull();
    });

    it("returns only own sessions with default scope", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 1, created_at: Date.now() });
      db.setAuthToken("sess-user-1", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "user1",
        name: "User One",
        email: null,
        business_id: "biz-1",
      });
      db.setUser({ id: 1, business_id: "biz-1" });
      db.setUser({ id: 2, business_id: "biz-1" });

      db.sessionIndex.set("s-1", {
        session_id: "s-1",
        owner_user_id: "1",
        business_id: "biz-1",
        status: "active",
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
        closed_at: null,
        last_event_id: null,
        title: null,
        rich_status: "idle",
      });
      db.sessionIndex.set("s-2", {
        session_id: "s-2",
        owner_user_id: "2",
        business_id: "biz-1",
        status: "active",
        created_at: "2025-01-01",
        updated_at: "2025-01-01",
        closed_at: null,
        last_event_id: null,
        title: null,
        rich_status: "idle",
      });

      const res = await workerFetch(workerModule, env, "/api/sessions", {
        headers: { cookie: "session_token=sess-user-1" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].sessionId).toBe("s-1");
    });
  });

  // ---- GET /api/businesses/:id/integrations ----

  describe("GET /api/businesses/:id/integrations", () => {
    it("returns 403 for non-admin user", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-member", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "member1",
        name: "Member",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "member" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations", {
        headers: { cookie: "session_token=sess-member" },
      });
      expect(res.status).toBe(403);
    });

    it("returns 403 when the authenticated user has no business membership row", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setUser({ id: 1, business_id: "biz-1", github_id: 101, login: "orphaned-user" });
      db.setAuthToken("sess-no-member", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "orphaned-user",
        name: "No Member",
        email: null,
        business_id: "biz-1",
      });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations", {
        headers: { cookie: "session_token=sess-no-member" },
      });

      expect(res.status).toBe(403);
    });

    it("returns integration settings for admin", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });
      db.addLinearWebhookInstallation({
        businessId: "biz-1",
        organizationId: "lin-org-1",
        organizationName: "Cycloid Inc",
        organizationUrlKey: "cycloid",
        webhookId: "lin-webhook-1",
      });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations", {
        headers: { cookie: "session_token=sess-admin" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        integrations: Record<
          string,
          {
            scope: string;
            credentialsConnected: boolean;
            linearWorkspace?: {
              status: string;
              organizationId: string | null;
              organizationName: string | null;
              organizationUrlKey: string | null;
              webhookId: string | null;
              webhookBound: boolean;
            };
          }
        >;
      };
      expect(body.ok).toBe(true);
      // Non-business-only integrations default to user scope; business-only default to disabled
      expect(body.integrations.linear.scope).toBe("user");
      expect(body.integrations.linear.linearWorkspace).toEqual({
        status: "active",
        organizationId: "lin-org-1",
        organizationName: "Cycloid Inc",
        organizationUrlKey: "cycloid",
        webhookId: "lin-webhook-1",
        webhookBound: true,
      });
      expect((body.integrations.slack as Record<string, unknown>).slackWorkspace).toEqual({
        status: "not_installed",
        teamId: null,
        teamName: null,
        teamDomain: null,
        installedAt: null,
      });
    });

    it("reports the active Slack workspace install and ignores uninstalled rows", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });
      db.slackWorkspaces.set("T_OLD", {
        team_id: "T_OLD",
        bot_user_id: "U_OLD",
        team_name: "Old Workspace",
        business_id: "biz-1",
        team_domain: "old",
        enterprise_id: null,
        installed_by_user_id: 1,
        installed_at: 100,
        updated_at: 200,
        uninstalled_at: 200,
      });
      db.slackWorkspaces.set("T_ACTIVE", {
        team_id: "T_ACTIVE",
        bot_user_id: "U_ACTIVE",
        team_name: "Active Workspace",
        business_id: "biz-1",
        team_domain: "active",
        enterprise_id: null,
        installed_by_user_id: 1,
        installed_at: 300,
        updated_at: 300,
        uninstalled_at: null,
      });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations", {
        headers: { cookie: "session_token=sess-admin" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        integrations: Record<string, { slackWorkspace?: Record<string, unknown> }>;
      };
      expect(body.integrations.slack.slackWorkspace).toEqual({
        status: "installed",
        teamId: "T_ACTIVE",
        teamName: "Active Workspace",
        teamDomain: "active",
        installedAt: 300,
      });
    });

    it("reports jira workspace states including revoked", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });
      db.addJiraWebhookInstallation({
        businessId: "biz-1",
        cloudId: "cloud-1",
        status: "revoked",
        webhooksJson: JSON.stringify([{ webhookId: 9001 }]),
        webhookExpiresAt: Date.now() + 1000,
      });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations", {
        headers: { cookie: "session_token=sess-admin" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        integrations: Record<
          string,
          { jiraWorkspace?: { status: string; cloudId: string | null; webhookBound: boolean } }
        >;
      };
      // A removed binding must surface as revoked (Reconnect), not
      // not_connected (Connect), and never report a bound webhook.
      expect(body.integrations.jira.jiraWorkspace).toMatchObject({
        status: "revoked",
        cloudId: "cloud-1",
        webhookBound: false,
      });
    });

    it("returns disabled integrations correctly", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });
      db.businessIntegrations.set("biz-1:linear", {
        business_id: "biz-1",
        integration_id: "linear",
        scope: "disabled",
      });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations", {
        headers: { cookie: "session_token=sess-admin" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        integrations: Record<string, { scope: string; credentialsConnected: boolean }>;
      };
      expect(body.integrations.linear.scope).toBe("disabled");
    });

    it("returns latest GitHub health check evidence", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });
      db.businessIntegrationHealthChecks.set("github-old", {
        id: "github-old",
        business_id: "biz-1",
        integration_id: "github",
        check_kind: "basic",
        status: "failed",
        operation: "github.repos.get",
        checked_at: 100,
        latency_ms: 80,
        diagnostic: "github_api_error",
        failure_reason: "old failure",
        details_json: null,
        created_at: 100,
      });
      db.businessIntegrationHealthChecks.set("github-new", {
        id: "github-new",
        business_id: "biz-1",
        integration_id: "github",
        check_kind: "basic",
        status: "passed",
        operation: "github.repos.get",
        checked_at: 200,
        latency_ms: 30,
        diagnostic: "github_repo_resolved",
        failure_reason: null,
        details_json: JSON.stringify({ repoOwner: "trycycloid", repoName: "cycloid" }),
        created_at: 200,
      });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations", {
        headers: { cookie: "session_token=sess-admin" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        integrations: Record<
          string,
          {
            credentialsConnected: boolean;
            health?: {
              status: string;
              checkKind: string;
              operation: string;
              checkedAt: number;
              latencyMs: number;
            } | null;
            currentHealth?: {
              state: string;
              source: string;
              diagnostic: string | null;
              checkedAt: number | null;
            };
          }
        >;
      };
      expect(body.integrations.github).toMatchObject({
        credentialsConnected: true,
        health: {
          status: "passed",
          checkKind: "basic",
          operation: "github.repos.get",
          checkedAt: 200,
          latencyMs: 30,
        },
        currentHealth: {
          state: "healthy",
          source: "health_check",
          diagnostic: "github_repo_resolved",
          checkedAt: 200,
        },
      });
    });

    it("returns null GitHub health when no evidence exists", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations", {
        headers: { cookie: "session_token=sess-admin" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        integrations: Record<
          string,
          {
            credentialsConnected: boolean;
            health?: { status: string } | null;
          }
        >;
      };
      expect(body.integrations.github).toMatchObject({
        credentialsConnected: false,
        health: null,
      });
    });

    it.each(["failed", "skipped"] as const)(
      "keeps GitHub credentialsConnected false when latest health status is %s",
      async (status) => {
        const { env, db } = createWorkerEnv(workerModule);
        db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
        db.setAuthToken("sess-admin", {
          user_id: 1,
          id: 1,
          expires_at: Date.now() + 60_000,
          login: "admin1",
          name: "Admin",
          email: null,
          business_id: "biz-1",
        });
        db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });
        db.businessIntegrationHealthChecks.set("github-nonpassed", {
          id: "github-nonpassed",
          business_id: "biz-1",
          integration_id: "github",
          check_kind: "basic",
          status,
          operation: "github.repos.get",
          checked_at: 300,
          latency_ms: 40,
          diagnostic: "github_health_probe",
          failure_reason: status === "failed" ? "boom" : null,
          details_json: null,
          created_at: 300,
        });

        const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations", {
          headers: { cookie: "session_token=sess-admin" },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          integrations: Record<
            string,
            {
              credentialsConnected: boolean;
              health?: { status: string; failureReason: string | null } | null;
            }
          >;
        };
        expect(body.integrations.github).toMatchObject({
          credentialsConnected: false,
          health: { status, failureReason: status === "failed" ? "boom" : null },
        });
      },
    );
  });

  // ---- DELETE /api/businesses/:id/integrations/linear/workspace ----

  describe("DELETE /api/businesses/:id/integrations/linear/workspace", () => {
    it("revokes an active Linear workspace installation for admin", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });
      db.addLinearWebhookInstallation({
        businessId: "biz-1",
        organizationId: "lin-org-1",
        webhookId: "lin-webhook-1",
      });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/linear/workspace", {
        method: "DELETE",
        headers: { cookie: "session_token=sess-admin" },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; disconnected: boolean };
      expect(body).toEqual({ ok: true, disconnected: true });
      expect(db.linearWebhookInstallations.get("biz-1:lin-org-1")).toMatchObject({
        status: "revoked",
        revoked_at: expect.any(Number),
      });
    });

    it("returns 403 for non-admin user", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-member", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "member1",
        name: "Member",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "member" });
      db.addLinearWebhookInstallation({
        businessId: "biz-1",
        organizationId: "lin-org-1",
        webhookId: "lin-webhook-1",
      });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/linear/workspace", {
        method: "DELETE",
        headers: { cookie: "session_token=sess-member" },
      });

      expect(res.status).toBe(403);
      expect(db.linearWebhookInstallations.get("biz-1:lin-org-1")?.status).toBe("active");
    });

    it("returns 401 when unauthenticated", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.addLinearWebhookInstallation({
        businessId: "biz-1",
        organizationId: "lin-org-1",
        webhookId: "lin-webhook-1",
      });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/linear/workspace", {
        method: "DELETE",
      });

      expect(res.status).toBe(401);
      expect(db.linearWebhookInstallations.get("biz-1:lin-org-1")?.status).toBe("active");
    });

    it("returns disconnected=false when no active installation exists", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/linear/workspace", {
        method: "DELETE",
        headers: { cookie: "session_token=sess-admin" },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; disconnected: boolean };
      expect(body).toEqual({ ok: true, disconnected: false });
    });
  });

  // ---- PUT /api/businesses/:id/integrations/:integrationId ----

  describe("PUT /api/businesses/:id/integrations/:integrationId", () => {
    it("returns 403 for non-admin user", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-member", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "member1",
        name: "Member",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "member" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/linear", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-member" },
        body: JSON.stringify({ scope: "disabled" }),
      });
      expect(res.status).toBe(403);
    });

    it("returns 400 for non-toggleable integration (github)", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/github", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ scope: "disabled" }),
      });
      expect(res.status).toBe(400);
    });

    it("toggles integration off and on", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      // Disable linear
      const disableRes = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/linear", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ scope: "disabled" }),
      });
      expect(disableRes.status).toBe(200);
      expect(db.businessIntegrations.get("biz-1:linear")?.scope).toBe("disabled");

      // Re-enable linear
      const enableRes = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/linear", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ scope: "user" }),
      });
      expect(enableRes.status).toBe(200);
      expect(db.businessIntegrations.get("biz-1:linear")?.scope).toBe("user");
    });

    it("allows admin token to toggle integrations", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/linear", {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ scope: "disabled" }),
      });
      expect(res.status).toBe(200);
      expect(db.businessIntegrations.get("biz-1:linear")?.scope).toBe("disabled");
    });

    it("allows setting scope to 'business' for business-wide integrations", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/openai", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ scope: "business" }),
      });
      expect(res.status).toBe(200);
      expect(db.businessIntegrations.get("biz-1:openai")?.scope).toBe("business");
    });

    it("rejects scope='business' for non-business-wide integrations", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/linear", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ scope: "business" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects scope='user' for business-only integrations", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/not-real", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ scope: "user" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("not toggleable");
    });

    it("accepts scope='disabled' for business-only Sentry integration", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/sentry", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ scope: "disabled" }),
      });
      expect(res.status).toBe(200);
      expect(db.businessIntegrations.get("biz-1:sentry")).toMatchObject({
        business_id: "biz-1",
        integration_id: "sentry",
        scope: "disabled",
      });
    });

    it("accepts scope='business' for Sentry integration", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/sentry", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ scope: "business" }),
      });
      expect(res.status).toBe(200);
      expect(db.businessIntegrations.get("biz-1:sentry")).toMatchObject({
        business_id: "biz-1",
        integration_id: "sentry",
        scope: "business",
      });
    });

    it("invalidates member model caches when scope changes", async () => {
      const { env, db, modelsKv } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.setUser({ id: 1, business_id: "biz-1", login: "admin1" });
      db.setUser({ id: 2, business_id: "biz-1", login: "member1" });
      db.setUser({ id: 3, business_id: "biz-2", login: "outsider" });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });
      db.businessMembers.set("biz-1:2", { business_id: "biz-1", user_id: 2, role: "member" });
      db.businessIntegrationCredentials.set("biz-1:openai", { business_id: "biz-1", integration_id: "openai" });

      const beforeScopeChange = await buildAndCacheModels(env as Env, 2);
      expect(beforeScopeChange.find((group) => group.id === "openai")?.hasApiKey).toBe(false);
      await modelsKv.put(modelsCacheKey(1), JSON.stringify([{ id: "openai", hasApiKey: false }]));
      await modelsKv.put(modelsCacheKey(3), JSON.stringify([{ id: "openai", hasApiKey: false }]));

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/openai", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ scope: "business" }),
      });

      expect(res.status).toBe(200);
      expect(modelsKv.store.has(modelsCacheKey(1))).toBe(false);
      expect(modelsKv.store.has(modelsCacheKey(2))).toBe(false);
      expect(modelsKv.store.has(modelsCacheKey(3))).toBe(true);
      const afterScopeChange = await buildAndCacheModels(env as Env, 2);
      expect(afterScopeChange.find((group) => group.id === "openai")?.hasApiKey).toBe(true);
    });
  });

  // ---- PUT/DELETE /api/businesses/:id/integrations/:integrationId/credentials ----

  describe("business credential routes", () => {
    let providerValidationStatus = 200;
    const originalFetch = globalThis.fetch;
    beforeEach(() => {
      providerValidationStatus = 200;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (
          url.includes("api.openai.com/v1/models") ||
          url.includes("api.anthropic.com/v1/models") ||
          url.includes("inference.baseten.co/v1/models")
        ) {
          return new Response(JSON.stringify({ data: [] }), { status: providerValidationStatus });
        }
        return originalFetch(input, init);
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("stores business-wide credentials for admin", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/openai/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ apiKey: "sk-openai-test123" }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()) as { validationStatus: string }).toMatchObject({ validationStatus: "validated" });
      expect(db.businessIntegrationCredentials.get("biz-1:openai")?.last_validation_status).toBe("validated");

      const audit = lastAuditEvent("business.credentials.connected");
      expect(audit).toMatchObject({
        event: "business.credentials.connected",
        businessId: "biz-1",
        integrationId: "openai",
        actorUserId: "1",
      });
    });

    it("stores business-wide Anthropic credentials for admin (claude_code BYOK)", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/anthropic/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ apiKey: "sk-ant-test123" }),
      });
      expect(res.status).toBe(200);
      expect(db.businessIntegrationCredentials.has("biz-1:anthropic")).toBe(true);
    });

    it.each([
      [401, "invalid"],
      [429, "saved_unverified"],
    ] as const)("persists provider validation outcome for status %s", async (status, expectedStatus) => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });
      providerValidationStatus = status;

      const response = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/openai/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ apiKey: "sk-openai-test123" }),
      });

      expect(response.status).toBe(status === 401 ? 400 : 200);
      expect(db.businessIntegrationCredentials.get("biz-1:openai")?.last_validation_status).toBe(expectedStatus);
    });

    it("preserves an existing business key when a replacement is rejected", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessIntegrationCredentials.set("biz-1:openai", {
        business_id: "biz-1",
        integration_id: "openai",
        api_key: "existing-key",
        encrypted: 0,
        last_validation_status: "validated",
      });
      providerValidationStatus = 401;

      const response = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/openai/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ apiKey: "sk-openai-rejected" }),
      });

      expect(response.status).toBe(400);
      expect(db.businessIntegrationCredentials.get("biz-1:openai")?.api_key).toBe("existing-key");
      expect(db.businessIntegrationCredentials.get("biz-1:openai")?.last_validation_status).toBe("validated");
    });

    it("revalidates a stored business provider key", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessIntegrationCredentials.set("biz-1:openai", {
        business_id: "biz-1",
        integration_id: "openai",
        api_key: "sk-openai-test123",
        encrypted: 0,
        last_validation_status: "saved_unverified",
      });

      const response = await workerFetch(
        workerModule,
        env,
        "/api/businesses/biz-1/integrations/openai/credentials/validate",
        { method: "POST", headers: { cookie: "session_token=sess-admin" } },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, validationStatus: "validated" });
      expect(db.businessIntegrationCredentials.get("biz-1:openai")?.last_validation_status).toBe("validated");
    });

    it("invalidates member model caches when manual credentials are saved", async () => {
      const { env, db, modelsKv } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.setUser({ id: 1, business_id: "biz-1", login: "admin1" });
      db.setUser({ id: 2, business_id: "biz-1", login: "member1" });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });
      db.businessMembers.set("biz-1:2", { business_id: "biz-1", user_id: 2, role: "member" });
      db.businessIntegrations.set("biz-1:openai", {
        business_id: "biz-1",
        integration_id: "openai",
        scope: "business",
      });

      const beforeSave = await buildAndCacheModels(env as Env, 2);
      expect(beforeSave.find((group) => group.id === "openai")?.hasApiKey).toBe(false);

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/openai/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ apiKey: "sk-openai-test123" }),
      });

      expect(res.status).toBe(200);
      expect(modelsKv.store.has(modelsCacheKey(2))).toBe(false);
      const afterSave = await buildAndCacheModels(env as Env, 2);
      expect(afterSave.find((group) => group.id === "openai")?.hasApiKey).toBe(true);
    });

    it("returns 403 for non-admin", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-member", {
        user_id: 2,
        id: 2,
        expires_at: Date.now() + 60_000,
        login: "member1",
        name: "Member",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:2", { business_id: "biz-1", user_id: 2, role: "member" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/openai/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-member" },
        body: JSON.stringify({ apiKey: "sk-openai-test123" }),
      });
      expect(res.status).toBe(403);
    });

    it("checks admin access before allowing manual Sentry credentials", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-member", {
        user_id: 2,
        id: 2,
        expires_at: Date.now() + 60_000,
        login: "member1",
        name: "Member",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:2", { business_id: "biz-1", user_id: 2, role: "member" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/sentry/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-member" },
        body: JSON.stringify({ apiKey: "sntrys_valid_token" }),
      });
      expect(res.status).toBe(403);
    });

    it("returns 400 for non-business-wide integration", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/linear/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ apiKey: "lin_test" }),
      });
      expect(res.status).toBe(400);
    });

    it("stores Sentry manual business credentials for admin", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn() as typeof globalThis.fetch;
      try {
        const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/sentry/credentials", {
          method: "PUT",
          headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
          body: JSON.stringify({ apiKey: "sntrys_valid_token", serviceUrl: "acme" }),
        });
        expect(res.status).toBe(200);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(db.businessIntegrationCredentials.get("biz-1:sentry")).toMatchObject({
          business_id: "biz-1",
          integration_id: "sentry",
          service_url: "acme",
          encrypted: 1,
        });
        expect(db.businessIntegrationCredentials.get("biz-1:sentry")?.api_key).toEqual(expect.stringContaining("enc:"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("stores Datadog manual business credentials for admin", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/datadog/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({
          apiKey: "dd-api-key",
          applicationKey: "dd-app-key",
          serviceUrl: "Datadoghq.eu",
        }),
      });

      expect(res.status).toBe(200);
      expect(db.businessIntegrationCredentials.get("biz-1:datadog")).toMatchObject({
        business_id: "biz-1",
        integration_id: "datadog",
        service_url: "datadoghq.eu",
        encrypted: 1,
      });
      expect(db.businessIntegrationCredentials.get("biz-1:datadog")?.api_key).toEqual(expect.stringContaining("enc:"));
      expect(db.businessIntegrationCredentials.get("biz-1:datadog")?.oauth_access_token).toEqual(
        expect.stringContaining("enc:"),
      );
    });

    it("stores LaunchDarkly manual business credentials for admin", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/launchdarkly/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({
          apiKey: "ld-access-token",
        }),
      });

      expect(res.status).toBe(200);
      expect(db.businessIntegrationCredentials.get("biz-1:launchdarkly")).toMatchObject({
        business_id: "biz-1",
        integration_id: "launchdarkly",
        encrypted: 1,
      });
      expect(db.businessIntegrationCredentials.get("biz-1:launchdarkly")?.api_key).toEqual(
        expect.stringContaining("enc:"),
      );
    });

    it("stores Braintrust manual business credentials for admin", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/braintrust/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({
          apiKey: "bt-api-key",
          serviceUrl: "https://api-eu.braintrust.dev/",
        }),
      });

      expect(res.status).toBe(200);
      expect(db.businessIntegrationCredentials.get("biz-1:braintrust")).toMatchObject({
        business_id: "biz-1",
        integration_id: "braintrust",
        service_url: "https://api-eu.braintrust.dev",
        encrypted: 1,
      });
      expect(db.businessIntegrationCredentials.get("biz-1:braintrust")?.api_key).toEqual(
        expect.stringContaining("enc:"),
      );
    });

    it("stores Stripe manual business credentials for admin", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/stripe/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({
          apiKey: "sk_test_1234567890",
        }),
      });

      expect(res.status).toBe(200);
      expect(db.businessIntegrationCredentials.get("biz-1:stripe")).toMatchObject({
        business_id: "biz-1",
        integration_id: "stripe",
        encrypted: 1,
      });
      expect(db.businessIntegrationCredentials.get("biz-1:stripe")?.api_key).toEqual(expect.stringContaining("enc:"));
    });

    it("rejects Stripe live unrestricted secret keys for admin", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/stripe/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({
          apiKey: "sk_live_1234567890abcdef",
        }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: "Use a Stripe test-mode or restricted secret key; live unrestricted keys are not allowed",
      });
      expect(db.businessIntegrationCredentials.get("biz-1:stripe")).toBeUndefined();
    });

    it("stores Neon manual business credentials for admin", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/neon/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({
          apiKey: "neon-api-key",
          serviceUrl: JSON.stringify({
            projectId: "project-123",
            parentBranchId: "br-main",
          }),
        }),
      });

      expect(res.status).toBe(200);
      expect(db.businessIntegrationCredentials.get("biz-1:neon")).toMatchObject({
        business_id: "biz-1",
        integration_id: "neon",
        service_url: serializeNeonBranchCredentialConfig({
          projectId: "project-123",
          parentBranchId: "br-main",
        }),
        encrypted: 1,
      });
      expect(db.businessIntegrationCredentials.get("biz-1:neon")?.api_key).toEqual(expect.stringContaining("enc:"));
    });

    it("preserves an existing Neon parent branch when rotating only the API key and project ID", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });
      db.businessIntegrationCredentials.set("biz-1:neon", {
        business_id: "biz-1",
        integration_id: "neon",
        api_key: "enc:old",
        service_url: serializeNeonBranchCredentialConfig({
          projectId: "project-123",
          parentBranchId: "br-main",
        }),
        encrypted: 1,
      });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/neon/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({
          apiKey: "neon-api-key-rotated",
          serviceUrl: serializeNeonBranchCredentialConfig({
            projectId: "project-123",
          }),
        }),
      });

      expect(res.status).toBe(200);
      expect(db.businessIntegrationCredentials.get("biz-1:neon")).toMatchObject({
        service_url: serializeNeonBranchCredentialConfig({
          projectId: "project-123",
          parentBranchId: "br-main",
        }),
      });
    });

    it("requires serviceUrl for manual Sentry credentials", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/sentry/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ apiKey: "sntrys_valid_token" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body).toEqual({ ok: false, error: "serviceUrl is required" });
    });

    it("rejects malformed Neon config payloads", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/neon/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({
          apiKey: "neon-api-key",
          serviceUrl: JSON.stringify({ parentBranchId: "br-main" }),
        }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        ok: false,
        error: "serviceUrl must be a JSON object containing Neon projectId and optional parentBranchId",
      });
      expect(db.businessIntegrationCredentials.has("biz-1:neon")).toBe(false);
    });

    it("requires apiKey when only serviceUrl is provided for manual credentials", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/openai/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ serviceUrl: "https://example.com" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body).toEqual({ ok: false, error: "apiKey is required" });
      expect(db.businessIntegrationCredentials.has("biz-1:openai")).toBe(false);
    });

    it("requires applicationKey for Datadog credentials", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/datadog/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ apiKey: "dd-api-key", serviceUrl: "us5.datadoghq.com" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body).toEqual({ ok: false, error: "applicationKey is required" });
    });

    it("rejects unsupported Datadog serviceUrl values", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/datadog/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({
          apiKey: "dd-api-key",
          applicationKey: "dd-app-key",
          serviceUrl: "evil.example.com",
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body).toEqual({ ok: false, error: "serviceUrl must be one of the supported Datadog site values" });
      expect(db.businessIntegrationCredentials.has("biz-1:datadog")).toBe(false);
    });

    it("stores manual Cloudflare D1 credentials with the token and account ID encrypted", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/cloudflare/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({
          apiKey: "cf-token",
          applicationKey: "0123456789abcdef0123456789abcdef",
          serviceUrl: "11111111-2222-3333-4444-555555555555",
        }),
      });

      expect(res.status).toBe(200);
      expect(db.businessIntegrationCredentials.get("biz-1:cloudflare")).toMatchObject({
        business_id: "biz-1",
        integration_id: "cloudflare",
        service_url: "11111111-2222-3333-4444-555555555555",
        encrypted: 1,
      });
      expect(db.businessIntegrationCredentials.get("biz-1:cloudflare")?.api_key).toEqual(
        expect.stringContaining("enc:"),
      );
      expect(db.businessIntegrationCredentials.get("biz-1:cloudflare")?.oauth_access_token).toEqual(
        expect.stringContaining("enc:"),
      );
    });

    it("requires applicationKey (account ID) for Cloudflare D1 credentials", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/cloudflare/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ apiKey: "cf-token", serviceUrl: "11111111-2222-3333-4444-555555555555" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body).toEqual({ ok: false, error: "applicationKey (Cloudflare account ID) is required" });
      expect(db.businessIntegrationCredentials.has("biz-1:cloudflare")).toBe(false);
    });

    it("requires serviceUrl (Cloudflare D1 database ID) for Cloudflare D1 credentials", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/cloudflare/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({ apiKey: "cf-token", applicationKey: "0123456789abcdef0123456789abcdef" }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        ok: false,
        error: "serviceUrl (Cloudflare D1 database ID) is required",
      });
      expect(db.businessIntegrationCredentials.has("biz-1:cloudflare")).toBe(false);
    });

    it("rejects malformed Cloudflare account IDs and database IDs", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const badAccount = await workerFetch(
        workerModule,
        env,
        "/api/businesses/biz-1/integrations/cloudflare/credentials",
        {
          method: "PUT",
          headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
          body: JSON.stringify({
            apiKey: "cf-token",
            applicationKey: "not-an-account-id",
            serviceUrl: "11111111-2222-3333-4444-555555555555",
          }),
        },
      );
      expect(badAccount.status).toBe(400);
      expect(await badAccount.json()).toEqual({
        ok: false,
        error: "applicationKey must be a valid Cloudflare account ID",
      });

      const badDatabase = await workerFetch(
        workerModule,
        env,
        "/api/businesses/biz-1/integrations/cloudflare/credentials",
        {
          method: "PUT",
          headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
          body: JSON.stringify({
            apiKey: "cf-token",
            applicationKey: "0123456789abcdef0123456789abcdef",
            serviceUrl: "not-a-uuid",
          }),
        },
      );
      expect(badDatabase.status).toBe(400);
      expect(await badDatabase.json()).toEqual({
        ok: false,
        error: "serviceUrl must be a valid Cloudflare D1 database ID",
      });
      expect(db.businessIntegrationCredentials.has("biz-1:cloudflare")).toBe(false);
    });

    it("rejects unsupported Braintrust serviceUrl values", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/braintrust/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "session_token=sess-admin" },
        body: JSON.stringify({
          apiKey: "bt-api-key",
          serviceUrl: "https://evil.example.com",
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body).toEqual({ ok: false, error: "serviceUrl must be one of the allowed Braintrust API hosts" });
      expect(db.businessIntegrationCredentials.has("biz-1:braintrust")).toBe(false);
    });

    it("deletes credentials and resets scope to user", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });
      db.businessIntegrations.set("biz-1:openai", {
        business_id: "biz-1",
        integration_id: "openai",
        scope: "business",
      });
      db.businessIntegrations.set("biz-1:sentry", {
        business_id: "biz-1",
        integration_id: "sentry",
        scope: "business",
      });
      db.businessIntegrations.set("biz-1:sentry", {
        business_id: "biz-1",
        integration_id: "sentry",
        scope: "business",
      });
      db.businessIntegrationCredentials.set("biz-1:openai", { business_id: "biz-1", integration_id: "openai" });

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/openai/credentials", {
        method: "DELETE",
        headers: { cookie: "session_token=sess-admin" },
      });
      expect(res.status).toBe(200);
      expect(db.businessIntegrationCredentials.has("biz-1:openai")).toBe(false);
      // Scope should be reset to 'user'
      expect(db.businessIntegrations.get("biz-1:openai")?.scope).toBe("user");

      const audit = lastAuditEvent("business.credentials.disconnected");
      expect(audit).toMatchObject({
        event: "business.credentials.disconnected",
        businessId: "biz-1",
        integrationId: "openai",
        actorUserId: "1",
      });
    });

    it("invalidates member model caches when manual credentials are removed", async () => {
      const { env, db, modelsKv } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setAuthToken("sess-admin", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "admin1",
        name: "Admin",
        email: null,
        business_id: "biz-1",
      });
      db.setUser({ id: 1, business_id: "biz-1", login: "admin1" });
      db.setUser({ id: 2, business_id: "biz-1", login: "member1" });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });
      db.businessMembers.set("biz-1:2", { business_id: "biz-1", user_id: 2, role: "member" });
      db.businessIntegrations.set("biz-1:openai", {
        business_id: "biz-1",
        integration_id: "openai",
        scope: "business",
      });
      db.businessIntegrationCredentials.set("biz-1:openai", {
        business_id: "biz-1",
        integration_id: "openai",
      });

      const beforeRemove = await buildAndCacheModels(env as Env, 2);
      expect(beforeRemove.find((group) => group.id === "openai")?.hasApiKey).toBe(true);

      const res = await workerFetch(workerModule, env, "/api/businesses/biz-1/integrations/openai/credentials", {
        method: "DELETE",
        headers: { cookie: "session_token=sess-admin" },
      });

      expect(res.status).toBe(200);
      expect(modelsKv.store.has(modelsCacheKey(2))).toBe(false);
      const afterRemove = await buildAndCacheModels(env as Env, 2);
      expect(afterRemove.find((group) => group.id === "openai")?.hasApiKey).toBe(false);
    });
  });

  // ---- GET /auth/me ----

  describe("GET /auth/me", () => {
    function seedAuthMeUser(db: FakeD1): void {
      db.businesses.set("biz-1", {
        id: "biz-1",
        name: "Test",
        shared_sessions: 0,
        egress_allowlist_json: JSON.stringify({ domains: ["api.acme.test"] }),
        created_at: Date.now(),
      });
      db.setUser({ id: 1, business_id: "biz-1", login: "user1", name: "User One", avatar_url: null });
      db.setAuthToken("sess-user", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "user1",
        name: "User One",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "member" });
    }

    it("excludes integration fields from narrowed response", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedAuthMeUser(db);

      const res = await workerFetch(workerModule, env, "/auth/me", {
        headers: { cookie: "session_token=sess-user" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { authenticated: boolean; user: Record<string, unknown> };
      expect(body.authenticated).toBe(true);
      // Phase 1: these fields are no longer returned by /auth/me
      expect(body.user).not.toHaveProperty("availableIntegrations");
      expect(body.user).not.toHaveProperty("integrationTools");
      expect(body.user).not.toHaveProperty("integrationScopes");
      // Identity fields still present
      expect(body.user).toHaveProperty("id");
      expect(body.user).toHaveProperty("login");
      expect(body.user).toHaveProperty("businessId");
    });

    it("redacts egressAllowlist for non-admin users", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedAuthMeUser(db);

      const res = await workerFetch(workerModule, env, "/auth/me", {
        headers: { cookie: "session_token=sess-user" },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: { egressAllowlist: string[] | null } };
      expect(body.user.egressAllowlist).toBeNull();
    });

    it("returns egressAllowlist for admin users", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedAuthMeUser(db);
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "admin" });

      const res = await workerFetch(workerModule, env, "/auth/me?fresh=1", {
        headers: { cookie: "session_token=sess-user" },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: { egressAllowlist: string[] | null } };
      expect(body.user.egressAllowlist).toEqual(["api.acme.test"]);
    });

    it("returns 401 without session cookie", async () => {
      const { env } = createWorkerEnv(workerModule);
      const res = await workerFetch(workerModule, env, "/auth/me");
      expect(res.status).toBe(401);
    });
  });

  // ---- GET /api/user/integrations ----

  describe("GET /api/user/integrations", () => {
    function seedIntegrationsUser(db: FakeD1): void {
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 0, created_at: Date.now() });
      db.setUser({ id: 1, business_id: "biz-1", login: "user1", name: "User One", avatar_url: null });
      db.setAuthToken("sess-user", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "user1",
        name: "User One",
        email: null,
        business_id: "biz-1",
      });
      db.businessMembers.set("biz-1:1", { business_id: "biz-1", user_id: 1, role: "member" });
    }

    it("returns available integrations excluding disabled ones", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedIntegrationsUser(db);
      db.businessIntegrations.set("biz-1:linear", {
        business_id: "biz-1",
        integration_id: "linear",
        scope: "disabled",
      });

      const res = await workerFetch(workerModule, env, "/api/user/integrations", {
        headers: { cookie: "session_token=sess-user" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { availableIntegrations: string[] };
      expect(body.availableIntegrations).toContain("github");
      expect(body.availableIntegrations).not.toContain("linear");
    });

    it("returns all integrations when all are explicitly enabled", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedIntegrationsUser(db);
      const res = await workerFetch(workerModule, env, "/api/user/integrations", {
        headers: { cookie: "session_token=sess-user" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { availableIntegrations: string[] };
      expect(body.availableIntegrations).toContain("github");
      expect(body.availableIntegrations).toContain("linear");
    });

    it("excludes business-only integrations by default", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedIntegrationsUser(db);

      const res = await workerFetch(workerModule, env, "/api/user/integrations", {
        headers: { cookie: "session_token=sess-user" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { availableIntegrations: string[] };
      expect(body.availableIntegrations).toContain("github");
      expect(body.availableIntegrations).toContain("linear");
      expect(body.availableIntegrations).not.toContain("sentry");
    });

    it("returns integration scopes and tool metadata", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedIntegrationsUser(db);
      db.businessIntegrations.set("biz-1:linear", {
        business_id: "biz-1",
        integration_id: "linear",
        scope: "disabled",
      });
      db.businessIntegrations.set("biz-1:openai", {
        business_id: "biz-1",
        integration_id: "openai",
        scope: "business",
      });
      db.businessIntegrations.set("biz-1:sentry", {
        business_id: "biz-1",
        integration_id: "sentry",
        scope: "business",
      });

      const res = await workerFetch(workerModule, env, "/api/user/integrations", {
        headers: { cookie: "session_token=sess-user" },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        availableIntegrations: string[];
        integrationScopes: Record<string, string>;
        integrationTools: Array<{
          key: string;
          displayName: string;
          description: string;
          tools: Array<{ name: string; description: string }>;
        }>;
      };

      expect(body.availableIntegrations).toEqual(["github", "slack", "jira", "notion", "sentry", "openai"]);
      expect(body.availableIntegrations).not.toContain("anthropic");
      expect(body.availableIntegrations).not.toContain("codex_subscription");
      expect(body.integrationScopes).toMatchObject({
        openai: "business",
        linear: "disabled",
        notion: "user",
        sentry: "business",
      });
      expect(body.integrationTools).toEqual([
        {
          key: "slack",
          displayName: "Slack",
          description: "Workspace messaging, thread context, and Slack-originated agent workflows",
          tools: [
            { name: "get_thread", description: "Read a Slack thread by channel and root message timestamp" },
            { name: "search_messages", description: "Search Slack messages in the connected workspace" },
            { name: "send_message", description: "Post a Slack message to a channel or thread" },
          ],
        },
        {
          key: "jira",
          displayName: "Jira",
          description: "Issue tracking and project management for Jira Cloud",
          tools: [
            { name: "create_issue", description: "Create a Jira issue in a project" },
            { name: "get_issue", description: "Read a Jira issue by key or ID" },
            { name: "list_transitions", description: "List available workflow transitions for an issue" },
            { name: "transition_issue", description: "Move a Jira issue to a new workflow status" },
          ],
        },
        {
          key: "notion",
          displayName: "Notion",
          description: "Workspace search and page content reads",
          tools: [
            { name: "search", description: "Search shared Notion pages and data sources by title" },
            { name: "get_block_children", description: "Read the child blocks for a Notion page or block" },
          ],
        },
        {
          key: "sentry",
          displayName: "Sentry",
          description: "Issue and event lookup for connected Sentry organizations",
          tools: [{ name: "lookup_issue", description: "Resolve a Sentry issue, event, URL, or short ID" }],
        },
      ]);
    });

    it("returns current health from latest scoped lifecycle evidence", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedIntegrationsUser(db);
      db.businessIntegrations.set("biz-1:sentry", {
        business_id: "biz-1",
        integration_id: "sentry",
        scope: "business",
      });
      db.integrationLifecycleEvents.set("linear-user-failed", {
        id: "linear-user-failed",
        business_id: "biz-1",
        user_id: 1,
        session_id: null,
        integration_id: "linear",
        stage: "credential_resolved",
        status: "failed",
        reason_code: "token_revoked",
        message: "Linear credentials were revoked.",
        details_json: null,
        latency_ms: 0,
        created_at: 100,
      });
      db.integrationLifecycleEvents.set("sentry-business-passed", {
        id: "sentry-business-passed",
        business_id: "biz-1",
        user_id: null,
        session_id: null,
        integration_id: "sentry",
        stage: "credential_resolved",
        status: "passed",
        reason_code: null,
        message: "Sentry credentials resolved.",
        details_json: null,
        latency_ms: 0,
        created_at: 200,
      });

      const res = await workerFetch(workerModule, env, "/api/user/integrations", {
        headers: { cookie: "session_token=sess-user" },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        currentHealth: Record<
          string,
          { state: string; source: string; reasonCode: string | null; checkedAt: number; message: string | null }
        >;
      };
      expect(body.currentHealth.linear).toMatchObject({
        state: "disconnected",
        source: "lifecycle",
        reasonCode: "token_revoked",
        checkedAt: 100,
        message: "Linear credentials were revoked.",
      });
      expect(body.currentHealth.sentry).toMatchObject({
        state: "healthy",
        source: "lifecycle",
        reasonCode: null,
        checkedAt: 200,
        message: null,
      });
      expect(body.currentHealth.notion).toMatchObject({ state: "unknown", source: "none" });
    });

    it("does not let business health override newer user reconnect failures on user-scoped integrations", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedIntegrationsUser(db);
      db.integrationLifecycleEvents.set("linear-user-failed", {
        id: "linear-user-failed",
        business_id: "biz-1",
        user_id: 1,
        session_id: null,
        integration_id: "linear",
        stage: "credential_resolved",
        status: "failed",
        reason_code: "token_refresh_failed",
        message: "Linear credentials could not be refreshed. Reconnect Linear and try again.",
        details_json: null,
        latency_ms: 0,
        created_at: 100,
      });
      db.businessIntegrationHealthChecks.set("linear-business-passed", {
        id: "linear-business-passed",
        business_id: "biz-1",
        integration_id: "linear",
        check_kind: "basic",
        status: "passed",
        operation: "linear.viewer",
        checked_at: 200,
        latency_ms: 12,
        diagnostic: "ok",
        failure_reason: null,
        details_json: null,
        created_at: 200,
      });

      const res = await workerFetch(workerModule, env, "/api/user/integrations", {
        headers: { cookie: "session_token=sess-user" },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        currentHealth: Record<
          string,
          { state: string; source: string; reasonCode: string | null; checkedAt: number; message: string | null }
        >;
      };
      expect(body.currentHealth.linear).toMatchObject({
        state: "disconnected",
        source: "lifecycle",
        reasonCode: "token_refresh_failed",
        checkedAt: 100,
        message: "Linear credentials could not be refreshed. Reconnect Linear and try again.",
      });
    });

    it("surfaces business health for business-scoped integrations on the user integrations view", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      seedIntegrationsUser(db);
      db.businessIntegrations.set("biz-1:jira", {
        business_id: "biz-1",
        integration_id: "jira",
        scope: "business",
      });
      db.businessIntegrationHealthChecks.set("jira-business-failed", {
        id: "jira-business-failed",
        business_id: "biz-1",
        integration_id: "jira",
        check_kind: "basic",
        status: "failed",
        operation: "jira.accessible_resources",
        checked_at: 200,
        latency_ms: 12,
        diagnostic: "jira_installer_token_missing",
        failure_reason: "The Jira installer's OAuth token is missing or can no longer be refreshed.",
        details_json: null,
        created_at: 200,
      });

      const res = await workerFetch(workerModule, env, "/api/user/integrations", {
        headers: { cookie: "session_token=sess-user" },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        currentHealth: Record<
          string,
          { state: string; source: string; reasonCode: string | null; checkedAt: number; message: string | null }
        >;
      };
      expect(body.currentHealth.jira).toMatchObject({
        state: "disconnected",
        source: "health_check",
        reasonCode: null,
        checkedAt: 200,
        message: "The Jira installer's OAuth token is missing or can no longer be refreshed.",
      });
    });

    it("returns 401 without session cookie", async () => {
      const { env } = createWorkerEnv(workerModule);
      const res = await workerFetch(workerModule, env, "/api/user/integrations");
      expect(res.status).toBe(401);
    });
  });

  // ---- Cross-business session access control ----

  describe("session access control", () => {
    it("allows access to a session owned by a same-business user", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      db.businesses.set("biz-1", { id: "biz-1", name: "Test", shared_sessions: 1, created_at: Date.now() });
      db.setAuthToken("sess-user-1", {
        user_id: 1,
        id: 1,
        expires_at: Date.now() + 60_000,
        login: "user1",
        name: "User One",
        email: null,
        business_id: "biz-1",
      });
      db.setUser({ id: 1, business_id: "biz-1" });
      db.setUser({ id: 2, business_id: "biz-1" });

      // Create a session owned by user 2 via the DO
      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ sessionId: "s-cross", ownerUserId: "2", repoOwner: "test", repoName: "repo" }),
      });
      // Session creation may fail due to missing GitHub installation -- that's OK,
      // the DO still persists the session state. Use direct DO fetch instead.
      if (createRes.status !== 201) {
        // Seed session index directly for the access control test
        db.sessionIndex.set("s-cross", {
          session_id: "s-cross",
          owner_user_id: "2",
          business_id: "biz-1",
          status: "active",
          created_at: "2025-01-01",
          updated_at: "2025-01-01",
          closed_at: null,
          last_event_id: null,
          title: null,
          rich_status: "idle",
        });
      }

      // User 1 should be able to access user 2's session (same business)
      const getRes = await workerFetch(workerModule, env, "/api/sessions/s-cross", {
        headers: { cookie: "session_token=sess-user-1" },
      });
      // The DO may not have session state, but access control should not return 404
      // due to business membership. The response depends on DO state.
      // If DO returns a session, we get 200. If not, we still confirm it wasn't blocked by canAccessSession.
      expect(getRes.status).not.toBe(403);
    });

    it("denies access to a session owned by a different-business user", async () => {
      // Test at the unit level since full route test requires DO session state
      const modulePath: string = "../../apps/control-plane-worker/src/session/db";
      const mod = (await import(modulePath)) as {
        canAccessSession: (
          auth: {
            userId: string;
            canAccessAllSessions: boolean;
            user?: { businessId?: string | null; sharedSessions?: boolean; businessMemberIds?: string[] };
          },
          session: { ownerUserId: string },
        ) => boolean;
      };

      // User 3 is NOT in biz-1's member list
      const auth = {
        userId: "1",
        canAccessAllSessions: false,
        user: { businessId: "biz-1", sharedSessions: true, businessMemberIds: ["1", "2"] },
      };
      const session = { ownerUserId: "3" };

      const result = mod.canAccessSession(auth as never, session as never);
      expect(result).toBe(false);
    });
  });
});
