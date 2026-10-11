import { type MouseEvent } from "react";

import type { PrInboxItem } from "../../api/pr-inbox";
import { safeHttpsUrl } from "../../utils/safe-url";
import { compactTimeAgo } from "../../utils/session-grouping";
import { GithubIcon } from "../icons";
import { ArtifactChip, CopyButton, IconButton, Row, StatusChip } from "../ui";
import { cycloidDoneChip } from "./bucket-config";

export function PrRow({ item }: { item: PrInboxItem }) {
  const title = item.title?.trim() || "Untitled session";
  const repoLabel =
    item.repoOwner && item.repoName ? `${item.repoOwner}/${item.repoName}` : (item.repoName ?? item.repoOwner ?? "—");
  const doneChip = cycloidDoneChip(item.cycloidDone);
  const prUrl = safeHttpsUrl(item.prUrl);
  const closed = item.bucket === "closed";
  // Rows render inside status-labeled bucket groups, so the bucket itself is
  // already stated by the group header. The leading rail only carries sub-state
  // that varies per row (Working / Needs attention); settled rows stay empty.
  // Closed PRs suppress only the stale liveness signal — a session still
  // "working" on a closed PR is noise, but a needs-attention outcome is a
  // deliberate terminal flag and must stay visible.
  const showDoneChip = doneChip.label !== "Done" && !(closed && item.cycloidDone.state === "working");

  const openOnGithub = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (prUrl) window.open(prUrl, "_blank", "noreferrer");
  };

  // Whole-row navigation via the Row primitive; secondary actions (branch copy,
  // GitHub) live in the chips slot and stop propagation themselves.
  return (
    <Row
      href={`/sessions/${item.sessionId}?artifact=pr`}
      ariaLabel={`Open PR session: ${title}`}
      leading={
        <span className="w-28">
          {showDoneChip && (
            <StatusChip
              status={item.cycloidDone.state === "working" ? "running" : "waiting"}
              label={doneChip.label}
              variant="dot"
            />
          )}
        </span>
      }
      title={title}
      subtitle={repoLabel}
      meta={item.prNumber != null ? <span className="numeral">#{item.prNumber}</span> : undefined}
      chips={
        <>
          {item.linkedTicket?.source === "slack" && (
            <ArtifactChip kind="slack" title={`Slack thread in ${item.linkedTicket.channel}`} />
          )}
          {item.headBranch && (
            <CopyButton
              value={item.headBranch}
              label={`Copy branch ${item.headBranch}`}
              revealIconOnHover
              className="hidden max-w-44 text-xs lg:inline-flex"
            >
              <span className="truncate font-mono-tabular">{item.headBranch}</span>
            </CopyButton>
          )}
          {prUrl && (
            <IconButton label="Open PR on GitHub" onClick={openOnGithub}>
              <GithubIcon />
            </IconButton>
          )}
        </>
      }
      trailing={compactTimeAgo(item.updatedAt)}
    />
  );
}
