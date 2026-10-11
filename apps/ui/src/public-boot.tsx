import { StrictMode, useState } from "react";
import { type Root } from "react-dom/client";

import { fetchIsAuthenticated } from "./api/auth-probe";
import { PendingApprovalShell } from "./components/PendingApprovalShell";
import { PublicAccessShell } from "./components/PublicAccessShell";
import { StaleChunkRecoveryPrompt } from "./components/StaleChunkRecoveryPrompt";
import { useSyncEffect } from "./hooks/useEffects";
import { useStaleChunkUnrecoverable } from "./hooks/useStaleChunkRecovery";
import { clearReloadGuard, reloadIfStaleImport } from "./stale-chunk-reload";

type AuthCheckState = "checking" | "signed_out" | "loading_app" | "failed";

type AuthenticatedAppModule = typeof import("./authenticated-app");
type AuthenticatedAppResult = { module: AuthenticatedAppModule } | { error: unknown };

function PublicShell({ state, onRetry }: { state: AuthCheckState; onRetry: () => void }) {
  const isPending = state === "checking" || state === "loading_app";
  const isCallback = window.location.pathname.startsWith("/auth/");
  const label = isCallback && isPending ? "Completing sign in" : "Checking access";

  if (state === "failed") {
    return <PublicAccessShell actionLabel="Try again" onRetry={onRetry} />;
  }

  if (isPending) {
    return <PublicAccessShell actionLabel={label} pending showAction={false} showProgress />;
  }

  return <PublicAccessShell actionLabel="Continue with GitHub" />;
}

function PublicBoot({ root, initialState }: { root: Root; initialState: AuthCheckState }) {
  const [state, setState] = useState<AuthCheckState>(initialState);
  const [attempt, setAttempt] = useState(initialState === "checking" ? 1 : 0);
  const staleChunkUnrecoverable = useStaleChunkUnrecoverable();

  useSyncEffect(() => {
    if (attempt === 0) return;

    let active = true;
    setState("checking");

    const authStatusPromise = fetchIsAuthenticated();
    const appPromise = import("./authenticated-app").then(
      (module): AuthenticatedAppResult => ({ module }),
      (error): AuthenticatedAppResult => ({ error }),
    );

    authStatusPromise
      .then(async (authResult) => {
        if (!active) return;
        if (authResult.status === "unauthenticated") {
          clearReloadGuard();
          setState("signed_out");
          return;
        }
        if (authResult.status === "transient") {
          setState("failed");
          return;
        }

        setState("loading_app");
        const appResult = await appPromise;
        if ("error" in appResult) throw appResult.error;
        if (active) {
          appResult.module.renderAuthenticatedApp(root);
        }
      })
      .catch((err) => {
        console.error("[app] Authenticated app load failed:", err);
        reloadIfStaleImport(err);
        if (active) setState("failed");
      });

    return () => {
      active = false;
    };
  }, [attempt, root]);

  useSyncEffect(() => {
    if (state !== "signed_out") return;
    function handleFocus() {
      setAttempt((current) => current + 1);
    }
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [state]);

  useSyncEffect(() => {
    if (state !== "signed_out") return;
    document.title = "Sign in — Cycloid";
    return () => {
      document.title = "Cycloid";
    };
  }, [state]);

  if (staleChunkUnrecoverable) return <StaleChunkRecoveryPrompt />;

  return <PublicShell state={state} onRetry={() => setAttempt((current) => current + 1)} />;
}

export function renderPublicBoot(root: Root, initialState: AuthCheckState) {
  root.render(
    <StrictMode>
      <PublicBoot root={root} initialState={initialState} />
    </StrictMode>,
  );
}

export function renderPendingApproval(root: Root, variant: "pending" | "denied") {
  root.render(
    <StrictMode>
      <PendingApprovalShell variant={variant} />
    </StrictMode>,
  );
}
