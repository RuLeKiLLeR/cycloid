import { activityRoutes } from "./activity";
import { adminApprovalRoutes } from "./admin-approvals";
import { adminConsoleRoutes } from "./admin-console";
import { adminFsmBackfillRoutes } from "./admin-fsm-backfill";
import { adminFsmParityCheckRoutes } from "./admin-fsm-parity-check";
import { adminFsmRow7RepairRoutes } from "./admin-fsm-row7-repair";
import { adminImpersonationRoutes } from "./admin-impersonation";
import { adminSandboxTemplateRoutes } from "./admin-sandbox-templates";
import { authRoutes } from "./auth";
import { automationRunRoutes } from "./automation-runs";
import { automationScheduleRoutes } from "./automation-schedules";
import { automationTriggerRoutes } from "./automation-triggers";
import { bootstrapRoutes } from "./bootstrap";
import { businessRoutes } from "./businesses";
import { cliTokenRoutes } from "./cli-tokens";
import { githubCheckAutomationRoutes } from "./github-check-automations";
import { integrationRoutes } from "./integrations";
import { memoryReviewRoutes } from "./memory-review";
import { modelRoutes } from "./models";
import { observabilityRoutes } from "./observability";
import { onboardingRoutes } from "./onboarding";
import { openAIGatewayRoutes } from "./openai-gateway";
import { pagerDutyDispatchRoutes } from "./pagerduty-dispatch";
import { personalSecretsRoutes } from "./personal-secrets";
import { prInboxRoutes } from "./pr-inbox";
import { publicRoutes } from "./public";
import { qaRoutes } from "./qa";
import { repoContextRoutes } from "./repo-context";
import { repoRoutes } from "./repos";
import { sandboxLayerAssignmentRoutes } from "./sandbox-layer-assignments";
import { sandboxLayerRoutes } from "./sandbox-layers";
import { sessionRoutes } from "./sessions";
import { settingsRoutes } from "./settings";
import type { Route } from "./shared";
import { skillRoutes } from "./skills";
import { slackChannelAutomationRoutes } from "./slack-channel-automation";
import { slackChannelIntakeRoutes } from "./slack-channel-intake";
import { testCredentialRoutes } from "./test-credentials";
import { webhookRoutes } from "./webhooks";

export const controlPlaneRoutes: Route[] = [
  ...publicRoutes,
  ...qaRoutes,
  ...authRoutes,
  ...webhookRoutes,
  ...openAIGatewayRoutes,
  ...sessionRoutes,
  ...prInboxRoutes,
  ...activityRoutes,
  ...memoryReviewRoutes,
  ...settingsRoutes,
  ...personalSecretsRoutes,
  ...slackChannelAutomationRoutes,
  ...slackChannelIntakeRoutes,
  ...pagerDutyDispatchRoutes,
  ...integrationRoutes,
  ...cliTokenRoutes,
  ...modelRoutes,
  ...repoRoutes,
  ...repoContextRoutes,
  ...sandboxLayerRoutes,
  ...sandboxLayerAssignmentRoutes,
  ...bootstrapRoutes,
  ...skillRoutes,
  ...businessRoutes,
  ...testCredentialRoutes,
  ...onboardingRoutes,
  ...observabilityRoutes,
  ...adminApprovalRoutes,
  ...adminConsoleRoutes,
  ...adminImpersonationRoutes,
  ...adminSandboxTemplateRoutes,
  ...adminFsmBackfillRoutes,
  ...adminFsmParityCheckRoutes,
  ...adminFsmRow7RepairRoutes,
  ...automationScheduleRoutes,
  ...automationRunRoutes,
  ...automationTriggerRoutes,
  ...githubCheckAutomationRoutes,
];
