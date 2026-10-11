# Security boundaries

Customer-facing description of Cycloid's isolation model. Internal implementation rules: [security.md](security.md).

## The short version

- Every session's agent runs in a **dedicated, ephemeral sandbox** (an E2B micro-VM). Stopped sessions pause their sandbox (verifier sessions) or keep it live-idle (non-verifier sessions); the sandbox (including the cloned repo) is destroyed by scheduled cleanup after the retention window (currently 72 hours) or immediately when the session reaches a final terminal (merged/closed/superseded/archived).
- Your repository is cloned **only into that sandbox**, with a short-lived, repo-scoped GitHub token minted per session.
- The **control plane** (Cloudflare Workers + D1) owns auth, authorization, and credential use. The browser UI renders; it is never a security boundary.
- Everything fails closed: if repo access, business membership, or a credential cannot be proven, the request is denied.

## Boundary by boundary

### Sandbox isolation

- One sandbox per session; never shared across sessions, users, or businesses.
- Sandboxes are firecracker-class micro-VMs (E2B), not containers in a shared kernel.
- Agent tool calls pass a server-side safety gate (protected paths, git/push restrictions) before executing; this is defense-in-depth around supported tool paths, not a claim of OS-level isolation between the bridge and agent inside the sandbox.
- Sandboxes reach the control plane with a sandbox-scoped callback secret; callback failures are monitored.

### Source code

- Code is cloned into the session sandbox only and destroyed with it — immediately on final terminals (merged/closed/superseded/archived), or after the retention window (72 hours) for paused/resumable sessions.
- The control plane never stores repository contents; it stores session metadata, transcripts, and diffs needed to render the session.
- Session artifacts (screenshots, recordings) live in private S3 behind an authenticated artifact proxy; public links exist only for explicitly public artifact types via signed, artifact-scoped tokens.

### Credentials

- GitHub access uses the Cycloid GitHub App: per-session installation tokens, scoped to granted repos, expiring in under an hour.
- Provider API keys and integration tokens are encrypted at rest (server-side AES), never reach the browser, and are never written into the sandbox repo checkout.
- Sandbox process environments are minimized: bridge-only credentials are withheld from agent children, model-provider keys may be available to the selected agent runtime when needed to call the model, and integration credentials are exposed only when a configured tool path requires them.
- Webhooks (GitHub, Slack, Linear, PagerDuty) are HMAC-verified with per-integration secrets; Slack adds timestamp replay protection.

### Tenant separation

- Every API route enforces business membership and repo authorization server-side; suspended or uninstalled GitHub installations are rejected at credential-resolution time.
- Sessions, memories, and integrations are business-scoped; no cross-tenant query path.

### What leaves the boundary

- PRs and commits are pushed to **your** GitHub repo as the session's user.
- Model traffic goes to the configured model provider (your BYOK key when set).
- Telemetry is metadata-only (timings, error codes); prompts and code stay out of metrics, secrets are redacted from logs.

## Questions

Security review or questionnaire? Ask the Cycloid team — we will walk through any boundary above with the implementation in front of us.
