import { useState } from "react";

import { stringifyError } from "../../../../shared/utils/errors.js";
import { stopImpersonation } from "../api/admin-impersonation";
import type { ImpersonationContext } from "../types";

interface Props {
  impersonation: ImpersonationContext;
  targetLogin: string | null;
}

export function ImpersonationBanner({ impersonation, targetLogin }: Props) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function stop() {
    setStopping(true);
    setError(null);
    try {
      await stopImpersonation(impersonation.impersonationId);
      // Reload so the public-shell bootstrap re-reads /auth/me without the
      // impersonation cookie.
      window.location.assign("/");
    } catch (err) {
      setError(stringifyError(err));
      setStopping(false);
    }
  }

  const actorLogin = impersonation.actor?.login ?? `actor #${impersonation.actor?.id ?? "?"}`;
  const targetLabel = targetLogin ?? "this user";

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="impersonation-banner"
      className="w-full border-b border-warning-soft-border bg-warning-soft text-sm font-medium text-text-primary"
    >
      <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center justify-between gap-3 px-4 py-2">
        <span>
          Viewing as <strong className="text-text-primary">{targetLabel}</strong> in read-only mode (operator:{" "}
          {actorLogin})
        </span>
        <div className="flex items-center gap-2">
          {error ? <span className="text-xs text-error">{error}</span> : null}
          <button
            type="button"
            onClick={stop}
            disabled={stopping}
            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-surface-0 transition-colors duration-200 hover:bg-accent-hover disabled:opacity-50"
          >
            {stopping ? "Stopping…" : "Stop impersonating"}
          </button>
        </div>
      </div>
    </div>
  );
}
