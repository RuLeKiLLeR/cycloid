import type React from "react";
import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { stringifyError } from "../../../../shared/utils/errors.js";
import {
  type ImpersonationDirectoryBusiness,
  type ImpersonationDirectoryUser,
  type ImpersonationSearchSession,
  listImpersonationDirectory,
  searchImpersonationTargets,
  startImpersonation,
} from "../api/admin-impersonation";
import { Button, Input, Textarea } from "../components/ui";
import { useSyncEffect } from "../hooks/useEffects";

// Debounce before firing the impersonation-target search query.
const SEARCH_DEBOUNCE_MS = 250;

type Target =
  { kind: "user"; user: ImpersonationDirectoryUser } | { kind: "session"; session: ImpersonationSearchSession };

function targetUserId(target: Target | null): number | null {
  if (!target) return null;
  return target.kind === "user" ? target.user.id : target.session.owner.id;
}

function targetSessionId(target: Target | null): string | null {
  if (!target) return null;
  return target.kind === "user" ? null : target.session.sessionId;
}

function displayUser(user: { login: string | null; name: string | null; email?: string | null }): string {
  return user.login ?? user.name ?? user.email ?? "Unknown user";
}

function businessLabel(businessName: string | null, businessId: string): string {
  return businessName ? `${businessName} (${businessId})` : businessId;
}

function sessionLabel(session: { sessionId: string; title: string | null }): string {
  return session.title?.trim() || session.sessionId.slice(0, 8);
}

type SupportViewLaunch =
  { kind: "none" } | { kind: "invalid"; error: string } | { kind: "session"; sessionId: string; targetUserId: number };

function parseSupportViewLaunch(searchParams: URLSearchParams): SupportViewLaunch {
  const sessionId = searchParams.get("sessionId")?.trim() ?? "";
  const targetUserIdRaw = searchParams.get("targetUserId");
  if (!sessionId && !targetUserIdRaw) return { kind: "none" };
  const targetUserId = Number(targetUserIdRaw);
  if (!sessionId || !Number.isSafeInteger(targetUserId) || targetUserId <= 0) {
    return { kind: "invalid", error: "Invalid admin-console support-view link" };
  }
  return { kind: "session", sessionId, targetUserId };
}

export function SupportViewAdminPage() {
  const [searchParams] = useSearchParams();
  const launch = useMemo(() => parseSupportViewLaunch(searchParams), [searchParams]);
  const [sessionQuery, setSessionQuery] = useState(() => (launch.kind === "session" ? launch.sessionId : ""));
  const [customerFilter, setCustomerFilter] = useState("");
  const [customerDropdownOpen, setCustomerDropdownOpen] = useState(false);
  const [businesses, setBusinesses] = useState<ImpersonationDirectoryBusiness[]>([]);
  const [sessions, setSessions] = useState<ImpersonationSearchSession[]>([]);
  const [selected, setSelected] = useState<Target | null>(null);
  const [reason, setReason] = useState("");
  const [directoryLoading, setDirectoryLoading] = useState(true);
  const [directoryTruncated, setDirectoryTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoLaunchStarted = useRef(false);

  useSyncEffect(() => {
    let cancelled = false;
    setDirectoryLoading(true);
    listImpersonationDirectory()
      .then((result) => {
        if (cancelled) return;
        setBusinesses(result.businesses);
        setDirectoryTruncated(result.truncated);
      })
      .catch((err) => {
        if (cancelled) return;
        setBusinesses([]);
        setDirectoryTruncated(false);
        setError(stringifyError(err));
      })
      .finally(() => {
        if (!cancelled) setDirectoryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const customerOptions = useMemo(() => businesses.flatMap((business) => business.users), [businesses]);
  const filteredBusinesses = useMemo(() => {
    const normalizedFilter = customerFilter.trim().toLowerCase();
    if (!normalizedFilter) return businesses;

    return businesses
      .map((business) => ({
        ...business,
        users: business.users.filter((user) => {
          const fields = [
            displayUser(user),
            user.name ?? "",
            user.businessName ?? "",
            user.businessId,
            String(user.id),
          ];
          return fields.some((field) => field.toLowerCase().includes(normalizedFilter));
        }),
      }))
      .filter((business) => business.users.length > 0);
  }, [businesses, customerFilter]);
  const filteredCustomerCount = useMemo(
    () => filteredBusinesses.reduce((count, business) => count + business.users.length, 0),
    [filteredBusinesses],
  );

  useSyncEffect(() => {
    const trimmed = sessionQuery.trim();
    if (trimmed.length < 2) {
      setSessions([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      searchImpersonationTargets(trimmed)
        .then((result) => {
          if (cancelled) return;
          setSessions(result.sessions);
        })
        .catch((err) => {
          if (cancelled) return;
          setSessions([]);
          setError(stringifyError(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionQuery]);

  useSyncEffect(() => {
    if (launch.kind === "invalid") {
      setError(launch.error);
      return;
    }
    if (launch.kind !== "session" || autoLaunchStarted.current) return;

    autoLaunchStarted.current = true;
    setStarting(true);
    setError(null);
    startImpersonation({
      targetUserId: launch.targetUserId,
      reason: `Open session ${launch.sessionId} from admin console`,
    })
      .then(() => {
        window.location.assign(`/sessions/${launch.sessionId}`);
      })
      .catch((err) => {
        setError(stringifyError(err));
        setStarting(false);
      });
  }, [launch]);

  async function submit() {
    const userId = targetUserId(selected);
    if (!userId) {
      setError("Choose a customer to view");
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const sessionId = targetSessionId(selected);
      await startImpersonation({ targetUserId: userId, reason: reason.trim() });
      window.location.assign(sessionId ? `/sessions/${sessionId}` : "/");
    } catch (err) {
      setError(stringifyError(err));
      setStarting(false);
    }
  }

  const selectedUserId = targetUserId(selected);
  const selectedCustomer = selected?.kind === "user" ? selected.user : null;
  const canSubmit = Boolean(selectedUserId && !starting);
  const submitDisabledReason = !selectedUserId ? "Choose a customer to view" : undefined;

  function closeCustomerDropdown() {
    setCustomerDropdownOpen(false);
    setCustomerFilter("");
  }

  function selectCustomer(user: ImpersonationDirectoryUser) {
    setSelected({ kind: "user", user });
    closeCustomerDropdown();
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="editorial-rise editorial-rise-1 border-b border-border pb-5">
        <p className="eyebrow mb-3">Internal</p>
        <h1 className="font-display-tight text-3xl text-text-primary">Support view</h1>
      </div>

      {error && (
        <div className="editorial-fade rounded-lg border border-error-soft-border bg-error-soft px-4 py-3 text-sm text-error">
          {error}
        </div>
      )}

      <section className="editorial-rise editorial-rise-3 grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <label className="flex flex-col gap-2 text-sm font-medium text-text-primary">
            Search by session ID
            <input
              type="search"
              value={sessionQuery}
              onChange={(event) => setSessionQuery(event.target.value)}
              placeholder="Paste a session ID"
              className="control-lg rounded-lg border border-border bg-surface-1 px-3 text-sm text-text-primary outline-none transition-colors focus:border-accent"
            />
          </label>

          <div className="grid gap-4 md:grid-cols-2">
            <ResultColumn title="Customers" empty={false}>
              <div
                className="relative"
                onBlur={(event) => {
                  const next = event.relatedTarget;
                  if (next instanceof Node && event.currentTarget.contains(next)) return;
                  closeCustomerDropdown();
                }}
              >
                <label className="sr-only" htmlFor="support-view-customer-filter">
                  Filter customers
                </label>
                <Input
                  id="support-view-customer-filter"
                  type="search"
                  role="combobox"
                  aria-expanded={customerDropdownOpen}
                  aria-controls="support-view-customer-menu"
                  value={customerDropdownOpen ? customerFilter : selectedCustomer ? displayUser(selectedCustomer) : ""}
                  onFocus={() => setCustomerDropdownOpen(true)}
                  onClick={() => setCustomerDropdownOpen(true)}
                  onChange={(event) => {
                    setCustomerDropdownOpen(true);
                    setCustomerFilter(event.target.value);
                  }}
                  disabled={directoryLoading}
                  placeholder={directoryLoading ? "Loading customers…" : selectedCustomer ? "" : "Select customer"}
                  controlSize="lg"
                  className="rounded-lg bg-surface-1 pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Toggle customer menu"
                  disabled={directoryLoading}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => (customerDropdownOpen ? closeCustomerDropdown() : setCustomerDropdownOpen(true))}
                  className="absolute right-2 top-2 control-sm min-w-[36px] px-0"
                >
                  {customerDropdownOpen ? "^" : "v"}
                </Button>
                {customerDropdownOpen && (
                  <div
                    id="support-view-customer-menu"
                    role="listbox"
                    className="menu-pop absolute z-30 mt-2 max-h-[24rem] w-full overflow-y-auto rounded-lg border border-border bg-surface-0 py-1 shadow-xl"
                  >
                    {directoryLoading ? (
                      <div className="px-3 py-4 text-sm text-text-muted">Loading customers…</div>
                    ) : filteredCustomerCount === 0 ? (
                      <div className="px-3 py-4 text-sm text-text-muted">
                        {customerFilter.trim() ? "No customers match" : "No customers"}
                      </div>
                    ) : (
                      filteredBusinesses.map((business) => (
                        <div key={business.id} className="border-b border-border last:border-b-0">
                          <div className="sticky top-0 z-10 border-b border-border bg-surface-2 px-3 py-2 text-xs font-mono-tabular text-text-muted">
                            {businessLabel(business.name, business.id)}
                          </div>
                          <div className="divide-y divide-border">
                            {business.users.map((user) => {
                              const active = selected?.kind === "user" && selected.user.id === user.id;
                              return (
                                <Button
                                  key={user.id}
                                  type="button"
                                  role="option"
                                  aria-selected={active}
                                  variant="ghost"
                                  size="lg"
                                  onClick={() => selectCustomer(user)}
                                  className={`w-full flex-col items-start justify-center rounded-none border-0 px-3 text-left ${
                                    active
                                      ? "bg-accent-soft text-text-primary"
                                      : "text-text-secondary hover:bg-surface-2 hover:text-text-primary"
                                  }`}
                                >
                                  <span className="truncate text-sm font-medium">{displayUser(user)}</span>
                                  {user.name && user.name !== user.login ? (
                                    <span className="mt-0.5 truncate text-xs text-text-muted">{user.name}</span>
                                  ) : null}
                                </Button>
                              );
                            })}
                          </div>
                        </div>
                      ))
                    )}
                    {!directoryLoading && customerOptions.length > 0 && (
                      <div className="border-t border-border px-3 py-2 text-xs text-text-muted">
                        Showing {filteredCustomerCount} of {customerOptions.length} customers
                      </div>
                    )}
                  </div>
                )}
              </div>
              {directoryTruncated && (
                <div className="editorial-fade rounded-lg border border-warning-soft-border bg-warning-soft px-3 py-2 text-xs text-warning">
                  Customer list is limited. Use a session ID if the customer is not listed.
                </div>
              )}
            </ResultColumn>

            <ResultColumn title="Sessions" empty={!loading && sessionQuery.trim().length >= 2 && sessions.length === 0}>
              {sessions.map((session) => {
                const active = selected?.kind === "session" && selected.session.sessionId === session.sessionId;
                return (
                  <button
                    key={session.sessionId}
                    type="button"
                    onClick={() => setSelected({ kind: "session", session })}
                    className={`btn-press control-lg w-full rounded-lg border px-3 text-left ${
                      active
                        ? "border-accent bg-accent-soft text-text-primary"
                        : "border-border bg-surface-1 text-text-secondary hover:border-border-hover hover:text-text-primary"
                    }`}
                  >
                    <span className="block truncate text-sm font-medium">{sessionLabel(session)}</span>
                    <span className="mt-1 block truncate text-xs text-text-muted">
                      @{displayUser(session.owner)} - {businessLabel(session.businessName, session.businessId)}
                    </span>
                    <span className="mt-1 block font-mono text-xs text-text-muted">{session.sessionId}</span>
                  </button>
                );
              })}
            </ResultColumn>
          </div>

          {loading && <div className="text-sm text-text-muted">Searching…</div>}
        </div>

        <aside className="flex flex-col gap-4 border-l border-border pl-5">
          <div>
            <p className="mb-1 text-xs font-mono-tabular text-text-muted">Selected</p>
            <div className="min-h-[4rem] rounded-lg border border-border bg-surface-1 px-3 py-3 text-sm text-text-secondary">
              {selected ? (
                selected.kind === "user" ? (
                  <>
                    <div className="font-medium text-text-primary">{displayUser(selected.user)}</div>
                    <div className="mt-1 text-xs text-text-muted">
                      {businessLabel(selected.user.businessName, selected.user.businessId)}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="font-medium text-text-primary">{displayUser(selected.session.owner)}</div>
                    <div className="mt-1 text-xs text-text-muted">{sessionLabel(selected.session)}</div>
                  </>
                )
              ) : (
                "None"
              )}
            </div>
          </div>

          <label htmlFor="support-view-reason" className="flex flex-col gap-2 text-sm font-medium text-text-primary">
            Reason
            <Textarea
              id="support-view-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={5}
              placeholder="Debugging customer session…"
              className="resize-none rounded-lg bg-surface-1 text-sm"
            />
          </label>

          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            title={submitDisabledReason}
            className="btn-press control-lg inline-flex items-center justify-center rounded-lg bg-accent px-5 text-sm font-medium text-surface-0 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {starting ? "Starting…" : "Start support view"}
          </button>
        </aside>
      </section>
    </div>
  );
}

function ResultColumn({ title, empty, children }: { title: string; empty: boolean; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <h2 className="mb-2 text-xs font-mono-tabular text-text-muted">{title}</h2>
      <div className="flex flex-col gap-2">
        {children}
        {empty && <div className="rounded-lg border border-border px-3 py-4 text-sm text-text-muted">No results</div>}
      </div>
    </section>
  );
}
