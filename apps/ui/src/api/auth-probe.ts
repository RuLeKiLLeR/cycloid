import type { ImpersonationContext, User } from "../types";

export type AuthProbeResult<T> =
  { status: "authenticated"; value: T } | { status: "unauthenticated" } | { status: "transient" };

type AuthProbeResponse =
  { authenticated: false } | { authenticated: true; user: User; impersonation?: ImpersonationContext };

function transientAuthProbe<T>(): AuthProbeResult<T> {
  return { status: "transient" };
}

function isExplicitUnauthenticated(response: Response): boolean {
  return response.status === 401;
}

export async function fetchUser(options?: { fresh?: boolean }): Promise<AuthProbeResult<User>> {
  const url = options?.fresh ? "/auth/me?fresh=1" : "/auth/me";
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return transientAuthProbe();
  }
  if (isExplicitUnauthenticated(res)) return { status: "unauthenticated" };
  if (!res.ok) return transientAuthProbe();

  let data: AuthProbeResponse;
  try {
    data = (await res.json()) as AuthProbeResponse;
  } catch {
    return transientAuthProbe();
  }
  if (!data.authenticated) return { status: "unauthenticated" };
  // Carry impersonation context inline on the user object so all existing
  // consumers receive impersonation state through the User payload.
  return {
    status: "authenticated",
    value: data.impersonation ? { ...data.user, impersonation: data.impersonation } : data.user,
  };
}

const AUTH_STATUS_FETCH_OPTIONS = {
  cache: "no-store",
  headers: { accept: "application/json" },
} satisfies RequestInit;

// Lightweight authenticated-shell gate read by the app entry (main.tsx). Hits
// /auth/status, which returns only `{ authenticated }`. This boot-path module
// deliberately uses raw fetch so it can preserve 401 vs transient non-2xx
// status without pulling the full requestJson client into the public chunk.
export async function fetchIsAuthenticated(): Promise<AuthProbeResult<void>> {
  let res: Response;
  try {
    res = await fetch("/auth/status", AUTH_STATUS_FETCH_OPTIONS);
  } catch {
    return transientAuthProbe();
  }
  if (isExplicitUnauthenticated(res)) return { status: "unauthenticated" };
  if (!res.ok) return transientAuthProbe();

  let data: { authenticated?: unknown };
  try {
    data = (await res.json()) as { authenticated?: unknown };
  } catch {
    return transientAuthProbe();
  }
  return data.authenticated === true ? { status: "authenticated", value: undefined } : { status: "unauthenticated" };
}

// Public-shell session probe (public-main.ts). Hits /auth/me with no-store so the
// logged-out bundle never serves a stale authenticated state. This module imports
// only types, so it stays safe to pull into the public entry chunk.
export async function fetchHasAuthenticatedSession(): Promise<AuthProbeResult<void>> {
  let res: Response;
  try {
    res = await fetch("/auth/me", {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
  } catch {
    return transientAuthProbe();
  }
  if (isExplicitUnauthenticated(res)) return { status: "unauthenticated" };
  if (!res.ok) return transientAuthProbe();

  let data: { authenticated?: unknown };
  try {
    data = (await res.json()) as { authenticated?: unknown };
  } catch {
    return transientAuthProbe();
  }
  return data.authenticated === true ? { status: "authenticated", value: undefined } : { status: "unauthenticated" };
}
