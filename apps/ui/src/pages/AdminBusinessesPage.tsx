import { useCallback, useRef, useState } from "react";
import { Link } from "react-router";

import { stringifyError } from "../../../../shared/utils/errors.js";
import { type AdminBusinessSummary, searchAdminBusinesses } from "../api/admin-console";
import { AdminCard, AdminError, AdminLoading, AdminSection, formatRelative } from "../components/AdminLayout";
import { Input, Select } from "../components/ui/Input";
import { ADMIN_SEARCH_DEBOUNCE_MS } from "../constants";
import { useSyncEffect } from "../hooks/useEffects";

export function AdminBusinessesPage() {
  const [businesses, setBusinesses] = useState<AdminBusinessSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [orderBy, setOrderBy] = useState<"name" | "createdAt">("name");
  const requestGenerationRef = useRef(0);

  useSyncEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), ADMIN_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  const reload = useCallback(async (q: string, nextOrderBy: "name" | "createdAt") => {
    const requestGeneration = requestGenerationRef.current + 1;
    requestGenerationRef.current = requestGeneration;
    try {
      const data = await searchAdminBusinesses(nextOrderBy, q || undefined);
      if (requestGenerationRef.current !== requestGeneration) return;
      setBusinesses(data);
      setLoadError(null);
    } catch (err) {
      if (requestGenerationRef.current !== requestGeneration) return;
      setLoadError(stringifyError(err));
    }
  }, []);

  useSyncEffect(() => {
    reload(debouncedQuery, orderBy);
  }, [debouncedQuery, orderBy, reload]);

  if (loadError) return <AdminError message={loadError} />;

  return (
    <AdminSection
      title="Businesses"
      headerClassName="editorial-rise editorial-rise-1"
      action={
        <Select
          value={orderBy}
          onChange={(e) => {
            setOrderBy(e.target.value as "name" | "createdAt");
          }}
          controlSize="sm"
          aria-label="Sort businesses"
        >
          <option value="name">Sort: name</option>
          <option value="createdAt">Sort: newest</option>
        </Select>
      }
    >
      <Input
        type="search"
        placeholder="Search by name or id"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        controlSize="sm"
        className="editorial-rise editorial-rise-2 mb-3"
      />

      <div className="editorial-rise editorial-rise-3">
        {businesses === null ? (
          <AdminLoading />
        ) : businesses.length === 0 ? (
          <AdminCard className="editorial-fade px-4 py-3 text-sm text-text-secondary">No businesses match.</AdminCard>
        ) : (
          <AdminCard className="editorial-fade">
            <ul className="divide-y divide-border">
              {businesses.map((b) => (
                <li key={b.id}>
                  <Link
                    to={`/admin/businesses/${b.id}`}
                    className="row-hover-lift grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-text-primary truncate">{b.name}</div>
                      <div className="text-xs text-text-muted truncate font-mono-tabular">{b.id}</div>
                    </div>
                    <div className="text-xs text-text-secondary tabular-nums">{b.memberCount} members</div>
                    <div className="text-xs text-text-secondary tabular-nums">{b.sessionCount} sessions</div>
                    <div className="text-xs text-text-secondary">last {formatRelative(b.lastSessionAt)}</div>
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
