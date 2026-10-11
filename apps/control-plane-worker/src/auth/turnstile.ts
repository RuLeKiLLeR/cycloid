import { ENVIRONMENT, normalizeEnvironment } from "../../../../shared/constants/environment.js";
import { tracedFetch } from "../observability/wrappers";
import type { Env } from "../types";
import { jsonErrorResponse } from "../utils";

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_TOKEN_FIELD = "cf-turnstile-response";
const TURNSTILE_AUTH_PATHS = new Set(["/auth/github", "/auth/github/sso", "/auth/github/reauthorize"]);

function turnstileRequired(env: Env): boolean {
  return normalizeEnvironment(env.WORKER_ENV, ENVIRONMENT.Production) !== ENVIRONMENT.Local;
}

function authDestinationForRequest(request: Request): string {
  const url = new URL(request.url);
  if (url.pathname === "/auth/github/sso") {
    const org = url.searchParams.get("org");
    return org ? `/auth/github/sso?org=${encodeURIComponent(org)}` : "/auth/github/sso";
  }
  if (url.pathname === "/auth/github") {
    const returnTo = url.searchParams.get("returnTo");
    return returnTo ? `/auth/github?returnTo=${encodeURIComponent(returnTo)}` : "/auth/github";
  }
  return url.pathname;
}

export function renderTurnstileAuthForm(request: Request, env: Env): Response | null {
  if (!turnstileRequired(env)) return null;
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  if (!siteKey) return jsonErrorResponse("Auth challenge not configured", 503);

  const url = new URL(request.url);
  if (!TURNSTILE_AUTH_PATHS.has(url.pathname)) return jsonErrorResponse("Not found", 404);

  const scriptNonce = crypto.randomUUID();
  const destination = authDestinationForRequest(request);
  const escapedDestination = destination.replace(/"/g, "&quot;");
  const escapedSiteKey = siteKey.replace(/"/g, "&quot;");
  const escapedScriptNonce = scriptNonce.replace(/"/g, "&quot;");
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cycloid sign in</title>
  <script nonce="${escapedScriptNonce}">
    window.arcTurnstilePass = function () {
      var f = document.getElementById("arc-auth-form");
      if (!f || f.dataset.submitted) return;
      f.dataset.submitted = "1";
      var b = f.querySelector("button[type=submit]");
      if (b) b.disabled = true;
      (f.requestSubmit ? f.requestSubmit() : f.submit());
    };
  </script>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, -apple-system, sans-serif; background: #faf8f3; color: #21201c; }
    form { display: grid; gap: 16px; justify-items: center; }
    button { min-height: 40px; padding: 0 16px; border: 1px solid #dad9d6; background: #21201c; color: #faf8f3; border-radius: 8px; font: inherit; cursor: pointer; }
  </style>
</head>
<body>
  <form id="arc-auth-form" method="post" action="${escapedDestination}">
    <div class="cf-turnstile" data-sitekey="${escapedSiteKey}" data-callback="arcTurnstilePass"></div>
    <button type="submit">Continue</button>
  </form>
</body>
</html>`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "x-script-nonce": scriptNonce },
  });
}

export async function verifyTurnstileAuthRequest(request: Request, env: Env): Promise<Response | null> {
  if (!turnstileRequired(env)) return null;
  const secret = env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return jsonErrorResponse("Auth challenge not configured", 503);

  const contentType = request.headers.get("content-type") ?? "";
  const form = contentType.includes("application/x-www-form-urlencoded")
    ? new URLSearchParams(await request.text())
    : await request.formData().catch(() => null);
  const token =
    form instanceof URLSearchParams
      ? form.get(TURNSTILE_TOKEN_FIELD)
      : typeof form?.get(TURNSTILE_TOKEN_FIELD) === "string"
        ? String(form.get(TURNSTILE_TOKEN_FIELD))
        : null;
  if (!token) return jsonErrorResponse("Auth challenge required", 403);

  const body = new URLSearchParams({
    secret,
    response: token,
  });
  const remoteIp = request.headers.get("cf-connecting-ip");
  if (remoteIp) body.set("remoteip", remoteIp);

  const response = await tracedFetch(
    TURNSTILE_VERIFY_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    "turnstile.siteverify",
  );
  if (!response.ok) return jsonErrorResponse("Auth challenge verification failed", 403);
  const result = (await response.json().catch(() => null)) as { success?: boolean } | null;
  if (!result?.success) return jsonErrorResponse("Auth challenge verification failed", 403);
  return null;
}
