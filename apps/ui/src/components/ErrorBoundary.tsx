import { Component, type ReactNode } from "react";

import { stringifyError } from "../../../../shared/utils/errors.js";
import { isDynamicImportError, reloadIfStaleImport } from "../stale-chunk-reload";

type ErrorBoundaryProps = {
  children: ReactNode;
  fallback: (props: { error: unknown; resetError: () => void }) => ReactNode;
  /** Tag passed to Sentry for cross-boundary triage (e.g. "side-panel", "transcript"). */
  boundary: string;
};

type ErrorBoundaryState = {
  error: unknown;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: unknown) {
    const tag = this.props.boundary ?? "unknown";
    console.error(`[ErrorBoundary:${tag}] UI render failed:`, error);
    reloadIfStaleImport(error);
    import("../sentry")
      .then(({ captureUiError }) => captureUiError(error, { boundary: tag }))
      .catch((captureError) => console.error(`[ErrorBoundary:${tag}] Failed to report:`, captureError));
  }

  resetError = () => {
    this.setState({ error: null });
  };

  override render() {
    if (this.state.error !== null) {
      if (isDynamicImportError(this.state.error)) {
        return <div className="p-4 text-sm text-text-muted">Updating to latest version…</div>;
      }
      return this.props.fallback({ error: this.state.error, resetError: this.resetError });
    }
    return this.props.children;
  }
}

export function SectionErrorFallback({
  error,
  resetError,
  label,
}: {
  error: unknown;
  resetError: () => void;
  label?: string;
}) {
  return (
    <div className="rounded-lg border border-error-soft-border bg-error-soft px-4 py-3 text-sm">
      <p className="font-medium text-error">{label ? `${label} failed to load` : "Something went wrong"}</p>
      <p className="mt-1 text-xs text-text-muted">{stringifyError(error)}</p>
      <button
        type="button"
        onClick={resetError}
        className="mt-2 px-3 py-1 text-xs font-medium text-accent border border-accent-soft-border rounded-md hover:bg-accent-soft transition-colors cursor-pointer"
      >
        Retry
      </button>
    </div>
  );
}
