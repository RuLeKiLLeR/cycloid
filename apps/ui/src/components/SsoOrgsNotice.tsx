import type { SsoOrg } from "../../../../shared/types/bootstrap";
import { safeHttpsUrl } from "../utils/safe-url";
import { Button, buttonClasses } from "./ui";

function safeAuthorizeHref(raw: string | null): string | null {
  if (!raw) return null;
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return safeHttpsUrl(raw);
}

export function SsoOrgsNotice({
  ssoOrgs,
  onRefresh,
  refreshing,
  className,
}: {
  ssoOrgs: SsoOrg[];
  onRefresh: () => void | Promise<void>;
  refreshing: boolean;
  className?: string;
}) {
  if (ssoOrgs.length === 0) return null;

  const refreshButton = (
    <Button variant="ghost" size="sm" disabled={refreshing} onClick={() => void onRefresh()}>
      {refreshing ? "Refreshing…" : "Refresh repositories"}
    </Button>
  );

  // Single org: one compact row — the org line is the whole message, so a
  // heading would just repeat it.
  if (ssoOrgs.length === 1) {
    const org = ssoOrgs[0]!;
    const authorizeHref = safeAuthorizeHref(org.authorizeUrl);
    return (
      <div
        role="status"
        className={`editorial-fade flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2 border border-warning-soft-border bg-warning-soft px-3 py-2 ${className ?? ""}`}
      >
        <p className="min-w-0 truncate text-sm text-text-secondary">
          {org.login ? (
            <>
              <span className="font-mono-tabular text-text-primary">{org.login}</span> requires SSO authorization
            </>
          ) : (
            "An organization requires SSO authorization"
          )}
        </p>
        <span className="flex shrink-0 items-center gap-2">
          {refreshButton}
          {authorizeHref ? <AuthorizeLink authorizeUrl={authorizeHref} /> : null}
        </span>
      </div>
    );
  }

  return (
    <div
      role="status"
      className={`editorial-fade w-full border border-warning-soft-border bg-warning-soft px-3 py-2 ${className ?? ""}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="text-sm font-medium text-text-primary">{ssoOrgs.length} organizations need SSO authorization</p>
        {refreshButton}
      </div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {ssoOrgs.map((org) => {
          const authorizeHref = safeAuthorizeHref(org.authorizeUrl);
          return (
            <li key={org.orgId} className="flex items-center justify-between gap-3 text-sm text-text-secondary">
              <span className="truncate">
                {org.login ? (
                  <span className="font-mono-tabular text-text-primary">{org.login}</span>
                ) : (
                  "An organization requires SSO authorization"
                )}
              </span>
              {authorizeHref ? <AuthorizeLink authorizeUrl={authorizeHref} /> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Same-tab navigation: the redirect chain (org SSO -> silent OAuth re-auth ->
// /?sso=complete) must return to this tab.
function AuthorizeLink({ authorizeUrl }: { authorizeUrl: string }) {
  return (
    <a href={authorizeUrl} className={buttonClasses({ variant: "secondary", size: "sm", className: "shrink-0" })}>
      Authorize
    </a>
  );
}
