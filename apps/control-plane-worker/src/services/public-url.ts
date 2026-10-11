import { ENVIRONMENT } from "../../../../shared/constants/environment.js";
import { DEFAULT_FRONTEND_URL } from "./warm";

type PublicUrlEnv = {
  FRONTEND_URL?: string | null;
  CONTROL_PLANE_URL?: string | null;
  PUBLIC_ARTIFACT_BASE_URL?: string | null;
  WORKER_ENV?: string | null;
};

function resolveHttpsBaseUrl(
  value: string | null | undefined,
  options: { allowEphemeralTunnel?: boolean } = {},
): string | null {
  const rawUrl = value?.trim();
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    const isLocalHost =
      hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname.endsWith(".local");
    const isEphemeralTunnel =
      hostname.endsWith(".ngrok-free.app") ||
      hostname.endsWith(".ngrok-free.dev") ||
      hostname.endsWith(".ngrok.app") ||
      hostname.endsWith(".ngrok.io") ||
      hostname.endsWith(".trycloudflare.com");

    if (parsed.protocol === "https:" && !isLocalHost && (!isEphemeralTunnel || options.allowEphemeralTunnel)) {
      return rawUrl.replace(/\/$/, "");
    }
  } catch {
    return null;
  }

  return null;
}

function resolveLocalAppBaseUrl(value: string | null | undefined): string | null {
  const rawUrl = value?.trim();
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    const isLocalHost =
      hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname.endsWith(".local");
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && isLocalHost) {
      return rawUrl.replace(/\/$/, "");
    }
  } catch {
    return null;
  }

  return null;
}

export function resolvePublicAppBaseUrl(env: PublicUrlEnv): string {
  if (env.WORKER_ENV === ENVIRONMENT.Local) {
    const localFrontendUrl = resolveLocalAppBaseUrl(env.FRONTEND_URL);
    if (localFrontendUrl) return localFrontendUrl;
  }

  const stableFrontendUrl = resolveConfiguredPublicAppBaseUrl(env);
  if (stableFrontendUrl) return stableFrontendUrl;

  return DEFAULT_FRONTEND_URL;
}

export function resolveConfiguredPublicAppBaseUrl(env: Pick<PublicUrlEnv, "FRONTEND_URL">): string | null {
  return resolveHttpsBaseUrl(env.FRONTEND_URL);
}

export function resolvePublicSessionUrl(
  env: Pick<PublicUrlEnv, "FRONTEND_URL" | "WORKER_ENV">,
  sessionId: string,
): string {
  return `${resolvePublicAppBaseUrl(env)}/sessions/${encodeURIComponent(sessionId)}`;
}

export function resolveConfiguredPublicSessionUrl(
  env: Pick<PublicUrlEnv, "FRONTEND_URL">,
  sessionId: string,
): string | null {
  const baseUrl = resolveConfiguredPublicAppBaseUrl(env);
  return baseUrl ? `${baseUrl}/sessions/${encodeURIComponent(sessionId)}` : null;
}

export function resolvePublicArtifactBaseUrl(env: PublicUrlEnv): string {
  const allowLocalTunnel = env.WORKER_ENV === ENVIRONMENT.Local;
  const explicitArtifactUrl = resolveHttpsBaseUrl(env.PUBLIC_ARTIFACT_BASE_URL, {
    allowEphemeralTunnel: allowLocalTunnel,
  });
  if (explicitArtifactUrl) return explicitArtifactUrl;

  if (allowLocalTunnel) {
    const controlPlaneUrl = resolveHttpsBaseUrl(env.CONTROL_PLANE_URL, { allowEphemeralTunnel: true });
    if (controlPlaneUrl) return controlPlaneUrl;
  }

  const stableFrontendUrl = resolveHttpsBaseUrl(env.FRONTEND_URL);
  if (stableFrontendUrl) return stableFrontendUrl;

  const controlPlaneUrl = resolveHttpsBaseUrl(env.CONTROL_PLANE_URL);
  if (controlPlaneUrl) return controlPlaneUrl;

  return DEFAULT_FRONTEND_URL;
}
