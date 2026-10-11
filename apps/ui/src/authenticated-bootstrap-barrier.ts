type BootstrapReadySignal = "routes" | "sentry" | "datadog";

export function createAuthenticatedBootstrapBarrier(onStable: () => void) {
  const pendingSignals = new Set<BootstrapReadySignal>(["routes", "sentry", "datadog"]);
  let completed = false;

  return (signal: BootstrapReadySignal) => {
    if (completed) return;
    pendingSignals.delete(signal);
    if (pendingSignals.size === 0) {
      completed = true;
      onStable();
    }
  };
}
