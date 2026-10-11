import type { SessionDetail } from "../types";
import { PrLink } from "./PrSection";
import { CanonicalStatusChip, getCanonicalSessionStatus } from "./SessionHeader";

type Props = {
  session: SessionDetail;
  hydrated: boolean;
  visible: boolean;
  onViewPr: () => void;
};

export function SessionStickyBar({ session, hydrated, visible, onViewPr }: Props) {
  const title = session.title?.trim() || session.sessionId.slice(0, 8);
  const canonicalStatus = hydrated ? getCanonicalSessionStatus(session) : null;

  return (
    <div
      data-session-sticky-bar="true"
      aria-hidden={!visible}
      className={`sticky top-0 z-10 overflow-hidden border-border bg-surface-0 px-3 transition-[opacity,transform] duration-[--duration-fast] ${
        visible
          ? "mb-3 border-b py-2 translate-y-0 opacity-100"
          : "mb-0 h-0 border-b-0 py-0 pointer-events-none -translate-y-1 opacity-0"
      }`}
    >
      <div className="mx-auto flex min-h-8 max-w-[72rem] items-center gap-3">
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{title}</div>
        {canonicalStatus ? <CanonicalStatusChip status={canonicalStatus} /> : null}
        {hydrated && visible ? <PrLink session={session} onViewPr={onViewPr} /> : null}
      </div>
    </div>
  );
}
