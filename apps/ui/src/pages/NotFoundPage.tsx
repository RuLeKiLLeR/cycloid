import { Link } from "react-router";

import { ErrorBoundary, SectionErrorFallback } from "../components/ErrorBoundary";
import { LogoMark } from "../components/icons/LogoMark";
import { buttonClasses, EmptyState } from "../components/ui";
import { useAuthenticatedTitle } from "../hooks/useAuthenticatedTitle";

function NotFoundContent() {
  useAuthenticatedTitle("Page not found - Cycloid");

  return (
    <main className="editorial-rise flex min-h-full items-center justify-center px-6 py-16">
      <EmptyState
        headingLevel={2}
        icon={<LogoMark />}
        title="This page doesn't exist."
        action={
          <Link to="/" className={buttonClasses({ variant: "primary" })}>
            Back to home
          </Link>
        }
      />
    </main>
  );
}

export function NotFoundPage() {
  return (
    <ErrorBoundary
      boundary="not-found-route"
      fallback={({ error, resetError }) => (
        <SectionErrorFallback error={error} resetError={resetError} label="Not-found page" />
      )}
    >
      <NotFoundContent />
    </ErrorBoundary>
  );
}
