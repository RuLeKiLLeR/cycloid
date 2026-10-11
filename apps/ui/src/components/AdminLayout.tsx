import type { ReactNode } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";

import { useLayoutContext } from "./Layout";

const NAV_ITEMS: ReadonlyArray<{ to: string; label: string; end?: boolean }> = [
  { to: "/admin/pending-signups", label: "Pending signups" },
  { to: "/admin/businesses", label: "Businesses" },
  { to: "/admin/users", label: "Users" },
  { to: "/admin/sessions", label: "Sessions" },
];

export function AdminLayout() {
  const navigate = useNavigate();
  const context = useLayoutContext();
  return (
    <div className="mx-auto w-full max-w-6xl px-6 pt-4 md:pt-8">
      <button
        type="button"
        onClick={() => navigate("/")}
        className="btn-press control-sm mb-6 inline-flex cursor-pointer items-center gap-2 rounded-md px-0 text-2xs font-mono-tabular text-text-muted hover:text-accent"
      >
        <span>←</span> Back to app
      </button>

      <div className="editorial-rise editorial-rise-1 mb-8">
        <h1 className="font-display-tight text-4xl md:text-5xl text-text-primary leading-none">Admin</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-8">
        {/* Entrance beats: the layout owns the shared header (-1) and nav rail (-2);
            pages own their own header/toolbar/content beats inside the Outlet. */}
        <nav className="editorial-rise editorial-rise-2 flex md:flex-col gap-1 overflow-x-auto md:overflow-visible -mx-6 px-6 md:mx-0 md:px-0">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? "bg-surface-2 text-text-primary"
                    : "text-text-secondary hover:text-text-primary hover:bg-surface-1"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div>
          <Outlet context={context} />
        </div>
      </div>
    </div>
  );
}

export function AdminSection({
  title,
  action,
  headerClassName = "",
  children,
}: {
  title: string;
  action?: ReactNode;
  headerClassName?: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className={`mb-3 flex items-center justify-between gap-3 ${headerClassName}`}>
        <h2 className="text-xs font-mono-tabular text-text-muted">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function AdminCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-border bg-surface-1 ${className}`}>{children}</div>;
}

export function AdminStat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <AdminCard className="px-4 py-3">
      <div className="text-2xs font-mono-tabular text-text-muted">{label}</div>
      <div className="mt-1 text-2xl font-display-tight text-text-primary">{value}</div>
      {hint && <div className="text-xs text-text-secondary mt-0.5">{hint}</div>}
    </AdminCard>
  );
}

export function AdminLoading({ label = "Loading…" }: { label?: string }) {
  return <div className="text-sm text-text-secondary">{label}</div>;
}

export function AdminError({ message }: { message: string }) {
  // Conditional-appearance banner (motion playbook #3): fades in on mount.
  return (
    <div className="editorial-fade rounded-md border border-border bg-surface-1 px-4 py-3 text-sm text-text-secondary">
      {message}
    </div>
  );
}

export function formatRelative(ts: number | null | undefined): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 0) return new Date(ts).toLocaleString();
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}
