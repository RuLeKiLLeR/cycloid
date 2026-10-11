import { Link } from "react-router";

import { useLayoutContext } from "../Layout";
import { buttonClasses } from "../ui";
import { SettingsPageHeader, SettingsSection, SettingsSkeleton } from "./SettingsLayout";
import { SlackAlertAutomationSettings } from "./SlackAlertAutomationSettings";
import { AdminOnlyNotice, useWorkspaceAdminAccess } from "./workspaceSettingsShared";

export function AutomationsSettings() {
  const { user, repos, reposLoaded, settings } = useLayoutContext();
  const access = useWorkspaceAdminAccess();

  return (
    <div className="space-y-10">
      <SettingsPageHeader
        title="Alert triggers"
        description="Rules that start Cycloid sessions from alerts posted to Slack."
        action={
          // Scheduled rules live on the Automations page, not here; the label
          // names the destination so the two surfaces stay distinct.
          <Link to="/automations" className={buttonClasses({ variant: "secondary", size: "sm" })}>
            Open Automations
          </Link>
        }
      />

      {access === "admin" && user ? (
        <SlackAlertAutomationSettings
          businessId={user.businessId}
          repos={repos}
          reposLoaded={reposLoaded}
          defaultRepo={settings?.defaultRepo}
        />
      ) : (
        <SettingsSection
          title="Slack alert triggers"
          description="Start Cycloid sessions automatically from Datadog or Sentry alerts posted to Slack."
        >
          <div className="py-5">
            {access === "loading" ? (
              <SettingsSkeleton rows={2} showHeader={false} />
            ) : (
              <AdminOnlyNotice message="Ask a workspace admin to set up Slack alert triggers." />
            )}
          </div>
        </SettingsSection>
      )}
    </div>
  );
}
