export const HTTP_HEADER_NAMES = {
  ALLOW: "allow",
  AUTHORIZATION: "authorization",
  CONTENT_TYPE: "content-type",
  REQUEST_ID: "x-request-id",
  // Original serving host, set by the UI Pages worker when it proxies /auth/* to
  // the control plane with the Host header rewritten to WORKER_HOST. Used to
  // choose the GitHub sign-in redirect host from a strict allowlist.
  FORWARDED_HOST: "x-forwarded-host",
} as const;
