import { useCallback, useState } from "react";
import { useSearchParams } from "react-router";

import { stringifyError } from "../../../../shared/utils/errors.js";
import { type AdminSessionRow as AdminSession, fetchAdminSessions, type SessionFilters } from "../api/admin-console";
import { AdminCard, AdminError, AdminLoading, AdminSection } from "../components/AdminLayout";
import { AdminSessionRow } from "../components/AdminSessionRow";
import { Select } from "../components/ui/Input";
import { useSyncEffect } from "../hooks/useEffects";

function parseStatus(raw: string | null): SessionFilters["status"] {
  if (raw === "active" || raw === "closed" || raw === "archived") return raw;
  return undefined;
}

export function AdminSessionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const businessIdParam = searchParams.get("businessId") ?? "";
  const userIdParam = searchParams.get("userId") ?? "";
  const statusParam = searchParams.get("status") ?? "";

  const parsedUserId = userIdParam ? Number(userIdParam) : undefined;
  const userIdInvalid = userIdParam !== "" && !(Number.isSafeInteger(parsedUserId) && (parsedUserId as number) > 0);

  const reload = useCallback(async () => {
    if (userIdInvalid) {
      setSessions([]);
      setLoadError(null);
      return;
    }
    const filters: SessionFilters = {
      businessId: businessIdParam || undefined,
      userId: parsedUserId,
      status: parseStatus(statusParam),
      limit: 100,
    };
    try {
      const data = await fetchAdminSessions(filters);
      setSessions(data);
      setLoadError(null);
    } catch (err) {
      setLoadError(stringifyError(err));
    }
  }, [businessIdParam, parsedUserId, statusParam, userIdInvalid]);

  useSyncEffect(() => {
    reload();
  }, [reload]);

  const updateParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  return (
    <AdminSection title="Sessions" headerClassName="editorial-rise editorial-rise-1">
      <div className="editorial-rise editorial-rise-2 mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap gap-2 text-xs text-text-secondary">
          {businessIdParam ? (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 py-1 pl-2 pr-1 font-mono-tabular">
              <span>Business {businessIdParam}</span>
              <button
                type="button"
                onClick={() => updateParam("businessId", "")}
                className="flex h-5 w-5 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary"
                aria-label="Clear business filter"
              >
                <XMark className="h-3 w-3" />
              </button>
            </span>
          ) : null}
          {userIdParam ? (
            <span
              className={`inline-flex items-center gap-1.5 rounded-md border py-1 pl-2 pr-1 font-mono-tabular ${
                userIdInvalid ? "border-error text-error" : "border-border bg-surface-1"
              }`}
            >
              <span>User {userIdParam}</span>
              <button
                type="button"
                onClick={() => updateParam("userId", "")}
                className="flex h-5 w-5 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary"
                aria-label="Clear user filter"
              >
                <XMark className="h-3 w-3" />
              </button>
            </span>
          ) : null}
          {!businessIdParam && !userIdParam ? <span>All admin-visible sessions</span> : null}
        </div>
        <Select
          value={statusParam}
          onChange={(e) => updateParam("status", e.target.value)}
          controlSize="sm"
          aria-label="Status filter"
        >
          <option value="">All statuses</option>
          <option value="active">active</option>
          <option value="closed">closed</option>
          <option value="archived">archived</option>
        </Select>
      </div>
      {userIdInvalid && (
        <div className="editorial-fade mb-3 text-xs text-error">User id must be a positive integer.</div>
      )}

      <div className="editorial-rise editorial-rise-3">
        {loadError ? (
          <AdminError message={loadError} />
        ) : sessions === null ? (
          <AdminLoading />
        ) : sessions.length === 0 ? (
          <AdminCard className="editorial-fade px-4 py-3 text-sm text-text-secondary">No sessions match.</AdminCard>
        ) : (
          <AdminCard className="editorial-fade">
            <ul className="divide-y divide-border">
              {sessions.map((s) => (
                <AdminSessionRow key={s.sessionId} session={s} showBusiness />
              ))}
            </ul>
          </AdminCard>
        )}
      </div>
    </AdminSection>
  );
}

function XMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" fill="none" aria-hidden className={className}>
      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
