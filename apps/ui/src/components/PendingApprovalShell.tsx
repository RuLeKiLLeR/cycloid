import "../public-shell.css";

import { PENDING_APPROVAL_COPY, type PendingApprovalVariant } from "./pending-approval-copy";

type PendingApprovalShellProps = {
  variant: PendingApprovalVariant;
};

export function PendingApprovalShell({ variant }: PendingApprovalShellProps) {
  const { title, body } = PENDING_APPROVAL_COPY[variant];
  return (
    <main className="public-shell" aria-label={title}>
      <div className="public-shell__frame">
        <div className="public-shell__message" role="status">
          <h1 className="public-shell__title">{title}</h1>
          <p className="public-shell__body">{body}</p>
        </div>
      </div>
    </main>
  );
}
