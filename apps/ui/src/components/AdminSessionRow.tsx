import { Link } from "react-router";

import type { AdminSessionRow as AdminSession } from "../api/admin-console";
import { formatRelative } from "./AdminLayout";
import { useLayoutContext } from "./Layout";

function statusBadge(status: string, richStatus: string | null) {
  const label = richStatus ?? status;
  const color =
    status === "active"
      ? "text-accent"
      : richStatus === "failed" || richStatus === "error"
        ? "text-error"
        : "text-text-secondary";
  return <span className={`text-2xs font-mono-tabular ${color}`}>{label}</span>;
}

function getAdminSessionHref(session: AdminSession, viewerUserId: number | null): string | null {
  if (viewerUserId === null || session.ownerUserId === null) return null;
  if (viewerUserId === session.ownerUserId) return `/sessions/${session.sessionId}`;
  return `/admin/support-view?${new URLSearchParams({
    sessionId: session.sessionId,
    targetUserId: String(session.ownerUserId),
  }).toString()}`;
}

export function AdminSessionRow({ session, showBusiness }: { session: AdminSession; showBusiness: boolean }) {
  const { user } = useLayoutContext();
  const viewerUserId = typeof user?.id === "number" ? user.id : null;
  const href = getAdminSessionHref(session, viewerUserId);
  const className = `grid grid-cols-[1fr_auto_auto] items-center gap-3 px-4 py-3${href ? " row-hover-lift" : ""}`;
  const content = (
    <>
      <div className="min-w-0">
        <div className="text-sm text-text-primary truncate">{session.title ?? session.sessionId}</div>
        <div className="text-xs text-text-secondary truncate">
          {session.ownerLogin ?? "unknown user"}
          {showBusiness && session.businessName ? ` · ${session.businessName}` : ""}
          {" · "}
          {formatRelative(session.createdAt)}
        </div>
      </div>
      {statusBadge(session.status, session.richStatus)}
      <span className="text-text-muted">→</span>
    </>
  );

  return (
    <li>
      {href ? (
        <Link to={href} className={className}>
          {content}
        </Link>
      ) : (
        <div className={className}>{content}</div>
      )}
    </li>
  );
}
