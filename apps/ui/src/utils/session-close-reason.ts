export function getArchivedSessionBannerMessage(closeReason: string | null | undefined): string {
  if (closeReason === "pr_merged") {
    return "This session was archived because its pull request was merged. Start a new session to continue.";
  }
  if (closeReason === "pr_closed") {
    return "This session was archived because its pull request was closed. Start a new session to continue.";
  }
  return "This session is archived permanently. Start a new session to continue.";
}

export function getPrOutcomeBadgeLabel(closeReason: string | null | undefined): string | null {
  if (closeReason === "pr_merged") return "merged";
  if (closeReason === "pr_closed") return "closed";
  return null;
}
