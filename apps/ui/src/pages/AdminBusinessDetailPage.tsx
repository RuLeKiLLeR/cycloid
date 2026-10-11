import { useCallback, useState } from "react";
import { Link, useParams } from "react-router";

import { stringifyError } from "../../../../shared/utils/errors.js";
import { type AdminBusinessDetail, fetchAdminBusinessDetail } from "../api/admin-console";
import {
  AdminCard,
  AdminError,
  AdminLoading,
  AdminSection,
  AdminStat,
  formatRelative,
} from "../components/AdminLayout";
import { AdminSessionRow } from "../components/AdminSessionRow";
import { useMountEffect } from "../hooks/useEffects";

export function AdminBusinessDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<AdminBusinessDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!id) return;
    try {
      const data = await fetchAdminBusinessDetail(id);
      setDetail(data);
      setLoadError(null);
    } catch (err) {
      setLoadError(stringifyError(err));
    }
  }, [id]);

  useMountEffect(() => {
    reload();
  });

  // Entrance beats -1/-2 don't apply here: header/toolbar/content all mount
  // post-load, so the page rides the layout beats plus one content beat (-3),
  // and the loaded detail fades in as a single container (playbook #2).
  if (loadError) {
    return (
      <div className="editorial-rise editorial-rise-3">
        <AdminError message={loadError} />
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="editorial-rise editorial-rise-3">
        <AdminLoading />
      </div>
    );
  }

  return (
    <div className="editorial-fade">
      <AdminSection title="Business">
        <div className="mb-3">
          <div className="text-2xl font-display-tight text-text-primary">{detail.name}</div>
          <div className="text-xs text-text-muted font-mono-tabular">{detail.id}</div>
          <div className="text-xs text-text-secondary mt-1">Created {formatRelative(detail.createdAt)}</div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <AdminStat label="Members" value={detail.memberCount} />
          <AdminStat label="Sessions" value={detail.sessionCount} />
          <AdminStat label="Last session" value={formatRelative(detail.lastSessionAt)} />
        </div>
      </AdminSection>

      <AdminSection title={`Members (${detail.members.length})`}>
        {detail.members.length === 0 ? (
          <AdminCard className="px-4 py-3 text-sm text-text-secondary">No members.</AdminCard>
        ) : (
          <AdminCard>
            <ul className="divide-y divide-border">
              {detail.members.map((m) => (
                <li key={m.userId}>
                  <Link to={`/admin/users/${m.userId}`} className="row-hover-lift flex items-center gap-3 px-4 py-3">
                    {m.avatarUrl ? (
                      <img src={m.avatarUrl} alt="" width={32} height={32} className="h-8 w-8 rounded-full" />
                    ) : (
                      <div className="h-8 w-8 rounded-full bg-surface-2" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-text-primary truncate">{m.login}</div>
                      <div className="text-xs text-text-secondary truncate">{m.email ?? "no email"}</div>
                    </div>
                    <span className="text-2xs font-mono-tabular text-text-muted">{m.role}</span>
                    <span className="text-xs text-text-secondary">last {formatRelative(m.lastSessionAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </AdminCard>
        )}
      </AdminSection>

      <AdminSection
        title="Recent sessions"
        action={
          <Link to={`/admin/sessions?businessId=${detail.id}`} className="text-xs text-accent hover:underline">
            See all →
          </Link>
        }
      >
        {detail.recentSessions.length === 0 ? (
          <AdminCard className="px-4 py-3 text-sm text-text-secondary">No sessions.</AdminCard>
        ) : (
          <AdminCard>
            <ul className="divide-y divide-border">
              {detail.recentSessions.map((s) => (
                <AdminSessionRow key={s.sessionId} session={s} showBusiness={false} />
              ))}
            </ul>
          </AdminCard>
        )}
      </AdminSection>
    </div>
  );
}
