export const DEV_AUTHENTICATED_SHELL_PATH = "/authenticated.html";
const DEV_AUTHENTICATED_PATH_STORAGE_KEY = "public-shell-dev-authenticated-path";

type LocationParts = Pick<Location, "pathname" | "search" | "hash">;
type HistoryReplace = Pick<History, "replaceState"> & { state: unknown };
type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function currentPath({ pathname, search, hash }: LocationParts): string {
  return `${pathname}${search}${hash}`;
}

function isSafeStoredPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && path !== DEV_AUTHENTICATED_SHELL_PATH;
}

export function rememberDevAuthenticatedPath(
  storage: SessionStorageLike = window.sessionStorage,
  location: LocationParts = window.location,
): void {
  const path = currentPath(location);
  if (!isSafeStoredPath(path)) return;

  try {
    storage.setItem(DEV_AUTHENTICATED_PATH_STORAGE_KEY, path);
  } catch {
    // Storage can be unavailable in private or locked-down browser contexts.
  }
}

export function restoreDevAuthenticatedPath(
  storage: SessionStorageLike = window.sessionStorage,
  location: LocationParts = window.location,
  history: HistoryReplace = window.history,
): void {
  if (location.pathname !== DEV_AUTHENTICATED_SHELL_PATH) return;

  let path: string | null = null;
  try {
    path = storage.getItem(DEV_AUTHENTICATED_PATH_STORAGE_KEY);
    storage.removeItem(DEV_AUTHENTICATED_PATH_STORAGE_KEY);
  } catch {
    return;
  }

  if (!path || !isSafeStoredPath(path)) return;
  history.replaceState(history.state, "", path);
}
