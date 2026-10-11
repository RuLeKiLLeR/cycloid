import { useCallback, useState } from "react";
import { Link, useParams } from "react-router";

import { stringifyError } from "../../../../shared/utils/errors.js";
import { type AdminUserDetail, fetchAdminUserDetail } from "../api/admin-console";
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

export function AdminUserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const userId = id ? Number(id) : NaN;
    if (!Number.isSafeInteger(userId)) {
      setLoadError("Invalid user id");
      return;
    }
    try {
      const data = await fetchAdminUserDetail(userId);
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
      <AdminSection title="User">
        <div className="mb-3 flex items-center gap-3">
          {detail.avatarUrl ? (
            <img src={detail.avatarUrl} alt="" width={48} height={48} className="h-12 w-12 rounded-full" />
          ) : (
            <div className="h-12 w-12 rounded-full bg-surface-2" />
          )}
          <div className="min-w-0">
            <div className="text-2xl font-display-tight text-text-primary truncate">{detail.login}</div>
            <div className="text-xs text-text-secondary truncate">
              {detail.email ?? "no email"}
              {detail.name ? ` · ${detail.name}` : ""}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <AdminStat label="Memberships" value={detail.memberships.length} />
          <AdminStat label="Sessions" value={detail.sessionCount} />
          <AdminStat label="Joined" value={formatRelative(detail.createdAt)} />
        </div>
      </AdminSection>

      <AdminSection title="Businesses">
        {detail.memberships.length === 0 ? (
          <AdminCard className="px-4 py-3 text-sm text-text-secondary">No memberships.</AdminCard>
        ) : (
          <AdminCard>
            <ul className="divide-y divide-border">
              {detail.memberships.map((m) => (
                <li key={m.businessId}>
                  <Link
                    to={`/admin/businesses/${m.businessId}`}
                    className="row-hover-lift flex items-center gap-3 px-4 py-3"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-text-primary truncate">{m.businessName}</div>
                      <div className="text-xs text-text-muted font-mono-tabular truncate">{m.businessId}</div>
                    </div>
                    <span className="text-2xs font-mono-tabular text-text-muted">{m.role}</span>
                    <span className="text-xs text-text-secondary">joined {formatRelative(m.joinedAt)}</span>
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
          <Link to={`/admin/sessions?userId=${detail.id}`} className="text-xs text-accent hover:underline">
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
                <AdminSessionRow key={s.sessionId} session={s} showBusiness />
              ))}
            </ul>
          </AdminCard>
        )}
      </AdminSection>
    </div>
  );
}
