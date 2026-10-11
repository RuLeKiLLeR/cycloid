import { useCallback, useState } from "react";
import { Link } from "react-router";

import { stringifyError } from "../../../../shared/utils/errors.js";
import { type AdminUserSummary, searchAdminUsers } from "../api/admin-console";
import { AdminCard, AdminError, AdminLoading, AdminSection, formatRelative } from "../components/AdminLayout";
import { Input } from "../components/ui/Input";
import { ADMIN_SEARCH_DEBOUNCE_MS } from "../constants";
import { useSyncEffect } from "../hooks/useEffects";

export function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUserSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useSyncEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), ADMIN_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  const reload = useCallback(async (q: string) => {
    try {
      const data = await searchAdminUsers(q || undefined);
      setUsers(data);
      setLoadError(null);
    } catch (err) {
      setLoadError(stringifyError(err));
    }
  }, []);

  useSyncEffect(() => {
    reload(debouncedQuery);
  }, [debouncedQuery, reload]);

  return (
    <AdminSection title="Users" headerClassName="editorial-rise editorial-rise-1">
      <Input
        type="search"
        placeholder="Search by login, email, or name"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        controlSize="sm"
        className="editorial-rise editorial-rise-2 mb-3"
      />

      <div className="editorial-rise editorial-rise-3">
        {loadError ? (
          <AdminError message={loadError} />
        ) : users === null ? (
          <AdminLoading />
        ) : users.length === 0 ? (
          <AdminCard className="editorial-fade px-4 py-3 text-sm text-text-secondary">No users match.</AdminCard>
        ) : (
          <AdminCard className="editorial-fade">
            <ul className="divide-y divide-border">
              {users.map((u) => (
                <li key={u.id}>
                  <Link to={`/admin/users/${u.id}`} className="row-hover-lift flex items-center gap-3 px-4 py-3">
                    {u.avatarUrl ? (
                      <img src={u.avatarUrl} alt="" width={32} height={32} className="h-8 w-8 rounded-full" />
                    ) : (
                      <div className="h-8 w-8 rounded-full bg-surface-2" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-text-primary truncate">{u.login}</div>
                      <div className="text-xs text-text-secondary truncate">
                        {u.email ?? "no email"} · {u.businessName ?? u.businessId}
                      </div>
                    </div>
                    <div className="text-xs text-text-secondary">joined {formatRelative(u.createdAt)}</div>
                  </Link>
                </li>
              ))}
            </ul>
          </AdminCard>
        )}
      </div>
    </AdminSection>
  );
}
