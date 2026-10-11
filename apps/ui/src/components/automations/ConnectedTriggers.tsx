import { Link } from "react-router";

import type { ConnectedTrigger } from "../../api/automation-triggers";
import { Badge, buttonClasses } from "../ui";

const STATUS_LABEL: Record<ConnectedTrigger["status"], string> = {
  active: "Active",
  setup_needed: "Setup needed",
  degraded: "Degraded",
  policy_enabled: "Policy enabled",
  policy_disabled: "Policy disabled",
};

export function ConnectedTriggers({
  triggers,
  loading,
  error,
}: {
  triggers: ConnectedTrigger[];
  loading: boolean;
  error: string | null;
}) {
  if (loading) return <p className="text-sm text-text-muted">Loading connected triggers…</p>;
  if (error) return <p className="text-sm text-error">{error}</p>;
  return (
    <div className="divide-y divide-border border border-border">
      {triggers.map((trigger) => (
        <div key={trigger.id} className="grid gap-3 bg-surface-1 p-4 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium text-text-primary">{trigger.label}</h3>
              <Badge tone={trigger.status === "degraded" ? "error" : "default"}>{STATUS_LABEL[trigger.status]}</Badge>
            </div>
            <p className="mt-1 text-sm text-text-muted">{trigger.gesture}</p>
            <p className="mt-1 text-xs text-text-muted">
              {trigger.behavior === "new_session" ? "Starts a new session" : "Continues the PR lifecycle"} ·{" "}
              {trigger.scope}
            </p>
          </div>
          <Link to={trigger.settingsPath} className={buttonClasses({ variant: "secondary", size: "sm" })}>
            Settings
          </Link>
        </div>
      ))}
    </div>
  );
}
