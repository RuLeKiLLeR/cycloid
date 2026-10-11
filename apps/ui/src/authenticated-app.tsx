import "./App.css";

import { StrictMode, Suspense, useRef } from "react";
import type { Root } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from "react-router";

import { createAuthenticatedBootstrapBarrier } from "./authenticated-bootstrap-barrier";
import { CapabilityRoute } from "./components/CapabilityRoute";
import { ConfirmProvider } from "./components/ConfirmDialog";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Layout } from "./components/Layout";
import { StaleChunkRecoveryPrompt } from "./components/StaleChunkRecoveryPrompt";
import { ToastProvider } from "./components/Toast";
import { Button } from "./components/ui";
import { useMountEffect } from "./hooks/useEffects";
import { useStaleChunkUnrecoverable } from "./hooks/useStaleChunkRecovery";
import { lazyWithRetry } from "./lazy-with-retry";
import { clearReloadGuard, reloadIfStaleImport } from "./stale-chunk-reload";

const HomePage = lazyWithRetry(() => import("./pages/HomePage").then((m) => ({ default: m.HomePage })));
const NotFoundPage = lazyWithRetry(() => import("./pages/NotFoundPage").then((m) => ({ default: m.NotFoundPage })));
const SessionsPage = lazyWithRetry(() => import("./pages/SessionsPage").then((m) => ({ default: m.SessionsPage })));
const SessionPage = lazyWithRetry(() => import("./pages/SessionPage").then((m) => ({ default: m.SessionPage })));
const PrsPage = lazyWithRetry(() => import("./pages/PrsPage").then((m) => ({ default: m.PrsPage })));
const AutomationsPage = lazyWithRetry(() =>
  import("./pages/AutomationsPage").then((m) => ({ default: m.AutomationsPage })),
);
const ContextPage = lazyWithRetry(() => import("./pages/ContextPage").then((m) => ({ default: m.ContextPage })));
const ActivityPage = lazyWithRetry(() => import("./pages/ActivityPage").then((m) => ({ default: m.ActivityPage })));
const SettingsPage = lazyWithRetry(() => import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const SettingsIndexRedirect = lazyWithRetry(() =>
  import("./pages/SettingsPage").then((m) => ({ default: m.SettingsIndexRedirect })),
);
const PendingSignupsAdminPage = lazyWithRetry(() =>
  import("./pages/PendingSignupsAdminPage").then((m) => ({ default: m.PendingSignupsAdminPage })),
);
const SupportViewAdminPage = lazyWithRetry(() =>
  import("./pages/SupportViewAdminPage").then((m) => ({ default: m.SupportViewAdminPage })),
);
const AdminLayout = lazyWithRetry(() => import("./components/AdminLayout").then((m) => ({ default: m.AdminLayout })));
const AdminBusinessesPage = lazyWithRetry(() =>
  import("./pages/AdminBusinessesPage").then((m) => ({ default: m.AdminBusinessesPage })),
);
const AdminBusinessDetailPage = lazyWithRetry(() =>
  import("./pages/AdminBusinessDetailPage").then((m) => ({ default: m.AdminBusinessDetailPage })),
);
const AdminUsersPage = lazyWithRetry(() =>
  import("./pages/AdminUsersPage").then((m) => ({ default: m.AdminUsersPage })),
);
const AdminUserDetailPage = lazyWithRetry(() =>
  import("./pages/AdminUserDetailPage").then((m) => ({ default: m.AdminUserDetailPage })),
);
const AdminSessionsPage = lazyWithRetry(() =>
  import("./pages/AdminSessionsPage").then((m) => ({ default: m.AdminSessionsPage })),
);
const GeneralSettings = lazyWithRetry(() =>
  import("./components/settings/GeneralSettings").then((m) => ({ default: m.GeneralSettings })),
);
const GetStartedSettings = lazyWithRetry(() =>
  import("./components/settings/GetStartedSettings").then((m) => ({ default: m.GetStartedSettings })),
);
const IntegrationsSettings = lazyWithRetry(() =>
  import("./components/settings/IntegrationsSettings").then((m) => ({ default: m.IntegrationsSettings })),
);
const UsageSettings = lazyWithRetry(() =>
  import("./components/settings/UsageSettings").then((m) => ({ default: m.UsageSettings })),
);
const CliTokensSettings = lazyWithRetry(() =>
  import("./components/settings/CliTokensSettings").then((m) => ({ default: m.CliTokensSettings })),
);
const ApiKeysSettings = lazyWithRetry(() =>
  import("./components/settings/ApiKeysSettings").then((m) => ({ default: m.ApiKeysSettings })),
);
const PersonalSecretsSettings = lazyWithRetry(() =>
  import("./components/settings/PersonalSecretsSettings").then((m) => ({ default: m.PersonalSecretsSettings })),
);
const WorkspacePoliciesSettings = lazyWithRetry(() =>
  import("./components/settings/WorkspacePoliciesSettings").then((m) => ({
    default: m.WorkspacePoliciesSettings,
  })),
);
const WorkspaceIntegrationsSettings = lazyWithRetry(() =>
  import("./components/settings/WorkspaceIntegrationsSettings").then((m) => ({
    default: m.WorkspaceIntegrationsSettings,
  })),
);
const WorkspaceMemorySettings = lazyWithRetry(() =>
  import("./components/settings/WorkspaceMemorySettings").then((m) => ({
    default: m.WorkspaceMemorySettings,
  })),
);
const McpServersSettings = lazyWithRetry(() =>
  import("./components/settings/McpServersSettings").then((m) => ({
    default: m.McpServersSettings,
  })),
);
const RepositoriesSettings = lazyWithRetry(() =>
  import("./components/settings/RepositoriesSettings").then((m) => ({
    default: m.RepositoriesSettings,
  })),
);
const AutomationsSettings = lazyWithRetry(() =>
  import("./components/settings/AutomationsSettings").then((m) => ({
    default: m.AutomationsSettings,
  })),
);
const IntegrationsDebugSettings = lazyWithRetry(() =>
  import("./components/settings/IntegrationsDebugSettings").then((m) => ({
    default: m.IntegrationsDebugSettings,
  })),
);

// Preserve `location.search` when redirecting between legacy and renamed
// settings paths so OAuth callback params (?error=, ?warning=, ?setup=)
// reach the destination component.
function RedirectPreservingSearch({ to }: { to: string }) {
  const location = useLocation();
  const hashIndex = to.indexOf("#");
  const pathname = hashIndex === -1 ? to : to.slice(0, hashIndex);
  const hash = hashIndex === -1 ? undefined : to.slice(hashIndex);
  return <Navigate to={{ pathname, search: location.search, hash }} replace />;
}

// Forwards the :integrationId param so legacy deep-links like
// /settings/integration-debug/github land on /settings/diagnostics/github
// instead of the unscoped diagnostics page.
function RedirectDiagnosticsWithIntegration() {
  const { integrationId } = useParams<{ integrationId?: string }>();
  const location = useLocation();
  const pathname = integrationId ? `/settings/diagnostics/${integrationId}` : "/settings/diagnostics";
  return <Navigate to={{ pathname, search: location.search }} replace />;
}

function SentryFallback({ error, resetError }: { error: Error; resetError: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-surface-0 p-8 text-center">
      <h1 className="font-display text-3xl text-text-primary">Something went wrong</h1>
      <p className="max-w-md text-sm leading-relaxed text-text-secondary">
        The app hit an unexpected error. Trying again usually clears it; if not, reload.
      </p>
      <div className="flex items-center gap-2">
        <Button type="button" onClick={resetError} variant="primary" className="btn-press px-5">
          Try again
        </Button>
        <Button type="button" onClick={() => window.location.reload()} variant="secondary" className="btn-press px-5">
          Reload app
        </Button>
      </div>
      {error?.message ? (
        <details className="max-w-md text-left">
          <summary className="cursor-pointer text-sm text-text-muted">Details</summary>
          <p className="mt-1.5 break-words whitespace-pre-wrap text-sm text-text-muted">{error.message}</p>
        </details>
      ) : null}
    </div>
  );
}

function renderFallback({ error, resetError }: { error: unknown; resetError: () => void }) {
  return <SentryFallback error={error as Error} resetError={resetError} />;
}

function MinimalSkeleton() {
  // Mirrors the real Layout chrome (left sidebar rail + content pane) so the
  // pre-hydration frame doesn't visibly reflow into the app shell.
  return (
    <div className="flex h-screen bg-surface-0" aria-hidden>
      <div className="hidden w-[280px] shrink-0 flex-col gap-3 border-r border-border bg-surface-1 p-4 md:flex">
        <div className="h-8 w-32 bg-surface-2 motion-safe:animate-pulse" />
        <div className="mt-2 h-9 w-full bg-surface-2 motion-safe:animate-pulse" />
        <div className="mt-4 space-y-2">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={`skeleton-row-${index}`} className="h-12 bg-surface-2 motion-safe:animate-pulse" />
          ))}
        </div>
      </div>
      <div className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-[72rem]">
          <div className="h-8 w-2/3 max-w-md bg-surface-2 motion-safe:animate-pulse" />
          <div className="mt-10 space-y-4">
            <div className="h-24 bg-surface-2 motion-safe:animate-pulse" />
            <div className="h-32 bg-surface-2 motion-safe:animate-pulse" />
          </div>
        </div>
      </div>
    </div>
  );
}

function schedulePostPaintTask(task: () => void) {
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: IdleRequestCallback) => number;
  };

  if (typeof idleWindow.requestIdleCallback === "function") {
    idleWindow.requestIdleCallback(() => task());
    return;
  }
  globalThis.setTimeout(task, 0);
}

export function StableRoutes({ onReady }: { onReady: () => void }) {
  const signaledRef = useRef(false);

  useMountEffect(() => {
    if (signaledRef.current) return;
    signaledRef.current = true;
    onReady();
  });

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="onboarding" element={<Navigate to="/settings/get-started" replace />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="sessions/:id" element={<SessionPage />} />
        {/* Control-room surfaces are internal-only: gate on the capability.
            Unknown/false falls through to CapabilityRoute's redirect to "/". */}
        <Route path="prs" element={<CapabilityRoute capability="canUseControlRoom" component={PrsPage} />} />
        <Route path="automations" element={<AutomationsPage />} />
        <Route path="context" element={<CapabilityRoute capability="canUseControlRoom" component={ContextPage} />} />
        <Route path="activity" element={<CapabilityRoute capability="canUseControlRoom" component={ActivityPage} />} />
        <Route path="admin" element={<CapabilityRoute capability="canAdminPendingSignups" component={AdminLayout} />}>
          <Route index element={<Navigate to="/admin/pending-signups" replace />} />
          <Route path="businesses" element={<AdminBusinessesPage />} />
          <Route path="businesses/:id" element={<AdminBusinessDetailPage />} />
          <Route path="users" element={<AdminUsersPage />} />
          <Route path="users/:id" element={<AdminUserDetailPage />} />
          <Route path="sessions" element={<AdminSessionsPage />} />
          <Route path="pending-signups" element={<PendingSignupsAdminPage />} />
        </Route>
        <Route
          path="admin/support-view"
          element={<CapabilityRoute capability="canStartSupportView" component={SupportViewAdminPage} />}
        />
        <Route path="settings" element={<SettingsPage />}>
          <Route index element={<SettingsIndexRedirect />} />
          <Route path="get-started" element={<GetStartedSettings />} />
          <Route path="preferences" element={<GeneralSettings />} />
          {/* Renamed General -> Preferences; keep the old path as a search-preserving alias. */}
          <Route path="general" element={<RedirectPreservingSearch to="/settings/preferences" />} />
          <Route path="api-keys" element={<ApiKeysSettings />} />
          <Route path="personal-secrets" element={<PersonalSecretsSettings />} />
          <Route path="usage" element={<UsageSettings />} />
          <Route path="integrations" element={<IntegrationsSettings />} />
          <Route
            path="cli-tokens"
            element={<CapabilityRoute capability="canManageCliTokens" component={CliTokensSettings} />}
          />
          {/* Workspace pages stay reachable by direct URL for non-admin members; the
              page component renders an "Admins only" notice instead of the content. */}
          <Route path="workspace-policies" element={<WorkspacePoliciesSettings />} />
          <Route path="workspace-integrations" element={<WorkspaceIntegrationsSettings />} />
          <Route
            path="business-integrations"
            element={<RedirectPreservingSearch to="/settings/workspace-integrations" />}
          />
          <Route path="automations" element={<RedirectPreservingSearch to="/automations#slack-alert-rules" />} />
          <Route path="scheduled-runs" element={<RedirectPreservingSearch to="/settings/automations" />} />
          <Route path="slack-memory" element={<WorkspaceMemorySettings />} />
          <Route path="mcp-servers" element={<McpServersSettings />} />
          {/* Member-accessible: the review checklist works for everyone; env-var
              and sandbox sections gate to admins in-page. */}
          <Route path="repositories" element={<RepositoriesSettings />} />
          {/* Legacy path from before the per-repo consolidation. */}
          <Route path="repository-secrets" element={<RedirectPreservingSearch to="/settings/repositories" />} />
          <Route
            path="diagnostics"
            element={<CapabilityRoute capability="canAccessIntegrationDebug" component={IntegrationsDebugSettings} />}
          />
          <Route
            path="diagnostics/:integrationId"
            element={<CapabilityRoute capability="canAccessIntegrationDebug" component={IntegrationsDebugSettings} />}
          />
          <Route path="integration-debug" element={<RedirectPreservingSearch to="/settings/diagnostics" />} />
          <Route path="integration-debug/:integrationId" element={<RedirectDiagnosticsWithIntegration />} />
        </Route>
        <Route path="index.html" element={<Navigate to="/" replace />} />
        <Route path="authenticated.html" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

function AppRoutes({ onReady }: { onReady: () => void }) {
  return (
    <Suspense fallback={<MinimalSkeleton />}>
      <StableRoutes onReady={onReady} />
    </Suspense>
  );
}

function initAuthenticatedObservability({
  onSentryReady,
  onDatadogReady,
}: {
  onSentryReady: () => void;
  onDatadogReady: () => void;
}) {
  schedulePostPaintTask(() => {
    import("./sentry")
      .then(({ initSentry }) => initSentry())
      .then(onSentryReady)
      .catch((err) => {
        console.error("[bootstrap] Sentry init failed:", err);
        if (!reloadIfStaleImport(err)) onSentryReady();
      });
  });

  schedulePostPaintTask(() => {
    import("./datadog")
      .then(({ initDatadog }) => initDatadog())
      .then(onDatadogReady)
      .catch((err) => {
        console.error("[bootstrap] Datadog init failed:", err);
        if (!reloadIfStaleImport(err)) onDatadogReady();
      });
  });
}

function AuthenticatedApp() {
  const staleChunkUnrecoverable = useStaleChunkUnrecoverable();
  const markStableRef = useRef<ReturnType<typeof createAuthenticatedBootstrapBarrier> | null>(null);
  const observabilityStartedRef = useRef(false);

  if (!markStableRef.current) {
    markStableRef.current = createAuthenticatedBootstrapBarrier(clearReloadGuard);
  }

  useMountEffect(() => {
    if (observabilityStartedRef.current) return;
    observabilityStartedRef.current = true;
    initAuthenticatedObservability({
      onSentryReady: () => markStableRef.current?.("sentry"),
      onDatadogReady: () => markStableRef.current?.("datadog"),
    });
  });

  if (staleChunkUnrecoverable) return <StaleChunkRecoveryPrompt />;

  return (
    <BrowserRouter>
      <ErrorBoundary fallback={renderFallback} boundary="root">
        <ToastProvider>
          <ConfirmProvider>
            <AppRoutes onReady={() => markStableRef.current?.("routes")} />
          </ConfirmProvider>
        </ToastProvider>
      </ErrorBoundary>
    </BrowserRouter>
  );
}

export function renderAuthenticatedApp(root: Root) {
  root.render(
    <StrictMode>
      <AuthenticatedApp />
    </StrictMode>,
  );
}
