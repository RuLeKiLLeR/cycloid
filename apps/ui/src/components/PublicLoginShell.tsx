import { PublicAccessShell } from "./PublicAccessShell";

export function PublicLoginShell({
  authPending = false,
  showAuthProbe = false,
}: {
  authPending?: boolean;
  showAuthProbe?: boolean;
}) {
  return <PublicAccessShell container="div" pending={authPending} showProgress={authPending && showAuthProbe} />;
}
