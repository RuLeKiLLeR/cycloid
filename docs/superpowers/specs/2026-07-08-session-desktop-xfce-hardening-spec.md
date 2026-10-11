# Session Desktop XFCE Hardening Spec

**Date:** 2026-07-08
**Status:** Draft
**Owner:** TBD
**Worktree:** `/Users/<name>/Developer/cycloid/cycloid/.worktrees/session-desktop-vnc-setup`
**Current HEAD at writing:** `295d2497ce6db3e1a950dd09e2e20372fcd46386`
**Builds on:** `docs/superpowers/specs/2026-07-07-session-desktop-vnc-cua-functional-spec.md`

## Worth-it Gate

Cost: more shared E2B base-image weight, more desktop processes, more startup failure modes, and more tests around X11/noVNC/browser readiness.
Buy: a desktop that looks and behaves like a real agent workbench instead of a thin screenshot/VNC shim, fixing repeated dogfood failures around unavailable live view, black screens, unfocused apps, browser first-run prompts, and cramped screenshots.
Verdict: build.

## Problem

The first desktop/VNC stack proved the direction but is not feature-hardened. It currently relies on a minimal `Xvfb + openbox + tint2 + x11vnc + websockify/noVNC` stack and has shown these problems in real sessions:

- Live desktop can stay unavailable, preparing, reconnecting, or fail with `proxy_failed`.
- The view can look like only the focused app instead of a full desktop.
- `desktop.open_app` can launch an app without making that window usable and focused.
- Chromium can show setup/default-browser/sign-in prompts that the agent must clear before using a URL.
- Screenshot resolution and viewer framing force extra scrolling and extra model-visible screenshots.
- Health/observability often says unavailable without enough root-cause detail to know whether the blocker is X, `DISPLAY`, screenshot capture, VNC, websockify, E2B port forwarding, or the control-plane proxy.

The existing package measurement in `apps/sandbox-e2b/README.md` says the current minimal desktop package set adds `SIZE_DELTA_KIB=598840` from `python:3.12-slim-bookworm`. Any move to XFCE must be measured the same way before merge.

## Decision

Upgrade the sandbox desktop from the minimal Openbox shell to a measured XFCE-core desktop, not a full distro desktop. Use `--no-install-recommends` and install only the packages needed for a stable visible desktop shell:

- `dbus-x11`
- `xfwm4`
- `xfce4-panel`
- `xfdesktop4`
- `xfce4-session`
- `xfce4-settings`
- `xfconf`
- `thunar`
- `xfce4-terminal`
- `adwaita-icon-theme`
- `hicolor-icon-theme`

Do not install `xfce4-goodies`, a display manager, screen locker, screensaver, printer stack, pulseaudio/audio stack, or a full Xubuntu/GNOME-style desktop unless a measured smoke proves XFCE-core cannot satisfy the acceptance tests.

Set the default desktop geometry to `1440x900x24` unless measurement shows unacceptable live-view or model-image cost. Keep model-visible screenshots compressed/downscaled through the existing image-feedback path; artifact screenshots remain full display.

## Goals

- Live desktop is available whenever the sandbox runtime is running, after a bounded startup window.
- The live panel and screenshots show the full display, including desktop shell/panel context, not a cropped focused-window capture.
- GUI apps opened by desktop tools are focused by default.
- Browser URLs open in a ready-to-use Chromium profile with no first-run, default-browser, sign-in, or testing-onboarding prompt.
- Health checks detect black/uniform screens, not just non-empty screenshot files.
- Observability identifies the failing component and phase without exposing provider URLs, tickets, tokens, cookies, raw screenshots, or signed artifact URLs.
- E2E verification includes a real Cycloid session that uses live desktop, `desktop.observe`, `desktop.open_app`, full-display screenshots, and a browser URL.

## Non-goals

- No human keyboard/mouse forwarding in this spec.
- No GPU, audio, video conferencing, mobile simulator, or multi-monitor support.
- No feature flag.
- No full desktop distribution image.
- No broad package additions without measured image-size and startup impact.

## Acceptance Criteria

1. Package measurement compares the current minimal desktop set, XFCE-core no-recommends, and `xfce4` metapackage no-recommends before runtime code changes merge.
2. The implementation PR body names the measured installed-size/image-size delta and cold desktop-ready delta.
3. `cycloid-desktop-supervisor health` reports `available` only when X, DBus, window manager, panel, desktop root, screenshot capture, VNC, websockify, and loopback/provider reachability are healthy.
4. Health JSON includes `display`, `size`, desktop shell component status, active window, screenshot entropy or non-black-pixel ratio, failed component, failed phase, last safe error code, and restart counts.
5. `desktop.observe` and action screenshots always use full-display capture and report `captureMode:"full_display"`.
6. A smoke fixture opens Chromium to a URL, proves the Chromium window is active, and proves no first-run/default-browser/sign-in prompt blocks navigation.
7. A smoke fixture captures a full-display screenshot where the XFCE panel or desktop root is visible.
8. The live desktop UI fits the whole remote display in the right pane without cropping; it can letterbox/scale but must not hide screen edges by default.
9. If live proxy connection fails, UI/server status exposes the sanitized close reason with phase detail, for example `supervisor_health.screenshot_black`, `proxy_handshake.fetch_exception`, or `upstream_resolve.port_unreachable`.
10. A real local or QA Cycloid session demonstrates live desktop, open browser URL, focused app, full-display `desktop.observe`, and screenshot artifact registration.

## Stack Plan

Each slice must be green on its own and depend only on the previous slice. Use Graphite for publishing. Suggested PR titles use the existing stack style: `[i/5] <slice title>`.

### PR 1 - Measure XFCE desktop image cost

Owns:

- Add a repeatable measurement note or script for desktop package alternatives.
- Measure these alternatives from the same base image used by the E2B template:
  - current minimal stack from `apps/sandbox-e2b/README.md`;
  - XFCE-core no-recommends package list from this spec;
  - Debian `xfce4` metapackage with `--no-install-recommends`;
  - optional `xfce4-goodies` only as a documented rejected upper bound.
- Record installed package versions and size deltas.
- Define the merge threshold for PR 2. Recommended threshold: XFCE-core can proceed if it adds no more than 1 GiB over the current base and desktop-ready p95 is still under 20 seconds in disposable E2B smoke.

Files likely touched:

- `apps/sandbox-e2b/README.md`
- optional `scripts/` measurement helper if the repo already has a matching pattern

Tests:

- No runtime test required if docs-only.
- If a helper is added, test parsing/output locally.
- `npm run lint:changed`

### PR 2 - Replace Openbox shell with XFCE core desktop

Owns:

- Update `apps/sandbox-e2b/template.ts` package list with the accepted XFCE-core no-recommends package set.
- Update `apps/sandbox-e2b/ready-check.sh` for XFCE binaries and remove stale Openbox/tint2-only assertions.
- Replace supervisor components:
  - keep `Xvfb`;
  - start a DBus session for the desktop;
  - start `xfsettingsd`;
  - start `xfwm4`;
  - start `xfdesktop`;
  - start `xfce4-panel`;
  - keep `x11vnc` and `websockify`.
- Keep `DISPLAY=:99` exported in `template.ts` and `start-bridge.sh`.
- Prefer supervising independent XFCE components over a single opaque `startxfce4` process unless tests prove the session wrapper is more reliable.
- Keep services loopback-bound.

Files likely touched:

- `apps/sandbox-e2b/template.ts`
- `apps/sandbox-e2b/ready-check.sh`
- `apps/sandbox-e2b/scripts/cycloid-desktop-supervisor`
- `tests/test_sandbox-e2b/*desktop*`
- `tests/test_sandbox-e2b/template-dockerfile.test.ts` if package assertions exist there

Tests:

- Focused sandbox-e2b tests for template package assertions.
- Supervisor shell/unit tests for health JSON and component restart budget.
- Disposable local container smoke if available.
- `npm run lint:changed`

### PR 3 - Harden app launch, focus, and Chromium readiness

Owns:

- Make `desktop.open_app` open browser URLs into the desktop Chromium profile with:
  - `--user-data-dir=/tmp/cycloid-desktop/chromium-profile`;
  - `--no-first-run`;
  - `--no-default-browser-check`;
  - `--disable-default-apps`;
  - `--disable-sync`;
  - safe flags that suppress sign-in/whats-new/password-manager onboarding prompts when supported by the installed Chromium.
- Pre-create the Chromium profile or first-run sentinel during supervisor start if needed.
- After launching a GUI app, wait until a matching window exists, activate it with `wmctrl`/`xdotool`, and verify the active window before returning success.
- Return a retryable error if the app launched but focus could not be proven.
- Do not log the URL query string if it could contain credentials; log URL origin/path only or a hash.

Files likely touched:

- `apps/sandbox-e2b/scripts/cycloid-desktop`
- `apps/sandbox-e2b/scripts/cycloid-desktop-supervisor`
- `apps/sandbox-bridge/src/services/desktop-dynamic-tool.ts`
- matching tests under `tests/test_sandbox-e2b/` and `tests/test_sandbox-bridge/`

Tests:

- CLI contract test: `open_app` reports active window metadata.
- Smoke test: open a local test URL, prove no Chromium onboarding prompt is active.
- Regression test: app-open failure returns sanitized diagnostics.
- `npm run lint:changed`

### PR 4 - Fix full-display capture, resolution, and viewer fit

Owns:

- Change desktop geometry default from `1280x720x24` to `1440x900x24`, unless PR 1 measurement rejects it.
- Ensure all screenshot paths use full-display capture. Do not use focused-window capture in desktop tools.
- Include `captureMode:"full_display"` and `displayName` in observe/action screenshot metadata.
- Add black-screen and uniform-screen checks to supervisor health:
  - screenshot exists and has bytes;
  - dimensions match expected display;
  - non-black-pixel ratio or entropy exceeds a small threshold;
  - XFCE panel/root is visible in the deterministic smoke fixture.
- Update the live desktop panel/noVNC wrapper so the entire remote display is visible by default in the right pane. Use scaling/fit-to-container, not cropping.
- Remove any user-facing "select proof" control from the session desktop pane. Desktop evidence selection should be automatic or verifier-owned, not a normal session user action.

Files likely touched:

- `apps/sandbox-e2b/scripts/cycloid-desktop`
- `apps/sandbox-e2b/scripts/cycloid-desktop-supervisor`
- `apps/ui/src/components/SessionDesktopWorkbench.tsx` or current desktop workbench component
- `apps/ui/src/hooks/useSessionDesktopViewer.ts`
- `shared/types/desktop-*`
- matching UI and sandbox tests

Tests:

- CLI test proves `desktop.observe` captures the full display.
- Health test rejects a black/uniform screenshot.
- UI test proves viewer uses fit-to-pane behavior and no "select proof" button is rendered.
- `npx vitest run tests/test_ui/session-desktop-workbench.test.tsx --reporter=verbose`
- focused sandbox-e2b desktop tests
- `npm run lint:changed`

### PR 5 - Add desktop root-cause observability and E2E soak

Owns:

- Audit all desktop structured events added by the previous spec and current implementation.
- Add missing phase-level events for:
  - supervisor start;
  - DBus start;
  - window manager start;
  - panel start;
  - desktop root start;
  - screenshot capture;
  - black/uniform screenshot detection;
  - VNC port readiness;
  - websockify port readiness;
  - E2B provider port resolution;
  - control-plane proxy handshake;
  - noVNC client open/close.
- Persist sanitized close detail into desktop viewing ticket status for every terminal failure path.
- Add or update dashboard/soak docs only through Terraform/docs, not Datadog UI.
- Run one real Cycloid session and record evidence in the PR body.

Files likely touched:

- `apps/control-plane-worker/src/services/desktop-viewer-proxy.ts`
- `apps/control-plane-worker/src/routes/sessions.ts`
- `apps/control-plane-worker/src/session/desktop-view-tickets.ts`
- `shared/types/desktop-viewer.ts`
- `infra/datadog-desktop.tf`
- `docs/desktop-vnc-soak-criteria.md`
- relevant tests under `tests/test_cloudflare/`, `tests/smoke/`, and `tests/test_agent/`

Tests:

- `npx vitest run tests/test_cloudflare/desktop-viewer-proxy.test.ts tests/test_cloudflare/session/desktop-view-tickets.test.ts --reporter=verbose`
- telemetry tests for secret-free payloads and required fields
- `npm run -w @cycloid/control-plane-worker typecheck`
- `npm run lint:changed`
- real Cycloid session evidence: session URL, prompt, code version/template tag, desktop-ready outcome, live viewer outcome, `desktop.observe` outcome, and screenshot evidence.

## Observability Contract

Do not ship another "Unavailable" state without a safe root-cause detail. At minimum, every failure should classify into one of these phases:

- `sandbox_state`
- `sandbox_backend`
- `sandbox_identity`
- `supervisor_start`
- `dbus_start`
- `x_display`
- `window_manager`
- `desktop_root`
- `panel`
- `screenshot_capture`
- `screenshot_black_or_uniform`
- `vnc_ready`
- `websockify_ready`
- `provider_port_resolve`
- `proxy_handshake`
- `novnc_client`

Safe diagnostic fields:

- environment
- hashed session id
- hashed business id when available
- agent runtime backend
- sandbox template id or hash
- runtime sandbox id hash
- display name
- display width/height
- component
- phase
- error code
- retryable boolean
- elapsed ms
- restart count

Never log:

- provider URLs
- VNC URLs
- ticket tokens
- traffic-access tokens
- cookies
- raw screenshot bytes
- signed artifact URLs
- typed user text

## Implementation Notes

- Keep `DISPLAY=:99` as the default unless a measured reason forces a change.
- If Chromium needs a profile warmup, do it in the sandbox state directory, not the customer repo.
- The model-facing screenshot path should keep using existing image feedback and compression limits. The artifact path can store full-resolution screenshots.
- A maximized browser can still occupy most of the desktop, but full-display screenshots must include desktop shell evidence such as the panel when possible.
- If XFCE-core fails the image-size or startup threshold, implement the smaller fallback: `Xvfb + xfwm4 + xfce4-panel + xfdesktop4 + dbus-x11`, with `thunar` and `xfce4-terminal` deferred until the smoke requires them.
- Do not regress view-only safety. noVNC must remain view-only; human input forwarding is out of scope.

## Required Reads For Implementer

- `docs/conventions.md`
- `docs/testing.md`
- `docs/sandbox-architecture.md`
- `docs/bridge.md`
- `docs/debugging-runbook.md`
- `apps/sandbox-e2b/README.md`
- `docs/superpowers/specs/2026-07-07-session-desktop-vnc-cua-functional-spec.md`

## Publish Requirements

- Use Graphite, not `gh`, to publish.
- Title PRs as `[i/5] <slice title>`.
- Commit body must include `## Plan` and reference this spec path plus the current slice.
- Run relevant focused tests for the slice and `npm run lint:changed`.
- For sandbox-image changes, include the template measurement/build evidence in the PR body.
- Do not stage the earlier untracked `docs/superpowers/specs/2026-07-07-session-desktop-vnc-cua-functional-spec.md` unless the slice explicitly owns edits to it.
