import {
  CALLBACK_MESSAGES,
  type CallbackMessage,
  isOAuthCallbackCode,
} from "../../../../../shared/constants/onboarding";
import { Button } from "../ui";

/**
 * Resolve the callback message (if any) from the current search params.
 * Reads `?error=<code>` first, then `?warning=<code>`. Pass `includeSuccess`
 * to also read `?success=<code>` — the workspace-integrations surface renders
 * success banners, while the personal connected-accounts surface does not.
 * Unknown codes return null so the UI degrades silently instead of rendering
 * "undefined".
 */
export function resolveCallbackMessage(
  searchParams: URLSearchParams,
  { includeSuccess = false }: { includeSuccess?: boolean } = {},
): CallbackMessage | null {
  const errorCode = searchParams.get("error");
  if (isOAuthCallbackCode(errorCode)) {
    return CALLBACK_MESSAGES[errorCode];
  }
  const warningCode = searchParams.get("warning");
  if (isOAuthCallbackCode(warningCode)) {
    return CALLBACK_MESSAGES[warningCode];
  }
  if (includeSuccess) {
    const successCode = searchParams.get("success");
    if (isOAuthCallbackCode(successCode)) {
      return CALLBACK_MESSAGES[successCode];
    }
  }
  return null;
}

export function CallbackBanner({ message, onDismiss }: { message: CallbackMessage; onDismiss: () => void }) {
  const isError = message.severity === "error";
  const containerClasses = isError
    ? "border-error-soft-border bg-error-soft text-error"
    : message.severity === "success"
      ? "border-success-soft-border bg-success-soft text-success"
      : "border-warning-soft-border bg-warning-soft text-warning";
  return (
    <div
      role={isError ? "alert" : "status"}
      className={`editorial-fade mb-6 flex items-start gap-3 border px-4 py-3 ${containerClasses}`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{message.title}</p>
        <p className="mt-1 text-xs opacity-90">{message.description}</p>
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onDismiss} className="shrink-0">
        Dismiss
      </Button>
    </div>
  );
}

export function formatHealthCheckedAt(checkedAt: number | null): string | null {
  if (!checkedAt) return null;
  return new Date(checkedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
