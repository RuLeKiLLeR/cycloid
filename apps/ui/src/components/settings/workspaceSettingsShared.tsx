import { useLayoutContext } from "../Layout";

// Shared by the per-repository settings surface (env vars + sandbox resolution)
// and the workspace-default sandbox editor. One parser so every repo-scoped
// settings section agrees on what a valid "owner/name" is.
export function parseRepoFullName(fullName: string): { repoOwner: string; repoName: string } | null {
  const [repoOwner, repoName, ...rest] = fullName.trim().split("/");
  if (!repoOwner || !repoName || rest.length > 0) return null;
  return { repoOwner, repoName };
}

export type WorkspaceAdminAccess = "loading" | "admin" | "denied";

/**
 * Workspace-scoped settings pages stay reachable by direct URL for non-admin
 * members, so we gate the page body in-component rather than redirecting.
 * `canManageBusinessIntegrations` is the business-admin capability.
 */
export function useWorkspaceAdminAccess(): WorkspaceAdminAccess {
  const { capabilities, capabilitiesStatus } = useLayoutContext();
  if (capabilitiesStatus === "loading") return "loading";
  return capabilities?.canManageBusinessIntegrations === true ? "admin" : "denied";
}

export function AdminOnlyNotice({ message = "Ask a workspace admin to change these settings." }: { message?: string }) {
  return (
    <div className="editorial-fade border border-border bg-surface-1 p-4">
      <p className="text-base font-medium text-text-primary">Admins only</p>
      <p className="mt-1 text-base leading-relaxed text-text-secondary">{message}</p>
    </div>
  );
}
