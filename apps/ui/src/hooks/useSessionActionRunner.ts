import { useCallback } from "react";

type SessionActionOptions<T> = {
  action: () => Promise<T>;
  onSuccess?: (result: T) => Promise<void> | void;
  refreshOnSuccess?: boolean;
  onError?: (error: unknown) => void;
};

interface UseSessionActionRunnerOptions<ActionName extends string> {
  refresh: () => Promise<void>;
  setError: (error: string | null) => void;
  actionInFlight: ActionName | null;
  setActionInFlight: (value: ActionName | null) => void;
}

export function useSessionActionRunner<ActionName extends string>({
  refresh,
  setError,
  actionInFlight,
  setActionInFlight,
}: UseSessionActionRunnerOptions<ActionName>) {
  const runSessionAction = useCallback(
    async <T>({ action, onSuccess, refreshOnSuccess = true, onError }: SessionActionOptions<T>) => {
      try {
        const result = await action();
        await onSuccess?.(result);
        if (refreshOnSuccess) {
          await refresh();
        }
        return result;
      } catch (error) {
        if (onError) {
          onError(error);
        } else {
          setError(String(error));
        }
        return undefined;
      }
    },
    [refresh, setError],
  );

  const runTrackedSessionAction = useCallback(
    async (nextAction: ActionName, action: () => Promise<void>) => {
      if (actionInFlight) return;
      setActionInFlight(nextAction);
      try {
        await runSessionAction({ action });
      } finally {
        setActionInFlight(null);
      }
    },
    [actionInFlight, runSessionAction, setActionInFlight],
  );

  return {
    runSessionAction,
    runTrackedSessionAction,
  };
}
