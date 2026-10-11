import type { CredentialValidationStatus } from "../constants/onboarding";

export type BusinessIntegrationCredentialKind = "oauth" | "manual" | null;

export type IntegrationHealthCheck = {
  status: "passed" | "failed" | "skipped";
  checkKind: "basic" | "synthetic_session";
  operation: string;
  checkedAt: number;
  latencyMs: number;
  diagnostic: string;
  failureReason: string | null;
};

export type IntegrationCurrentHealth = {
  state: "healthy" | "degraded" | "disconnected" | "unknown";
  source: "health_check" | "lifecycle" | "none";
  status: "passed" | "failed" | "skipped" | null;
  checkedAt: number | null;
  reasonCode: string | null;
  diagnostic: string | null;
  message: string | null;
};

export type BusinessIntegrationHealthCheck = IntegrationHealthCheck & {
  checkKind: "basic";
};

export type IntegrationLifecycleSummary = {
  integrationId: string;
  stage: string;
  status: "passed" | "failed" | "skipped";
  reasonCode: string | null;
  message: string | null;
  createdAt: number;
};

export type IntegrationLifecycleEvent = {
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
};

export type LinearWorkspaceIntegrationInfo = {
  status: "not_connected" | "active" | "revoked";
  organizationId: string | null;
  organizationName: string | null;
  organizationUrlKey: string | null;
  webhookId: string | null;
  webhookBound: boolean;
};

export type JiraWorkspaceIntegrationInfo = {
  status: "not_connected" | "active" | "degraded" | "revoked";
  cloudId: string | null;
  siteName: string | null;
  siteUrl: string | null;
  webhookBound: boolean;
  webhookExpiresAt: number | null;
  triggerLabel: string | null;
};

export type SlackWorkspaceIntegrationInfo = {
  status: "not_installed" | "installed";
  teamId: string | null;
  teamName: string | null;
  teamDomain: string | null;
  installedAt: number | null;
};

export type NeonCredentialConfigInfo = {
  projectId: string;
  parentBranchId: string | null;
};

export type BusinessIntegrationInfo = {
  scope: "disabled" | "user" | "business";
  credentialsConnected: boolean;
  credentialKind: BusinessIntegrationCredentialKind;
  credentialValidationStatus: CredentialValidationStatus | null;
  connectedOrgSlug?: string | null;
  connectedOrgName?: string | null;
  health?: BusinessIntegrationHealthCheck | null;
  currentHealth?: IntegrationCurrentHealth;
  lifecycle?: IntegrationLifecycleSummary | null;
  linearWorkspace?: LinearWorkspaceIntegrationInfo;
  jiraWorkspace?: JiraWorkspaceIntegrationInfo;
  slackWorkspace?: SlackWorkspaceIntegrationInfo;
  neonCredentialConfig?: NeonCredentialConfigInfo | null;
};
