import { fetchHasAuthenticatedSession } from "./api/auth-probe";
import { PENDING_APPROVAL_COPY, type PendingApprovalVariant } from "./components/pending-approval-copy";
import { DEV_AUTHENTICATED_SHELL_PATH, rememberDevAuthenticatedPath } from "./dev-authenticated-shell";
import { resolvePublicAuthBootAction } from "./public-auth-boot";

const AUTH_LINK_ID = "public-auth-link";
const AUTH_LABEL_ID = "public-auth-label";
const AUTH_PROGRESS_ID = "public-auth-progress";
const AUTHENTICATED_RELOAD_KEY = "public-shell-authenticated-reload";
const MAX_AUTHENTICATED_RELOADS = 2;
const MAX_TRANSIENT_RETRIES = 2;

function setLinkPending(link: HTMLAnchorElement, pending: boolean) {
  if (pending) {
    link.setAttribute("aria-disabled", "true");
    link.setAttribute("tabindex", "-1");
    return;
  }
  link.removeAttribute("aria-disabled");
  link.removeAttribute("tabindex");
}

function setAuthLabel(label: Element | null, value: string) {
  if (label) label.textContent = value;
}

function resetAuthClick(link: HTMLAnchorElement) {
  link.onclick = null;
}

function authenticatedReloadCount(): number {
  const value = Number(sessionStorage.getItem(AUTHENTICATED_RELOAD_KEY) ?? "0");
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function scheduleAuthRetry(run: () => void, attempt: number): void {
  window.setTimeout(run, 400 * (attempt + 1));
}

function renderPendingOrDeniedShell(variant: PendingApprovalVariant): void {
  const root = document.getElementById("root");
  if (!root) return;
  const { title, body } = PENDING_APPROVAL_COPY[variant];
  document.title = `${title} — Cycloid`;
  root.innerHTML = `
    <main class="public-shell" aria-label="${title}">
      <div class="public-shell__frame">
        <div class="public-shell__message" role="status">
          <h1 class="public-shell__title">${title}</h1>
          <p class="public-shell__body">${body}</p>
        </div>
      </div>
    </main>
  `;
}

function bootstrapPublicShell() {
  const path = window.location.pathname;
  if (path === "/pending" || path === "/denied") {
    renderPendingOrDeniedShell(path === "/pending" ? "pending" : "denied");
    return;
  }

  const link = document.getElementById(AUTH_LINK_ID);
  const label = document.getElementById(AUTH_LABEL_ID);
  const progress = document.getElementById(AUTH_PROGRESS_ID);
  if (!(link instanceof HTMLAnchorElement) || !progress) return;

  const setRetryAction = () => {
    setAuthLabel(label, "Try again");
    setLinkPending(link, false);
    link.onclick = (event) => {
      event.preventDefault();
      resetAuthClick(link);
      setAuthLabel(label, "Checking access");
      setLinkPending(link, true);
      checkAuth(0);
    };
  };

  const checkAuth = (attempt: number) => {
    const progressTimer = window.setTimeout(() => {
      progress.dataset.visible = "true";
    }, 300);

    fetchHasAuthenticatedSession()
      .then((authResult) => {
        if (
          authResult.status === "authenticated" &&
          import.meta.env.DEV &&
          window.location.pathname !== DEV_AUTHENTICATED_SHELL_PATH
        ) {
          rememberDevAuthenticatedPath();
          window.location.replace(DEV_AUTHENTICATED_SHELL_PATH);
          return;
        }

        const reloadCount = authenticatedReloadCount();
        const action = resolvePublicAuthBootAction(authResult, reloadCount, MAX_AUTHENTICATED_RELOADS);
        if (action === "reload_app") {
          sessionStorage.setItem(AUTHENTICATED_RELOAD_KEY, String(reloadCount + 1));
          window.location.reload();
          return;
        }
        if (action === "enable_sign_in") {
          resetAuthClick(link);
          sessionStorage.removeItem(AUTHENTICATED_RELOAD_KEY);
          setAuthLabel(label, "Sign in");
          setLinkPending(link, false);
          return;
        }

        if (authResult.status === "transient" && attempt < MAX_TRANSIENT_RETRIES) {
          scheduleAuthRetry(() => checkAuth(attempt + 1), attempt);
          return;
        }
        setRetryAction();
      })
      .finally(() => {
        window.clearTimeout(progressTimer);
        progress.dataset.visible = "false";
      });
  };

  checkAuth(0);
}

bootstrapPublicShell();

export {};
