import type { ElementType } from "react";
import { Navigate } from "react-router";

import type { BootstrapCapabilities } from "../../../../shared/types/bootstrap";
import { ErrorBoundary, SectionErrorFallback } from "./ErrorBoundary";
import { useLayoutContext } from "./Layout";
import { SkeletonBlock, SkeletonRows } from "./ui";

function isCapabilityAllowed(
  capabilities: BootstrapCapabilities | null,
  capability: keyof BootstrapCapabilities,
): boolean {
  return capabilities?.[capability] === true;
}

export function CapabilityRoute({
  capability,
  component: Component,
}: {
  capability: keyof BootstrapCapabilities;
  component: ElementType;
}) {
  const { capabilities, capabilitiesStatus } = useLayoutContext();

  if (capabilitiesStatus === "loading") {
    return (
      <main className="min-h-screen bg-surface-0 px-4 py-6" aria-busy="true" aria-label="Loading access">
        <div className="mx-auto max-w-5xl space-y-5">
          <div className="rounded-lg border border-border bg-surface-1 p-4">
            <div className="space-y-3">
              <SkeletonBlock className="h-4 w-40" />
              <SkeletonBlock className="h-3 w-72 max-w-full" />
            </div>
          </div>
          <div className="rounded-lg border border-border bg-surface-1 p-4">
            <SkeletonRows rows={4} />
          </div>
        </div>
      </main>
    );
  }
  if (!isCapabilityAllowed(capabilities, capability)) return <Navigate to="/" replace />;

  return (
    <ErrorBoundary
      boundary={`capability-route:${String(capability)}`}
      fallback={({ error, resetError }) => (
        <SectionErrorFallback error={error} resetError={resetError} label="Protected route" />
      )}
    >
      <Component />
    </ErrorBoundary>
  );
}
