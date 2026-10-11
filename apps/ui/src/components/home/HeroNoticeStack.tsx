import { type ReactNode, useId, useState } from "react";
import { Link } from "react-router";

import type { SsoOrg } from "../../../../../shared/types/bootstrap";
import type { DisconnectedPersonalIntegrationWarning } from "../../utils/integration-disconnect-warning";
import { ChevronDownIcon, WarningIcon } from "../icons";
import { SsoOrgsNotice } from "../SsoOrgsNotice";
import { buttonClasses } from "../ui";

type HeroNoticeStackProps = {
  ssoOrgs: SsoOrg[];
  onRefreshRepos: () => void | Promise<void>;
  refreshingRepos: boolean;
  missingDefaultRepo: boolean;
  missingModelKey: boolean;
  disconnectedIntegrationWarnings: DisconnectedPersonalIntegrationWarning[];
};

type Notice = {
  summary: string;
  summaryContent: ReactNode;
  liveAnnouncement: string | null;
  render: () => ReactNode;
};

export function HeroNoticeStack({
  ssoOrgs,
  onRefreshRepos,
  refreshingRepos,
  missingDefaultRepo,
  missingModelKey,
  disconnectedIntegrationWarnings,
}: HeroNoticeStackProps) {
  const notices: Notice[] = [];

  if (ssoOrgs.length > 0) {
    const summary =
      ssoOrgs.length === 1
        ? ssoOrgs[0]?.login
          ? `${ssoOrgs[0].login} SSO`
          : "Organization needs SSO"
        : `${ssoOrgs.length} orgs need SSO`;
    notices.push({
      summary,
      summaryContent:
        ssoOrgs.length === 1 && ssoOrgs[0]?.login ? (
          <>
            <span className="font-mono-tabular text-text-primary">{ssoOrgs[0].login}</span> SSO
          </>
        ) : (
          summary
        ),
      liveAnnouncement: null,
      render: () => <SsoOrgsNotice ssoOrgs={ssoOrgs} onRefresh={onRefreshRepos} refreshing={refreshingRepos} />,
    });
  }

  const setupCount = (missingDefaultRepo ? 1 : 0) + (missingModelKey ? 1 : 0);
  if (setupCount > 0) {
    notices.push({
      summary: setupCount === 1 ? "1 setup step" : `${setupCount} setup steps`,
      summaryContent: setupCount === 1 ? "1 setup step" : `${setupCount} setup steps`,
      liveAnnouncement: null,
      render: () => <SetupIncompleteNotice missingDefaultRepo={missingDefaultRepo} missingModelKey={missingModelKey} />,
    });
  }

  if (disconnectedIntegrationWarnings.length > 0) {
    notices.push({
      summary:
        disconnectedIntegrationWarnings.length === 1
          ? `${disconnectedIntegrationWarnings[0]!.label} disconnected`
          : `${disconnectedIntegrationWarnings.length} integrations disconnected`,
      summaryContent:
        disconnectedIntegrationWarnings.length === 1
          ? `${disconnectedIntegrationWarnings[0]!.label} disconnected`
          : `${disconnectedIntegrationWarnings.length} integrations disconnected`,
      liveAnnouncement:
        "The following warning needs attention: " +
        (disconnectedIntegrationWarnings.length === 1
          ? `${disconnectedIntegrationWarnings[0]!.label} disconnected`
          : `${disconnectedIntegrationWarnings.length} integrations disconnected`),
      render: () => <IntegrationDisconnectNotice warnings={disconnectedIntegrationWarnings} />,
    });
  }

  if (notices.length === 0) return null;
  if (notices.length === 1) return notices[0]!.render();

  return <CollapsibleNotices notices={notices} />;
}

function CollapsibleNotices({ notices }: { notices: Notice[] }) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const summary = `${notices.length} notices need attention - ${notices.map((notice) => notice.summary).join(", ")}`;
  const liveAnnouncement = notices.find((notice) => notice.liveAnnouncement)?.liveAnnouncement;

  return (
    <>
      {!expanded && (
        <span role="status" className="sr-only">
          {summary}
        </span>
      )}
      {!expanded && liveAnnouncement && (
        <span role="alert" className="sr-only">
          {liveAnnouncement}
        </span>
      )}
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((current) => !current)}
        className="editorial-fade flex w-full items-center gap-2 border border-warning-soft-border bg-warning-soft px-3 py-2 text-left text-sm text-text-secondary"
      >
        <WarningIcon className="size-4 shrink-0 text-text-primary" />
        <span className="min-w-0 flex-1 truncate">
          {summary.split(" - ")[0]} -{" "}
          {notices.map((notice, index) => (
            <span key={notice.summary}>
              {index > 0 && ", "}
              {notice.summaryContent}
            </span>
          ))}
        </span>
        <ChevronDownIcon
          className={`size-4 shrink-0 text-text-muted transition-transform duration-[--duration-fast] ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded && (
        <div id={panelId} className="flex flex-col gap-3">
          {notices.map((notice) => (
            <div key={notice.summary}>{notice.render()}</div>
          ))}
        </div>
      )}
    </>
  );
}

function SetupIncompleteNotice({
  missingDefaultRepo,
  missingModelKey,
}: {
  missingDefaultRepo: boolean;
  missingModelKey: boolean;
}) {
  const count = (missingDefaultRepo ? 1 : 0) + (missingModelKey ? 1 : 0);
  const label = count === 1 ? "1 setup step left" : `${count} setup steps left`;

  return (
    <div className="editorial-fade flex justify-center">
      <Link
        to="/settings/preferences"
        className="inline-flex items-center gap-2 border border-warning-soft-border bg-warning-soft px-3 py-1 text-xs text-text-secondary transition-colors duration-[--duration-fast] hover:border-border-hover"
      >
        <WarningIcon className="size-3.5 shrink-0 text-text-primary" />
        <span>{label}</span>
        <span aria-hidden className="text-text-muted">
          →
        </span>
      </Link>
    </div>
  );
}

function IntegrationDisconnectNotice({ warnings }: { warnings: DisconnectedPersonalIntegrationWarning[] }) {
  const warningLabel =
    warnings.length === 1
      ? warnings[0]?.label
      : warnings
          .map((warning) => `${warning.label} disconnected`)
          .filter(Boolean)
          .join(", ");
  if (!warningLabel) return null;

  return (
    <div
      role="alert"
      className="editorial-fade flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2 border border-warning-soft-border bg-warning-soft px-3 py-2"
    >
      <p className="flex min-w-0 items-center gap-2 text-sm text-text-secondary">
        <WarningIcon className="size-4 shrink-0 text-text-primary" />
        <span className="truncate">{warnings.length === 1 ? `${warningLabel} disconnected` : warningLabel}</span>
      </p>
      <Link to="/settings/integrations" className={buttonClasses({ size: "sm", className: "shrink-0" })}>
        Reconnect
      </Link>
    </div>
  );
}
