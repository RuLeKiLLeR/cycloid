import { Fragment, type ReactNode, useState } from "react";

import type { ScheduledRule } from "../../api/automation-schedules";
import { ArtifactChip, Button, Menu, Row, RowGroup, SkeletonRows, StatusChip } from "../ui";
import { formatUtcTimestamp, humanizeCron } from "./format";
import { RunHistory } from "./RunHistory";

// Per-run outcome is only persisted for rules with a Slack delivery target
// (`lastDeliveredAt` / `lastDeliveryError`), so that is the only health signal
// we can honestly show at the row level. Rules without a Slack target simply
// have no delivery chip.
function deliveryChip(rule: ScheduledRule): ReactNode {
  if (!rule.slackChannelId) return null;
  if (rule.lastDeliveryError) {
    return <ArtifactChip kind="slack" tone="error" label="Delivery failed" title={rule.lastDeliveryError} />;
  }
  if (rule.lastDeliveredAt != null) {
    return <ArtifactChip kind="slack" tone="success" label={`Delivered ${formatUtcTimestamp(rule.lastDeliveredAt)}`} />;
  }
  return <ArtifactChip kind="slack" label="No run yet" />;
}

type InstalledAutomationsProps = {
  rules: ScheduledRule[];
  loading: boolean;
  busyAction: { ruleId: string; action: "toggle" | "run" | "duplicate" | "delete" } | null;
  onEdit: (rule: ScheduledRule) => void;
  onToggle: (rule: ScheduledRule) => void;
  onRunNow: (rule: ScheduledRule) => void;
  onDuplicate: (rule: ScheduledRule) => void;
  onDelete: (rule: ScheduledRule) => void;
  nextCursor: string | null;
  loadingMore: boolean;
  loadMoreError: string | null;
  onLoadMore: () => void;
};

export function InstalledAutomations({
  rules,
  loading,
  busyAction,
  onEdit,
  onToggle,
  onRunNow,
  onDuplicate,
  onDelete,
  nextCursor,
  loadingMore,
  loadMoreError,
  onLoadMore,
}: InstalledAutomationsProps) {
  // Single-expansion run history: opening one rule's runs closes the others so
  // the list never turns into a wall of nested panels.
  const [openRunsRuleId, setOpenRunsRuleId] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="px-1 py-2">
        <SkeletonRows rows={3} />
      </div>
    );
  }

  return (
    <RowGroup title="Installed" count={rules.length} contained>
      {rules.map((rule) => {
        const currentAction = busyAction?.ruleId === rule.id ? busyAction.action : null;
        const isBusy = currentAction !== null;
        const runsOpen = openRunsRuleId === rule.id;
        const title = rule.name ?? `${rule.repoOwner}/${rule.repoName}`;
        return (
          <Fragment key={rule.id}>
            <Row
              title={title}
              subtitle={
                // Humanized schedule with the raw cron behind a title attr, so
                // paused rows (which have no "next …" readout) still expose the
                // exact expression on hover.
                <span title={rule.cron}>
                  {rule.repoOwner}/{rule.repoName} · {humanizeCron(rule.cron)}
                </span>
              }
              meta={
                rule.enabled ? (
                  <span className="font-mono-tabular">next {formatUtcTimestamp(rule.nextFireAt)}</span>
                ) : undefined
              }
              chips={
                <>
                  {/* Enabled is the default state and carries no badge; the
                      paused off-state is the notable one. */}
                  {!rule.enabled && <StatusChip status="waiting" label="Paused" />}
                  {deliveryChip(rule)}
                </>
              }
              trailing={
                // Row's trailing slot styles for mono timestamps; these are
                // controls, so reset to the reading face.
                <span className="flex flex-wrap items-center justify-end gap-1 font-sans">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={runsOpen}
                    onClick={() => setOpenRunsRuleId(runsOpen ? null : rule.id)}
                  >
                    {runsOpen ? "Hide runs" : "View runs"}
                  </Button>
                  {rule.canManage ? (
                    <>
                      <Button variant="ghost" size="sm" disabled={isBusy} onClick={() => onRunNow(rule)}>
                        {currentAction === "run" ? "Starting…" : "Run now"}
                      </Button>
                      <Menu
                        label={`Automation actions for ${title}`}
                        items={[
                          { label: "Edit", onSelect: () => onEdit(rule), disabled: isBusy },
                          {
                            label:
                              currentAction === "toggle"
                                ? rule.enabled
                                  ? "Pausing…"
                                  : "Resuming…"
                                : rule.enabled
                                  ? "Pause"
                                  : "Resume",
                            onSelect: () => onToggle(rule),
                            disabled: isBusy,
                          },
                          {
                            label: currentAction === "duplicate" ? "Duplicating…" : "Duplicate",
                            onSelect: () => onDuplicate(rule),
                            disabled: isBusy,
                          },
                          {
                            label: currentAction === "delete" ? "Deleting…" : "Delete",
                            onSelect: () => onDelete(rule),
                            tone: "danger",
                            disabled: isBusy,
                          },
                        ]}
                      />
                    </>
                  ) : (
                    <span className="text-xs text-text-muted">Creator or admin can manage</span>
                  )}
                </span>
              }
            />
            {runsOpen ? <RunHistory ruleId={rule.id} /> : null}
          </Fragment>
        );
      })}

      {nextCursor ? (
        <div className="space-y-2 px-4 py-2">
          <div className="flex justify-center">
            <Button size="sm" onClick={onLoadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
          {loadMoreError ? (
            <p className="editorial-fade text-xs text-error" role="alert">
              {loadMoreError}
            </p>
          ) : null}
        </div>
      ) : null}
    </RowGroup>
  );
}
