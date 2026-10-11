import type { CompanyMemoryChannelScopeType } from "../constants/company-memory";
import { listWorkspaceChannels, listWorkspaceInstallMetadataForBusiness } from "../slack/workspaces";
import { deleteChannelIntake, listChannelIntake, upsertChannelIntake } from "./db";

export async function getSlackChannelMemorySettings(db: D1Database, businessId: string) {
  const intake = await listChannelIntake(db, businessId);
  const workspaces = await listWorkspaceInstallMetadataForBusiness(db, businessId);
  return {
    intake,
    workspaces: workspaces.map((workspace) => ({
      teamId: workspace.teamId,
      teamName: workspace.teamName,
      teamDomain: workspace.teamDomain,
      uninstalledAt: workspace.uninstalledAt,
    })),
  };
}

export async function getSlackWorkspaceMemoryChannels(
  db: D1Database,
  input: { businessId: string; teamId: string; tokenEncryptionKey?: string },
) {
  return listWorkspaceChannels(db, { businessId: input.businessId, teamId: input.teamId }, input.tokenEncryptionKey);
}

export async function disableSlackChannelMemoryIntake(
  db: D1Database,
  input: { businessId: string; teamId: string; channelId: string },
): Promise<void> {
  await deleteChannelIntake(db, input.businessId, input.teamId, input.channelId);
}

export async function saveSlackChannelMemoryIntake(
  db: D1Database,
  input: {
    businessId: string;
    teamId: string;
    channelId: string;
    scopeType: CompanyMemoryChannelScopeType;
    scopeId: string | null;
    enabledByUserId: number | null;
  },
) {
  return upsertChannelIntake(db, input);
}
