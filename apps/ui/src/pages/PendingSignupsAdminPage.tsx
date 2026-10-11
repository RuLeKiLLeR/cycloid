import { useCallback, useState } from "react";

import { stringifyError } from "../../../../shared/utils/errors.js";
import {
  type AdminBusiness,
  approvePendingSignup,
  denyPendingSignup,
  fetchAdminBusinesses,
  fetchPendingSignups,
  type PendingSignup,
} from "../api/admin-approvals";
import { SpinnerIcon } from "../components/icons";
import { Select } from "../components/ui";
import { useMountEffect } from "../hooks/useEffects";

type RowState = { kind: "idle" } | { kind: "approving" } | { kind: "denying" } | { kind: "error"; message: string };

type ApprovalForm = {
  target: "new" | "existing";
  newBusinessName: string;
  existingBusinessId: string;
  role: "admin" | "member";
};

const DEFAULT_FORM: ApprovalForm = {
  target: "new",
  newBusinessName: "",
  existingBusinessId: "",
  role: "member",
};

export function PendingSignupsAdminPage() {
  const [signups, setSignups] = useState<PendingSignup[] | null>(null);
  const [businesses, setBusinesses] = useState<AdminBusiness[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forms, setForms] = useState<Record<number, ApprovalForm>>({});
  const [rowStates, setRowStates] = useState<Record<number, RowState>>({});

  const reload = useCallback(async () => {
    try {
      const [pending, biz] = await Promise.all([fetchPendingSignups(), fetchAdminBusinesses()]);
      setSignups(pending);
      setBusinesses(biz);
      setLoadError(null);
    } catch (err) {
      setLoadError(stringifyError(err));
    }
  }, []);

  useMountEffect(() => {
    reload();
  });

  const getForm = (id: number): ApprovalForm => forms[id] ?? DEFAULT_FORM;

  const setForm = (id: number, patch: Partial<ApprovalForm>) =>
    setForms((prev) => ({ ...prev, [id]: { ...(prev[id] ?? DEFAULT_FORM), ...patch } }));

  const setRow = (id: number, state: RowState) => setRowStates((prev) => ({ ...prev, [id]: state }));

  const handleApprove = async (signup: PendingSignup) => {
    const currentState = rowStates[signup.id] ?? { kind: "idle" };
    if (currentState.kind === "approving" || currentState.kind === "denying") return;
    const form = getForm(signup.id);
    setRow(signup.id, { kind: "approving" });
    try {
      if (form.target === "new") {
        const name = form.newBusinessName.trim();
        if (!name) {
          setRow(signup.id, { kind: "error", message: "Enter a business name" });
          return;
        }
        await approvePendingSignup(signup.id, { kind: "new", businessName: name, role: form.role });
      } else {
        if (!form.existingBusinessId) {
          setRow(signup.id, { kind: "error", message: "Pick a business" });
          return;
        }
        await approvePendingSignup(signup.id, {
          kind: "existing",
          businessId: form.existingBusinessId,
          role: form.role,
        });
      }
      setSignups((prev) => prev?.filter((item) => item.id !== signup.id) ?? prev);
      await reload();
      setRow(signup.id, { kind: "idle" });
    } catch (err) {
      setRow(signup.id, { kind: "error", message: stringifyError(err) });
    }
  };

  const handleDeny = async (signup: PendingSignup) => {
    const currentState = rowStates[signup.id] ?? { kind: "idle" };
    if (currentState.kind === "approving" || currentState.kind === "denying") return;
    setRow(signup.id, { kind: "denying" });
    try {
      await denyPendingSignup(signup.id);
      setSignups((prev) => prev?.filter((item) => item.id !== signup.id) ?? prev);
      await reload();
      setRow(signup.id, { kind: "idle" });
    } catch (err) {
      setRow(signup.id, { kind: "error", message: stringifyError(err) });
    }
  };

  return (
    <div>
      <div className="editorial-rise editorial-rise-1 mb-6">
        <h2 className="text-xs font-mono-tabular text-text-muted">Pending signups</h2>
      </div>

      {loadError && (
        <div className="editorial-fade mb-6 rounded-md border border-border bg-surface-1 px-4 py-3 text-sm text-text-secondary">
          {loadError}
        </div>
      )}

      <div className="editorial-rise editorial-rise-3">
        {signups === null && !loadError && <div className="text-sm text-text-secondary">Loading…</div>}

        {signups?.length === 0 && <div className="editorial-fade text-sm text-text-secondary">No pending signups.</div>}

        {signups && signups.length > 0 && (
          <div className="editorial-fade flex flex-col gap-6">
            {signups.map((signup) => {
              const form = getForm(signup.id);
              const state = rowStates[signup.id] ?? { kind: "idle" };
              const busy = state.kind === "approving" || state.kind === "denying";
              return (
                <div key={signup.id} className="rounded-lg border border-border bg-surface-1 p-5">
                  <div className="flex items-center gap-3 mb-4">
                    {signup.avatarUrl && (
                      <img src={signup.avatarUrl} alt="" width={40} height={40} className="h-10 w-10 rounded-full" />
                    )}
                    <div>
                      <div className="text-base font-medium text-text-primary">{signup.login}</div>
                      <div className="text-xs text-text-secondary">
                        GitHub ID {signup.githubId}
                        {signup.email ? ` · ${signup.email}` : ""}
                        {signup.name ? ` · ${signup.name}` : ""}
                      </div>
                      <div className="text-xs text-text-muted mt-0.5">
                        Requested {new Date(signup.requestedAt).toLocaleString()}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name={`target-${signup.id}`}
                        checked={form.target === "new"}
                        onChange={() => setForm(signup.id, { target: "new" })}
                        disabled={busy}
                      />
                      New business
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name={`target-${signup.id}`}
                        checked={form.target === "existing"}
                        onChange={() => setForm(signup.id, { target: "existing" })}
                        disabled={busy}
                      />
                      Existing business
                    </label>
                  </div>

                  {form.target === "new" ? (
                    <input
                      id={`approval-business-name-${signup.id}`}
                      type="text"
                      placeholder="Business name"
                      aria-label="New business name"
                      value={form.newBusinessName}
                      onChange={(e) => setForm(signup.id, { newBusinessName: e.target.value })}
                      disabled={busy}
                      className="mb-3 w-full rounded-md border border-border bg-surface-0 px-3 py-2 text-sm"
                    />
                  ) : (
                    <Select
                      id={`approval-business-select-${signup.id}`}
                      aria-label="Existing business"
                      value={form.existingBusinessId}
                      onChange={(e) => setForm(signup.id, { existingBusinessId: e.target.value })}
                      disabled={busy}
                      wrapperClassName="mb-3"
                    >
                      <option value="">Select business…</option>
                      {businesses.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name} ({b.id})
                        </option>
                      ))}
                    </Select>
                  )}

                  <div className="flex items-center gap-3 mb-3">
                    <label htmlFor={`approval-role-${signup.id}`} className="text-sm text-text-secondary">
                      Role:
                    </label>
                    <Select
                      id={`approval-role-${signup.id}`}
                      value={form.role}
                      onChange={(e) => setForm(signup.id, { role: e.target.value as "admin" | "member" })}
                      disabled={busy}
                      wrapperClassName="w-36"
                    >
                      <option value="admin">admin</option>
                      <option value="member">member</option>
                    </Select>
                  </div>

                  {state.kind === "error" && (
                    <div className="editorial-fade mb-3 text-sm text-error">{state.message}</div>
                  )}

                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => handleApprove(signup)}
                      disabled={busy}
                      className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-0 hover:bg-accent-hover disabled:opacity-50"
                    >
                      {state.kind === "approving" && <SpinnerIcon className="mr-2 inline-block h-3.5 w-3.5" />}
                      {state.kind === "approving" ? "Approving" : "Approve"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeny(signup)}
                      disabled={busy}
                      className="btn-press rounded-md border border-border bg-surface-0 px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-2 disabled:opacity-50"
                    >
                      {state.kind === "denying" && <SpinnerIcon className="mr-2 inline-block h-3.5 w-3.5" />}
                      {state.kind === "denying" ? "Denying" : "Deny"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
