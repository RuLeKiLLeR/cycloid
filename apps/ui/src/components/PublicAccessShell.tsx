import "../public-shell.css";

type PublicAccessShellProps = {
  actionLabel?: string;
  container?: "div" | "main";
  onRetry?: () => void;
  pending?: boolean;
  showAction?: boolean;
  showProgress?: boolean;
};

export function PublicAccessShell({
  actionLabel = "Sign in",
  container = "main",
  onRetry,
  pending = false,
  showAction = true,
  showProgress = false,
}: PublicAccessShellProps) {
  const Container = container;
  const isRetry = Boolean(onRetry);

  return (
    <Container className="public-shell" aria-label={isRetry ? "Retry access check" : "Sign in"}>
      <div className="public-shell__frame">
        <div className="public-shell__actions">
          {isRetry ? (
            <button type="button" onClick={onRetry} className="public-shell__control">
              <span>{actionLabel}</span>
              <svg
                className="public-shell__icon"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15A9 9 0 1 1 21 8.67" />
              </svg>
            </button>
          ) : (
            <div className="public-shell__signin">
              <div className="public-shell__brand">
                <span className="public-shell__wordmark">Cycloid</span>
                <h1 className="public-shell__title">{showAction ? "Sign in" : actionLabel}</h1>
              </div>
              {showAction ? (
                <a
                  href="/auth/github"
                  aria-disabled={pending ? true : undefined}
                  tabIndex={pending ? -1 : undefined}
                  onClick={pending ? (event) => event.preventDefault() : undefined}
                  className={`public-shell__control${pending ? " public-shell__control--pending" : ""}`}
                >
                  <span className="public-shell__control-label">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      aria-hidden="true"
                      className="public-shell__github"
                    >
                      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
                    </svg>
                    <span>{pending ? actionLabel : "Continue with GitHub"}</span>
                  </span>
                  <svg
                    className={`public-shell__icon${pending ? " public-shell__icon--pending" : ""}`}
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                  {pending && showProgress && <span className="public-shell__progress" aria-hidden="true" />}
                </a>
              ) : (
                showProgress && <span className="public-shell__progress" aria-hidden="true" data-visible="true" />
              )}
            </div>
          )}
        </div>
      </div>
    </Container>
  );
}
