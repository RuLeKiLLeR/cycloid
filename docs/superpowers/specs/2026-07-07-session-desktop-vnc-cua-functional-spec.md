# Session Desktop VNC/CUA Workbench - Functional Spec

**Date:** 2026-07-07
**Status:** Draft
**Owner:** TBD

## Problem

Cycloid can produce code, run tests, and attach screenshot/video evidence, but the user still mostly sees a transcript and final PR outcome. For UI-heavy work, that leaves a trust gap: the reviewer cannot easily tell whether the agent actually operated the app and saw the changed behavior work.

Browser-only automation is not enough for the next bar. Playwright remains the deterministic path for web checks, but it misses browser chrome, file dialogs, terminal UI, Electron/native apps, and general screen-coordinate CUA workflows. Competitors now expose live desktop or browser workbenches, short walkthrough videos, and evidence attached to review surfaces.

## Decision

Build a session-resident Linux desktop inside the existing sandbox. The desktop stack starts with the sandbox and idles for the lifetime of the session. Agents and verification operators use it only when it is useful. Recording is on demand and scoped to verification walkthroughs.

This is not a hosted third-party desktop service. It is a Cycloid-owned sandbox capability that feeds the existing session UI and PR evidence pipeline.

## Goals

- Let coding agents and verification operators operate a real Linux desktop when browser-only tooling is insufficient.
- Let verification produce a short, reviewable walkthrough video showing the agent operating the app.
- Show the user a right-side Desktop / Verification workbench with the agent path, per-action screenshots, app URL, live desktop view, walkthrough video, proof screenshots, and verdict.
- Attach selected visual evidence to the PR as a WebM link and optional proof screenshots.
- Keep Playwright available for deterministic browser assertions and use desktop/CUA as the visual walkthrough and fallback path.
- Keep provider URLs, VNC endpoints, sandbox tokens, and raw desktop state server-side.

## Non-goals

- No human takeover or keyboard/mouse forwarding in V1.
- No shared-control cursor semantics in V1.
- No always-on recording.
- No third-party hosted browser or remote desktop vendor.
- No mobile simulator, GPU-heavy desktop workload, audio, video conferencing, or long full-session recording in V1.
- No guarantee that Linux accessibility APIs work for every app.
- No public/customer-wide rollout until artifact safety is proven in normal internal usage.

## Product Principles

### Always-on desktop, on-demand evidence

The desktop stack is always present so the agent can use it without setup ceremony. Recording starts only when the verification operator begins a meaningful walkthrough. This avoids recording auth/setup, limits file size, and keeps PR evidence focused.

### Evidence is the product

The live desktop is useful, but the durable user value is the verification artifact: planner intent, launcher URL, operator actions with screenshots, video walkthrough, proof screenshots, and verdict. The PR should show what happened without requiring the reviewer to replay the whole session.

### Playwright is not replaced

Use Playwright or browser/CDP tooling when the proof is inside a web page and needs deterministic assertions. Use desktop/CUA when the flow needs browser chrome, native windows, file pickers, terminal UI, Electron/native apps, visual debugging, or screen-coordinate operation.

### The stream is not agent context

The live VNC/noVNC stream is for humans. The model gets screen context through desktop tool responses. Mutating desktop actions return post-action feedback by default, and `desktop.observe` remains available when the agent wants a richer look. This keeps reasoning auditable and avoids relying on a hidden video feed.

## Target Users

- **Coding agent:** Can use the desktop when implementing or debugging UI/native behavior.
- **Verification/QA operator:** Uses the desktop to launch the app, exercise the changed flow, record a walkthrough, and collect evidence.
- **Human user/reviewer:** Watches the workbench in-session and opens the PR evidence link later.

## V1 User Experience

Session detail gains a right-side Desktop / Verification workbench.

The workbench shows:

- Planner decision: what flow or behavior needs visual verification.
- Launcher state: app started and URL, for example `http://127.0.0.1:3000/settings`.
- Desktop state: live view availability and connection state.
- Operator state: verification started, recording started, recording stopped.
- Action path: one screenshot-backed row for each desktop/CUA action.
- Walkthrough video: short WebM captured from the desktop display.
- Final proof: selected screenshot(s) and verdict.
- PR evidence: link to the published WebM and optional screenshot.

The first V1 UI can be view-only. It should not forward human mouse, keyboard, clipboard, or file input to the sandbox.

## Sandbox Desktop Stack

Every eligible sandbox starts these components during sandbox startup:

- X display: `Xvfb` or Xorg virtual display.
- Window manager: `openbox`.
- Browser/runtime deps: Chromium plus common GUI/Electron dependencies and fonts.
- VNC server: `x11vnc` exporting the session display.
- WebSocket bridge: `websockify`.
- Browser viewer assets: noVNC.
- Recorder: `ffmpeg` for WebM display capture.
- Input/window utilities: `xdotool`, `wmctrl`, and a screenshot utility.
- Desktop health process or script that validates the stack.

Default runtime bindings:

- display: `:99`
- resolution: `1280x720x24`
- `DISPLAY=:99`
- VNC: `127.0.0.1:5900`
- websockify/noVNC upstream: `127.0.0.1:6080`

The bridge and agent runtime inherit `DISPLAY` so GUI commands naturally open on the session desktop. Desktop services bind loopback by default. If the sandbox provider requires a non-loopback bind for port forwarding, the provider-facing route must still be protected by provider traffic auth and never returned directly to the browser.

Recording is not part of the always-on stack. `ffmpeg` starts only for an explicit walkthrough recording.

The desktop stack starts in the background during sandbox startup and must not block session start. If the desktop is still booting, the session can begin normal agent work while the UI shows desktop as preparing or unavailable.

## Desktop Health

The desktop is considered available only when all of these pass:

- X display accepts clients.
- Window manager is running.
- A screenshot command can capture a non-empty image.
- VNC server is reachable on the expected local port.
- WebSocket/noVNC endpoint is reachable through the provider-local path.
- The display size is known and stable.

If desktop health fails, the session should continue with a surfaced diagnostic. Desktop unavailability must not break normal coding-agent work.

A lightweight watchdog should periodically check the desktop stack and restart independently failed components when safe:

- restart window manager if it exits;
- restart `x11vnc` or `websockify` if the live view path fails;
- restart the screenshot/desktop metadata path if it wedges;
- mark desktop unavailable only after bounded restart attempts fail.

## Desktop Supervisor Contract

The desktop stack is owned by a sandbox-local supervisor started from the sandbox startup path. It runs in the background and never blocks bridge startup.

State and logs:

- state dir: `/tmp/cycloid-desktop/`
- PID files: `/tmp/cycloid-desktop/pids/*.pid`
- health snapshot: `/tmp/cycloid-desktop/health.json`
- supervisor log: `/tmp/cycloid-desktop/supervisor.log`
- component logs: `/tmp/cycloid-desktop/logs/<component>.log`
- action lock file: `/tmp/cycloid-desktop/action.lock`
- recording state: `/tmp/cycloid-desktop/recording.json`

Supervisor responsibilities:

- start X display, window manager, VNC, and websockify/noVNC in dependency order;
- expose current health as JSON for bridge/control-plane reads;
- restart independently failed WM/VNC/websockify components with bounded backoff;
- never restart the X display while recording unless the display is already unusable;
- if X dies during recording, stop capture, flush a failed manifest, mark the recording unusable for PR evidence, and leave screenshots/notes available;
- on resume, re-run full health checks and restart any missing processes;
- on sandbox stop/pause intent, stop active recording first and flush manifest before the sandbox is paused when the control path allows it.

Restart policy:

- per-component restart budget: 3 attempts in 5 minutes;
- backoff: 1s, 5s, 15s;
- after budget exhaustion, mark desktop `unavailable` with component and last error;
- normal coding-agent work continues even when desktop is unavailable.

Base-image changes must be measured before merge. The implementation PR must include the package list, package/version source, `docker history` or equivalent size delta, ready-check updates, and a rollback note for removing the stack if the size or reliability cost is too high.

## Agent And Operator Tools

Expose a stable desktop tool contract. The agent should not need to know VNC ports, `xdotool`, `ffmpeg`, screenshot paths, or X11 internals.

V1 tools:

- `desktop.observe`
- `desktop.screenshot`
- `desktop.click`
- `desktop.type`
- `desktop.hotkey`
- `desktop.scroll`
- `desktop.drag`
- `desktop.open_app`
- `desktop.windows`
- `desktop.focus_window`
- `desktop.record_start`
- `desktop.record_stop`
- `desktop.record_status`

The verification operator uses the same tool family, with stronger prompting around when to record and what proof to collect.

Canonical transport:

- Sandbox-local CLI: `/app/scripts/cycloid-desktop <command> --json`.
- Bridge dynamic tools: `desktop.*` wrap the CLI and expose typed inputs/outputs to supported backends.
- Backend parity: Codex, Claude Code, opencode, and any future command-capable backend can fall back to the same CLI JSON contract for manual/debug use.
- Production agent use requires verified model-visible image feedback for that backend. If a backend cannot receive desktop screenshots as image content from a desktop tool result, do not register mutating `desktop.*` tools for that backend yet.

All desktop commands must:

- emit JSON only on stdout;
- write diagnostics to stderr and component logs;
- use bounded timeouts;
- reject path traversal and out-of-display coordinates;
- acquire the desktop action lock for mutating actions;
- return the same result shape on success and failure.

Timeout defaults:

- observe/screenshot: 5s
- click/hotkey/scroll/drag: 8s
- type: 15s
- open app: 30s
- record start/stop/status: 15s

Concurrency rule:

- Mutating desktop actions are serialized by a sandbox-local lock.
- `record_start` and `record_stop` also take the lock.
- `record_status` can run without the lock.
- `desktop.observe` may run concurrently unless a mutating action is actively capturing post-action feedback.
- If the lock is busy for more than 10s, return `desktop_busy` with no side effect.

Mutating tools return feedback, not just an acknowledgement. At minimum, each successful action response includes:

- action status and any command/tool error;
- post-action screenshot reference;
- active window title and display size;
- pointer location when available;
- whether the screenshot capture failed.

The post-action screenshot is raw phase evidence, not automatically PR evidence. `desktop.observe` is still useful for a deliberate richer read, but agents should not need to call it after every click just to know what changed.

Every mutating desktop/CUA action should attempt a post-action screenshot. Those action-feedback screenshots are shown in the session workbench as the agent's action path. They remain private session evidence unless explicitly selected as proof screenshots for PR evidence.

## Agent Image Feedback Contract

Desktop/CUA tools must return screenshots in two channels:

1. **Text JSON:** Stable `DesktopToolResult` metadata, paths, ids, warnings, and errors.
2. **Model-visible image content:** The current post-action screenshot as an actual image item delivered to the model backend.

The sandbox-local CLI prints JSON only. The bridge dynamic tool wrapper is responsible for converting safe screenshot paths into backend-native image content. Raw image bytes must never be written to transcript events, SessionDO action-row events, logs, or PR evidence unless the screenshot is explicitly uploaded as an artifact.

Extend first-party dynamic tool results to support image content:

```ts
type FirstPartyDynamicToolContentItem =
  | { type: "inputText"; text: string }
  | {
      type: "inputImage";
      path: string;
      mimeType: "image/jpeg" | "image/png";
      label: string;
      detail: "high" | "low";
      width: number;
      height: number;
      bytes: number;
    };
```

Rules:

- Every successful mutating desktop action returns one `inputText` item containing the JSON result and one `inputImage` item for the current post-action screenshot when capture succeeded.
- `desktop.observe` returns the same text JSON plus a current screenshot image item when capture succeeded.
- The bridge may include up to three recent prior screenshots as `detail:"low"` image items when the backend supports multi-image tool results. The current screenshot is always prioritized over recent context images.
- Recent context images should be downscaled/compressed thumbnails. Target max size is 300 KB each; total model-visible image payload per tool result should stay under 2.5 MB.
- If the current screenshot exceeds the model image cap, recompress/downscale once. If it still cannot be delivered, return `ok:true` for the action, set `warning.code:"model_image_feedback_failed"`, persist the action row, and show the UI screenshot when artifact upload succeeds.
- Image paths accepted by the bridge must be absolute paths under `/tmp/phase-evidence/desktop/<scenario-id>/`; reject symlinks, path traversal, and unsupported MIME types before constructing image content.
- Persisted tool-call output stores the text JSON only. It may include screenshot ids and sandbox-local paths, but not base64 image data.

Backend mapping requirements:

- Codex: map `inputImage` to the existing local-image path flow, Codex MCP tool-result image flow, or an equivalent verified bridge-owned image injection path. Do not rely on JSON-serialized `contentItems` alone.
- Claude Code: map `inputImage` through the first-party MCP/tool projection as image content, or through a verified bridge-owned synthetic image-message injection path, verified against the current SDK before enabling.
- opencode: map `inputImage` through the first-party MCP server as image content, or through a verified bridge-owned synthetic image-message injection path, verified against the current opencode image limits before enabling.
- If any backend cannot pass an automated "desktop screenshot reaches model before next desktop action" fixture, keep `desktop.*` hidden for that backend and log `desktop.model_image_feedback_unsupported`.

### Non-negotiable Backend Readiness Gate

Model-visible desktop screenshots are a launch blocker, not a nice-to-have. V1 cannot ship with desktop/CUA enabled unless this gate passes for:

- Codex.
- Claude Code.
- An explicit allowlist of opencode models that support image input strongly enough for desktop screenshots.

The gate is based on observed behavior, not SDK type signatures or documentation alone. Each enabled backend/model must pass an automated visual-feedback fixture that:

1. Creates a deterministic test image with text, color blocks, and a pointer/click marker.
2. Returns that image from a first-party dynamic tool using the same path desktop tools will use.
3. Asks the model, before any next desktop action is allowed, to identify fields visible only in the image.
4. Fails if the model can answer using surrounding text alone.
5. Records backend, model id, image delivery path, image byte size, latency, and pass/fail.

Every backend must have two delivery strategies defined:

- **Primary path:** native tool-result image content when the runtime supports it cleanly.
- **Fallback path:** bridge-owned synthetic image context injection before the next model step. This is allowed only when it is invisible to the user transcript except for normal tool/action metadata, preserves action ordering, and proves the model sees the screenshot before deciding the next CUA action.

Desktop tools may be registered for a backend/model only when at least one delivery strategy passes the fixture. If both paths fail, the backend/model is marked desktop-image-feedback unsupported and must not receive mutating desktop tools.

For opencode, do not infer support from provider family or model name. Add an explicit `desktopImageFeedback` capability in the model/backend registry for the approved model set, backed by the fixture result. Unsupported opencode models can still use non-desktop tools but must not receive `desktop.*`.

The bridge must enforce this at runtime:

- Validate backend/model image-feedback support during tool registration.
- Refuse to start a desktop mutating action if the current backend/model lost image-feedback support after registration.
- Emit `desktop.model_image_feedback_unsupported` with backend/model/capability reason.
- Surface a clear diagnostic in the session instead of silently falling back to text-only desktop feedback.

Implementation cannot proceed past the backend-adapter stack slices until Codex, Claude Code, and the first approved opencode model pass this gate in local or disposable E2B verification. The later sandbox/UI/recording PRs should not assume image feedback will be solved later.

Acceptance for this contract:

- A test tool returns a known image and each enabled backend demonstrably receives enough image content to answer a visual question about it.
- Codex, Claude Code, and at least one approved opencode model pass the visual-feedback fixture before desktop tools are wired into the sandbox runtime.
- Transcript persistence, SessionDO events, and logs contain no raw image bytes.
- When model image delivery fails, the action still records user-visible metadata and a clear warning.

## Tool Schema And Action Feedback

Coordinates are display pixels with origin at the top-left corner of the 1280x720 display. Coordinates outside the current display are rejected before any action runs.

All desktop tool responses use this shape:

```ts
type DesktopToolResult = {
  ok: boolean;
  actionId: string;
  action: string;
  startedAtMs: number;
  completedAtMs: number;
  display: {
    width: number;
    height: number;
    scale: 1;
  };
  activeWindow: {
    title: string | null;
    process: string | null;
    bounds: { x: number; y: number; width: number; height: number } | null;
  };
  pointer: { x: number; y: number } | null;
  screenshot: {
    path: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: "image/jpeg" | "image/png";
    purpose: "action_feedback" | "observe" | "proof_candidate";
  } | null;
  recentScreenshots: Array<{
    actionId: string;
    path: string;
    capturedAtMs: number;
    purpose: "action_feedback" | "observe" | "proof_candidate";
  }>;
  warning: { code: string; message: string } | null;
  error: { code: string; message: string; retryable: boolean } | null;
};
```

`screenshot.path` is a sandbox-local absolute path under `/tmp/phase-evidence/desktop/<scenario-id>/`. Tool results never return signed artifact URLs, provider URLs, or raw image bytes.

Failure behavior:

- If an action fails before touching the desktop, return `ok:false` and attempt a screenshot if the desktop is healthy.
- If the action runs but post-action screenshot capture fails, return `ok:true`, `screenshot:null`, and `warning.code:"screenshot_failed"`.
- If screenshot quota is exceeded, return `ok:true` for the action, `screenshot:null`, and `warning.code:"screenshot_quota_exceeded"`.
- If desktop health is unavailable, return `ok:false`, `error.code:"desktop_unavailable"`, and no side effect except diagnostics.

Action trace entries never store raw typed text. They may store action type, coordinates, window title, screenshot id, typed character count, and `inputRedacted:true`.

The action trace is also a UI contract. Each desktop/CUA action becomes a workbench timeline row with:

- action label and timestamp;
- status and warning/error code when present;
- active window title;
- typed character count instead of typed text;
- thumbnail from the post-action screenshot when capture succeeded;
- "screenshot unavailable" state when capture failed or quota was exceeded.

## Session-Private Action Screenshots

Workbench action screenshots must be viewable by the user during the session, but they are not PR evidence by default.

After a desktop action captures its post-action screenshot:

1. The sandbox keeps the raw file under `/tmp/phase-evidence/desktop/<scenario-id>/`.
2. The bridge registers the screenshot as a session-private action artifact.
3. The control plane returns or later resolves an authenticated `viewUrl` for the UI.
4. The Desktop / Verification workbench renders that `viewUrl` as the action row thumbnail.

Action screenshot records should include:

```ts
type DesktopActionScreenshotRef = {
  actionId: string;
  artifactId: string;
  kind: "desktop_action_screenshot";
  artifactAccessVisibility: "private";
  label: string;
  viewUrl: string;
  width: number;
  height: number;
  bytes: number;
  capturedAtMs: number;
  selectedForEvidence: boolean;
  status: "available" | "failed" | "quota_exceeded" | "pruned";
};
```

Rules:

- The `viewUrl` is authenticated and session-scoped.
- Action screenshots are normal private screenshot artifacts with metadata `kind:"desktop_action_screenshot"`, `actionId`, `phase`, `scenarioId`, and `selectedForEvidence:false`.
- Do not add a third artifact access visibility class for V1. Existing artifact access remains `private` or `public`; desktop action screenshots start as `private`.
- Selecting an action screenshot for PR evidence creates or promotes a separate publishable proof artifact rather than mutating the original action screenshot into public evidence.
- Raw image bytes are never embedded in transcript events.
- The workbench can show many action screenshots; the PR evidence pipeline still publishes only selected proof screenshots and at most one WebM.
- If pruning removes an action-feedback file, the action row remains and the screenshot ref status becomes `pruned`.

This should extend the current product UI rather than overload the existing prompt screenshot rail. Today, session turns already render agent screenshot artifacts as thumbnails grouped by `promptId`. Desktop/CUA action screenshots need a separate action path because their primary grouping is "what happened on the desktop", not "which transcript turn uploaded an image."

Storage and update path:

- Source of truth: SessionDO storage, keyed by session id and action id.
- Do not use D1 as the source of truth for V1; action rows are session-scoped runtime evidence, not cross-session query data.
- Action-row registration is idempotent by `actionId`. A retry with the same `actionId` updates the same row only when the new row has a higher `updatedAtMs` or fills previously missing screenshot metadata.
- Persist the action row in SessionDO storage before broadcasting the desktop action session event. If broadcast fails, the REST snapshot must still show the row.
- Assign each persisted row a monotonic `desktopActionSeq` so the UI can reconcile missed events after reconnect.
- Cap stored action rows to the session screenshot quota. When pruning removes an old screenshot file or artifact, keep the action row and update only the screenshot status.
- The control plane exposes a REST snapshot endpoint for the current action path.
- The bridge emits small JSON session events when new action rows are registered.
- The UI updates live from those session events and falls back to the REST snapshot on load, reconnect, or missed events.
- Session events carry row metadata and artifact ids, not raw image bytes.

Implementation path:

1. Define shared `DesktopActionPathRow` and `DesktopActionScreenshotRef` types.
2. Let the bridge register a desktop action row after each desktop/CUA action.
3. Store post-action screenshots through the existing session artifact infrastructure.
4. Resolve screenshot thumbnails through the existing authenticated artifact `viewUrl` path.
5. Add a typed UI API and hook such as `fetchSessionDesktopActionPath` / `useSessionDesktopActionPath`.
6. Subscribe the hook to desktop action session events so rows appear without waiting for polling.
7. Render rows in a new `SessionDesktopWorkbench`, reusing the existing thumbnail and image-preview interaction patterns.
8. Keep the main transcript uncluttered by default; it can link to the desktop action path but should not inline every CUA action screenshot.

Suggested row shape:

```ts
type DesktopActionPathRow = {
  actionId: string;
  desktopActionSeq: number;
  sessionId: string;
  promptId: string | null;
  phase: "agent" | "verification_operator";
  action: "observe" | "screenshot" | "click" | "type" | "hotkey" | "scroll" | "drag" | "open_app" | "focus_window";
  label: string;
  status:
    | "completed"
    | "action_failed"
    | "desktop_unavailable"
    | "screenshot_failed"
    | "quota_exceeded"
    | "pruned";
  activeWindowTitle: string | null;
  warningCode: string | null;
  errorCode: string | null;
  screenshot: DesktopActionScreenshotRef | null;
  selectedForEvidence: boolean;
  createdAtMs: number;
  updatedAtMs: number;
};
```

Every desktop/CUA tool invocation creates an action row, even when the action fails before a screenshot can be captured. Users should see gaps as explicit failed rows, not missing history.

## Screen Context For The Agent

`desktop.observe` returns layered context:

1. Screenshot as the ground truth image.
2. Display size and pointer location.
3. Active window title and process when available.
4. Window list with bounds and titles.
5. Optional browser/CDP summary when the active window is Chromium and a CDP endpoint is available.
6. Optional accessibility tree later, when reliable enough for the app type.

Linux accessibility should not be the foundation for V1. It is valuable when it works, but screenshot + window metadata is the reliable baseline across browser, Electron, and native apps.

`desktop.observe` and mutating action feedback should save screenshots under phase evidence and return model-consumable image references. Agents may take screenshots liberally while operating the desktop. Only selected screenshots are promoted to `/tmp/cycloid-evidence/` or rendered in the PR.

The agent context window should include only the recent visual trail by default:

- return the current post-action screenshot;
- include references to the previous 3 to 5 desktop screenshots from the same prompt or verification phase;
- do not resend older screenshots unless the agent explicitly asks for them by action id or screenshot id;
- keep full-resolution image bytes artifact-backed, not repeatedly embedded in every tool result.

## Screenshot Quotas And Pruning

Raw desktop screenshots are useful for agent reasoning but must stay bounded.

Defaults:

- action feedback screenshots: JPEG, quality 80, 1280x720;
- explicit proof screenshots: PNG unless the file would exceed 5 MB, then JPEG quality 90;
- max screenshot file size: 1.5 MB for action feedback, 5 MB for proof candidates;
- max screenshots per prompt: 150;
- max screenshots per session: 500;
- max raw desktop evidence per session: 256 MB.

When limits are reached:

- mutating actions still run, but post-action screenshot feedback is skipped with `screenshot_quota_exceeded`;
- `desktop.observe` returns `ok:false` with `error.code:"screenshot_quota_exceeded"` unless the caller marks the screenshot as a proof candidate;
- proof-candidate screenshots can exceed per-prompt count limits but not file-size or total-session byte limits;
- the supervisor prunes oldest non-selected action-feedback screenshots before failing new captures;
- if an action-feedback screenshot is pruned, its workbench row remains but the thumbnail shows `screenshot pruned`;
- selected `/tmp/cycloid-evidence/` artifacts are never pruned by the desktop screenshot cleanup path.

## Recording Behavior

The operator starts recording after auth/setup and after the meaningful walkthrough begins.

A V1 walkthrough recording should:

- Capture the whole desktop display.
- Be WebM.
- Default to 1280x720.
- Prefer 10 to 60 seconds.
- Show cursor position.
- Show click rings.
- Show generic typing indicators without recording secret values in the manifest.
- Stop when the changed state is visibly proven.
- Produce or select screenshot(s) at useful proof points.

Encoding defaults:

- capture: `ffmpeg` X11 grab from display `:99`;
- codec: VP8 WebM;
- frame rate: 10 FPS;
- max duration: 60s hard cap;
- target duration: 10 to 45s;
- max output size: 50 MB;
- display resolution: 1280x720.

Overlay decision:

- V1 uses action-trace post-processing for click rings and typing indicators.
- The recording captures the real cursor where possible.
- After `record_stop`, overlay post-processing burns click rings and generic typing markers into the WebM from the private action trace.
- If overlay post-processing fails, keep the raw WebM private, mark `overlayStatus:"failed"` in the manifest, and require screenshots or a successful re-recording before publishing video evidence.
- Do not use a live overlay window in V1; it adds focus/window-order flake to the desktop itself.

Secret guardrails:

- `record_start` requires `acknowledgeNoSecrets:true` and a scenario label.
- `record_start` emits a session event visible in the workbench: recording started.
- `record_stop` emits a session event: recording stopped.
- `desktop.type` never writes raw typed text to manifests, logs, or tool results.
- Secret entry should use a redacted secret reference path when available; otherwise the operator must stop recording before entering secrets.
- If a tool marks an input as sensitive while recording is active, record only typed character count and `inputRedacted:true`.

Raw recording output lands under:

```text
/tmp/phase-evidence/desktop/<scenario-id>/
```

Selected publishable artifacts are copied to:

```text
/tmp/cycloid-evidence/
```

The artifact bundle includes:

- `walkthrough.webm` - public/linkable when selected.
- screenshots - raw reasoning screenshots are allowed freely under phase evidence; selected final or proof screenshots are optional public artifacts.
- `manifest.json` - private/internal by default.
- `operator-notes.md` or equivalent phase notes - private/internal by default.

Only screenshots and WebM videos may become PR evidence without a new allowlist and tests.

Manifest shape:

```ts
type DesktopRecordingManifest = {
  version: 1;
  scenarioId: string;
  label: string;
  display: { width: 1280; height: 720; scale: 1 };
  recording: {
    status: "completed" | "failed" | "interrupted";
    startedAtMs: number;
    stoppedAtMs: number | null;
    durationMs: number | null;
    rawWebmPath: string | null;
    overlayWebmPath: string | null;
    bytes: number | null;
    codec: "vp8";
    fps: 10;
    overlayStatus: "applied" | "failed" | "not_attempted";
    failureReason: string | null;
  };
  screenshots: Array<{
    id: string;
    path: string;
    purpose: "action_feedback" | "observe" | "proof_candidate";
    selectedForEvidence: boolean;
    bytes: number;
  }>;
  actions: Array<{
    actionId: string;
    type: string;
    atMs: number;
    x: number | null;
    y: number | null;
    activeWindowTitle: string | null;
    screenshotId: string | null;
    typedCharacterCount: number | null;
    inputRedacted: boolean;
  }>;
};
```

## Action Trace

The video alone is pixels. The workbench and private manifest should also preserve the agent path:

- Planner selected verification target.
- Launcher started app and emitted URL.
- Operator opened the app on the desktop.
- Operator started recording.
- Operator clicked/typed/scrolled through the flow.
- Each operator action returned post-action feedback for the agent and created a user-visible workbench timeline row.
- Operator stopped recording.
- Operator captured or selected useful proof screenshots.
- Judge/verifier produced verdict.

The public PR comment should stay concise. It links the WebM and optionally shows selected proof screenshots. The detailed manifest stays private unless explicitly made safe.

## Session UI

V1 workbench layout:

- A compact timeline of verification steps.
- A live desktop panel, view-only.
- An action path timeline with one screenshot-backed row per desktop/CUA action.
- A recording card once a walkthrough exists.
- A proof screenshot card when selected.
- A verdict card.
- PR evidence links when published.

The desktop panel should be visually subordinate to the session content but easy to inspect while the agent runs. It should use the authenticated UI design system and sentence-case product copy.

Live pixels must not use the normal transcript WebSocket. They should use a dedicated same-origin WebSocket route.

Workbench states:

- `preparing`: desktop stack has not passed health yet;
- `unavailable`: desktop health failed after bounded restart attempts;
- `connecting`: viewer ticket created and WebSocket connecting;
- `connected`: live view is receiving frames;
- `recording`: recording is active and visible to the user;
- `recording_failed`: recording failed or overlay post-processing failed;
- `artifact_too_large`: WebM exceeded publish limit;
- `completed`: selected evidence and verdict are available.

Action path behavior:

- Render action rows in order.
- Show a 1280x720-derived thumbnail for each successful post-action screenshot.
- Let the user expand a thumbnail into the normal image preview modal.
- Fetch thumbnails through authenticated session-private `viewUrl`s.
- Update rows live from desktop action session events, with REST snapshot fallback on reconnect.
- Keep action screenshots session-private by default.
- Do not publish action screenshots to PR evidence unless the verifier selects them as proof screenshots.
- If a row's screenshot was pruned, failed, or skipped due to quota, keep the row and show a clear placeholder.

## Control Plane And Proxying

Reuse PR #6840's security pattern, not its browser-stream substrate:

- Authenticated route creates a short-lived desktop viewing ticket.
- Session Durable Object stores ticket state.
- Ticket has heartbeat, revoke, expiry, and hard max lifetime.
- UI connects through a same-origin WebSocket.
- Control plane proxies to the sandbox-local websockify/noVNC upstream.
- Provider-local URLs, VNC ports, traffic-access tokens, and sandbox auth material never reach durable session view or browser state.
- V1 relies on server-side VNC view-only mode and noVNC view-only UI, not a custom RFB parser, unless tests prove input can still affect the sandbox.

V1 remains view-only. Human control can be layered later with explicit leases and agent input queuing.

View-only enforcement is layered:

- noVNC UI is configured as view-only with no clipboard or input controls.
- `x11vnc` runs in view-only mode and disables clipboard mutation where supported.
- The control-plane proxy authenticates and scopes the WebSocket but does not hand-parse RFB in V1.

Input-blocking proof:

- tests must attempt keyboard input, pointer clicks, pointer drags, and clipboard updates through the viewer path;
- the desktop state must not change from those attempted inputs;
- if server-side view-only mode fails any input-blocking test, V1 must add proxy-side RFB input filtering before release;
- proxy-side filtering, if required, must use a tested parser and allow normal viewer protocol messages while blocking `KeyEvent`, `PointerEvent`, and `ClientCutText`.

This keeps V1 view-only without making the first implementation depend on a fragile partial RFB parser.

## Route Limits And Backpressure

Desktop routes are authenticated but still need moderate rate limits because live-view reconnects, artifact thumbnails, and action-path snapshots can create bursty traffic.

Initial limits:

- Desktop viewing ticket create: 20 per minute per user-session, burst 10.
- Desktop WebSocket connect/reconnect: 60 per minute per session, burst 20.
- Concurrent desktop viewers: 5 per session in V1.
- Action-path REST snapshot: 30 per minute per viewer-session; allow a 2s edge/cache reuse window for identical snapshot reads.
- Action screenshot authenticated view URLs: use the existing artifact proxy limits; add per-session accounting for desktop action screenshot reads.
- Proof selection/promote calls: 20 per minute per session, burst 10.
- Desktop stream heartbeat/revoke calls: exempt from normal mutation limits but bounded by ticket lifetime and connection count.

Behavior:

- Rate-limited requests return `429` with `Retry-After`.
- A rate-limited mutation must not create tickets, promote artifacts, register rows, or touch sandbox state.
- Rate limits are keyed by session id plus authenticated user id where available; avoid global limits that can make one busy session affect another.
- Internal sandbox/bridge calls that register action rows and upload screenshots use existing sandbox auth and should have higher service-side budgets, but still emit abuse diagnostics if they exceed expected rates.
- UI should treat rate limits as a temporary degraded state, not a fatal session error.

## Security And Privacy

Security requirements:

- Authenticated session access only; stream access must not rely on UI exposure.
- Control plane owns auth, authorization, ticket creation, provider access, and proxying.
- UI gating is exposure-only, not security.
- No direct VNC/noVNC provider URLs in the browser.
- No query-string bearer tokens for stream auth.
- No logs containing VNC URLs, ticket tokens, traffic-access tokens, cookies, screenshots, or frame payloads.
- Recording off during auth/setup by default.
- Clear session event when recording starts and stops.
- Secret typed values are never written to manifests or action traces.
- Auth state files under `/tmp/cycloid-auth/` are never artifacts.
- Video duration and size are capped.
- Raw screenshots may be numerous, but only selected screenshots are published.
- Artifact publication uses the existing artifact proxy and public/private artifact rules.

Failures should fail closed for stream access and fail soft for desktop availability. If the desktop cannot start, the agent can still code, test, and publish normal evidence.

## App Runtime Integration

The launcher remains responsible for starting the app through App Runtime Profiles.

The desktop workbench consumes launcher output:

- runtime kind
- app URL
- ready status
- auth status when applicable
- diagnostics when the runtime cannot start

The operator can then open the app URL on the desktop and record the walkthrough. For localstack or Docker Compose apps, this means the desktop browser uses the same sandbox-local app URL the agent and tests use.

## Pause, Resume, And Session Lifecycle

Desktop lifecycle follows sandbox lifecycle.

- On sandbox startup, the supervisor starts desktop components in the background.
- On bridge reconnect or sandbox resume, the control plane treats previous desktop viewing tickets as invalid and requires new tickets.
- On resume, the supervisor re-runs full health checks and restarts missing desktop components.
- Active recordings are not resumed after pause.
- If the control plane is about to pause a sandbox and a recording is active, the bridge/supervisor should stop recording, flush the manifest as `interrupted`, and mark the video private unless it is complete and under size limits.
- If the sandbox is paused without a clean stop hook, the next resume marks any stale `recording.json` as `interrupted` before allowing a new recording.
- Live desktop UI should show `reconnecting` or `desktop unavailable` until fresh health and a fresh viewing ticket succeed.

## PR Evidence

The PR evidence should be short and reviewer-friendly:

- Link: "Desktop walkthrough video"
- Optional proof screenshot inline or linked, following existing screenshot publishing behavior.
- Summary: one sentence naming the verified flow.
- Caveat: if recording failed or was intentionally omitted.

The PR should not include raw manifests, logs, auth state, or long action traces.

## Evidence Selection Contract

The verification operator/verifier promotes evidence by copying selected files from `/tmp/phase-evidence/desktop/<scenario-id>/` into `/tmp/cycloid-evidence/`. Judge automation is not the V1 owner of proof selection.

Selection UX:

- The workbench lets the verifier mark or unmark action screenshots as proof candidates.
- Marking a screenshot as proof does not publish it immediately; it only makes it eligible for `/tmp/cycloid-evidence/` promotion.
- Recording cards can be selected for PR evidence only when the manifest is complete and publishable.
- The UI shows which action screenshots are selected for evidence.

Selection rules:

- publish at most one desktop WebM per verification run;
- publish at most three proof screenshots per verification run;
- publish no video if `overlayStatus` is `failed`, size exceeds 50 MB, duration exceeds 60s, or manifest status is not `completed`;
- publish screenshots when video is omitted or insufficient;
- never publish `manifest.json`, action traces, logs, auth state, raw frame directories, or partial recordings.

Naming:

- `desktop-<scenario-id>-walkthrough.webm`
- `desktop-<scenario-id>-proof-<n>.png`

PR comment shape:

```text
Desktop walkthrough: <video link>
Proof screenshots: <screenshot links when selected>
Verified flow: <one sentence>
Evidence caveat: <only when recording failed, was omitted, or screenshots carry the proof>
```

If recording fails, the verification result can still be conclusive only when screenshots plus tests/logs/API proof cover the merge-critical behavior. Otherwise the verifier should mark visual evidence inconclusive.

## Functional Acceptance Criteria

V1 is complete when:

- A new sandbox session has a running desktop stack without agent setup.
- A desktop health check proves the display, WM, screenshot path, VNC, and noVNC/websockify path work.
- Desktop services bind to the defined local ports and do not expose provider URLs to the browser.
- The agent or verification operator can call `desktop.observe` and receive a screenshot plus window metadata.
- The operator can click/type/hotkey/scroll on the desktop and observe the result.
- Mutating desktop actions return post-action screenshot feedback and window metadata.
- Enabled agent backends receive the current post-action screenshot as model-visible image content, not only as JSON text.
- Codex, Claude Code, and the approved opencode desktop model set pass the non-negotiable visual-feedback fixture.
- Each mutating desktop/CUA action appears in the workbench action path with its screenshot or a clear unavailable/pruned placeholder.
- Each available action screenshot has an authenticated session-private `viewUrl` and can be expanded by the user.
- Action path rows update live from session events and recover from REST snapshot on reconnect.
- Action screenshots are stored as private `desktop_action_screenshot` artifacts and are not PR evidence unless selected/promoted.
- Duplicate action-row registration with the same `actionId` is idempotent and does not create duplicate UI rows.
- Desktop actions are serialized and return `desktop_busy` instead of racing.
- Desktop ticket, stream, snapshot, and proof-selection routes enforce moderate per-session rate limits.
- The operator can record a short WebM walkthrough and capture proof screenshots.
- Recording output follows the WebM encoding, overlay, duration, and size contract.
- The workbench shows planner decision, launcher URL, operator steps, walkthrough video, selected screenshots, and verdict.
- A selected WebM is published as a PR evidence link.
- Selected proof screenshots are published when useful.
- The implementation has a desktop-app smoke fixture, such as a minimal Electron or GTK app, proving this is not browser-only.
- Pause/resume invalidates old desktop tickets and re-healthchecks the desktop.
- If desktop startup fails, normal session execution continues and the UI shows a clear unavailable state.
- After implementation, one real Cycloid session proves live desktop, action screenshots, video recording, selected PR evidence, and blocked viewer input attempts end to end.

## Rollout Plan

### Phase 0 - Spec and measurement

- Finalize this functional spec.
- Measure base image size delta for the desktop package set.
- Use 1280x720 as the default display resolution.

### Phase 1 - Sandbox desktop runtime

- Add packages to the E2B template.
- Start the desktop stack during sandbox startup.
- Start the desktop stack in the background so desktop boot never blocks normal session startup.
- Export `DISPLAY` to bridge and agent runtime.
- Add ready-check coverage for desktop health.
- Add watchdog/restart logic for X/WM/VNC/websockify/screenshot-path failures.
- Add one local/e2b smoke that captures a screenshot from the desktop.
- Add exact port/binding validation for display, VNC, and websockify.

### Phase 2 - Desktop tools

- Add the desktop tool contract.
- Extend first-party dynamic tool results with model-visible image content and implement adapter mappings for every backend where desktop tools are registered.
- Implement observe, screenshot, click, type, hotkey, scroll, drag, open app, windows, and focus window.
- Return post-action screenshot feedback and window metadata from mutating tools.
- Return the current screenshot as model-visible image content from observe and mutating actions.
- Store raw reasoning screenshots under phase evidence.
- Enforce screenshot quotas, pruning, and desktop action serialization.
- Enforce model-visible image size caps and recent-context image downscaling.
- Add tests for command construction, path containment, and failure states.

### Phase 3 - Recording

- Implement recording start/stop/status.
- Capture WebM with ffmpeg from the display.
- Apply cursor/click/typing overlays from action-trace post-processing.
- Write private manifest and selected proof screenshot(s).
- Enforce size and duration caps.

### Phase 4 - Workbench UI and proxy

- Add desktop viewing tickets using the PR #6840 pattern.
- Proxy view-only noVNC/websockify through the control plane.
- Enforce server-side view-only VNC and noVNC view-only UI; add proxy-side RFB filtering only if input-blocking tests prove it necessary.
- Add Desktop / Verification workbench in session detail.
- Add action path timeline rows and screenshot thumbnail expansion.
- Add session-private action screenshot indexing and authenticated `viewUrl` resolution.
- Add session-event live updates for action rows, with REST snapshot fallback.
- Add idempotent action-row registration with persist-before-broadcast semantics.
- Add proof-candidate selection controls for action screenshots.
- Add moderate rate limits and `Retry-After` handling for desktop viewing, snapshot, and promotion routes.
- Keep live pixels off the transcript WebSocket.

### Phase 5 - PR evidence

- Let the verifier select WebM and proof screenshot(s) for `/tmp/cycloid-evidence/`.
- Publish WebM as a PR evidence link.
- Publish optional proof screenshots through the existing screenshot path.
- Add tests for artifact classification and unsafe artifact exclusion.

## Graphite Stack Slices

Implement as a Graphite stack of small PRs. Each PR must be green on its own, depend only on the previous PR, and avoid unrelated refactors. Do not add a feature flag; early PRs should be inert by construction because no UI entry point or desktop tool registration calls them until the stack wires those surfaces.

Each PR should include its own observability for the paths it introduces. The final observability PR is for dashboarding, baseline checks, and missing instrumentation cleanup, not for retrofitting all telemetry at the end.

PRs 1-4 are the image-feedback preflight. Do not start the sandbox desktop runtime PRs until Codex, Claude Code, and at least one approved opencode model pass the visual-feedback fixture through either the native tool-result image path or the synthetic image-context injection fallback.

### PR 1 - First-party tool image result contract

Owns:

- Add `inputImage` to first-party dynamic tool result types.
- Add shared helpers that validate image path containment, MIME type, byte size, and dimensions.
- Keep persisted transcript/tool output text-only by default.
- Add a test-only dynamic tool fixture that returns a known image.
- Add shared fixture utilities for deterministic visual questions that cannot be answered from text.

Tests:

- Unit tests for safe path rejection, symlink/path traversal rejection, MIME rejection, byte limits, and JSON-only persistence.
- No desktop packages, no sandbox runtime changes, no UI.

### PR 2 - Codex image feedback adapter

Owns:

- Map `inputImage` to model-visible image content for Codex.
- Implement the synthetic image-context injection fallback for Codex if native tool-result images are insufficient.
- Add a Codex availability gate so future desktop tools are hidden unless the Codex image-feedback fixture passes.
- Emit `desktop.model_image_feedback_unsupported` when Codex image feedback is unavailable.

Tests:

- Focused Codex fixture proving a known image reaches the model before the next desktop action.
- Regression test that JSON-serialized `contentItems` alone is not treated as sufficient desktop image feedback.
- Failure test proving `desktop.*` is hidden when both Codex delivery paths fail.

### PR 3 - Claude Code image feedback adapter

Owns:

- Map `inputImage` through the Claude Code first-party MCP/tool projection as image content.
- Implement the synthetic image-context injection fallback for Claude Code if native MCP tool-result images are insufficient.
- Add a Claude availability gate so future desktop tools are hidden unless the Claude image-feedback fixture passes.
- Preserve text-only transcript persistence.

Tests:

- Focused Claude fixture proving a known image reaches the model before the next desktop action.
- Persistence test proving Claude tool events do not store base64 image bytes.
- Failure test proving `desktop.*` is hidden when both Claude delivery paths fail.

### PR 4 - opencode image feedback adapter

Owns:

- Map `inputImage` through the opencode first-party MCP server as image content.
- Implement the synthetic image-context injection fallback for opencode if native MCP tool-result images are insufficient.
- Add an explicit approved opencode desktop model allowlist backed by fixture results.
- Add an opencode availability gate so future desktop tools are hidden unless the current opencode model is on the approved allowlist and its image-feedback fixture passes.
- Enforce current opencode image size/MIME limits before returning image content.

Tests:

- Focused opencode fixture proving a known image reaches each approved opencode model before the next desktop action.
- Limit tests for unsupported MIME and oversized image handling.
- Failure test proving unsupported opencode models do not receive `desktop.*`.

### PR 5 - Desktop package measurement and sandbox base image

Start this PR only after PRs 1-4 pass the image-feedback preflight.

Owns:

- Add the minimum desktop package set to the E2B template: X display, openbox, Chromium GUI deps/fonts, x11vnc, websockify/noVNC, ffmpeg, xdotool/wmctrl, screenshot utility.
- Document package/version source and image size delta.
- Keep services installed but not yet started.

Tests:

- Template build/smoke proving binaries exist.
- Size-delta note in the PR body.
- No desktop tools or UI.

### PR 6 - Desktop supervisor and health

Owns:

- Add sandbox-local desktop supervisor startup in the background.
- Start X display, window manager, VNC, and websockify/noVNC on loopback ports.
- Write `/tmp/cycloid-desktop/health.json`, PID files, and component logs.
- Add bounded restart logic for WM/VNC/websockify/screenshot path.
- Export `DISPLAY=:99` to bridge/agent runtime.
- Emit startup, health, and restart instrumentation.

Tests:

- Supervisor unit/shell tests for health JSON, restart budget, and non-blocking startup.
- Sandbox smoke capturing one non-empty screenshot at 1280x720.
- Port binding validation for loopback-only services.

### PR 7 - Desktop CLI observe and screenshot

Owns:

- Add `/app/scripts/cycloid-desktop`.
- Implement `observe`, `screenshot`, `windows`, and health/status reads.
- Return the `DesktopToolResult` JSON shape.
- Save screenshots under `/tmp/phase-evidence/desktop/<scenario-id>/`.
- Enforce screenshot path containment and basic quotas for read-only capture.
- Emit screenshot capture instrumentation.

Tests:

- CLI contract tests for success/failure JSON, desktop unavailable, quota exceeded, path containment, and non-empty screenshots.
- No mutating desktop actions yet.

### PR 8 - Desktop CLI mutating actions

Owns:

- Implement `click`, `type`, `hotkey`, `scroll`, `drag`, `open_app`, and `focus_window`.
- Add desktop action lock and `desktop_busy`.
- Add post-action screenshot feedback for every mutating action.
- Redact typed values from traces/logs/results and store typed character count only.
- Emit desktop action duration/failure instrumentation.

Tests:

- CLI tests for input validation, out-of-bounds rejection, serialization, timeout behavior, failed-action screenshot attempt, and typed-value redaction.
- Smoke against a tiny local GUI target where click/type changes visible state.

### PR 9 - Desktop dynamic tools

Owns:

- Register `desktop.*` first-party dynamic tools only for backends whose image-feedback adapter gate passes.
- Wrap the desktop CLI and return both text JSON and model-visible current screenshot image.
- Include up to 3 recent screenshot references/images when supported and under size caps.
- Emit `desktop.tool_action` and `desktop.model_image_feedback` instrumentation.

Tests:

- Dynamic tool tests for each desktop command's input schema, timeout, screenshot image content, unsupported-backend hidden state, and failure mapping.
- Persistence tests proving image bytes do not enter transcript/session events.

### PR 10 - SessionDO desktop action path API

Owns:

- Add SessionDO storage for `DesktopActionPathRow`.
- Add idempotent registration by `actionId`.
- Add monotonic `desktopActionSeq`.
- Persist rows before broadcasting events.
- Add REST snapshot endpoint and typed internal route/client.
- Emit action-row persistence instrumentation.

Tests:

- SessionDO tests for idempotency, persist-before-broadcast recovery, sequence ordering, snapshot after missed events, and auth/access failure.
- Rate limit test for snapshot reads.
- No UI rendering yet.

### PR 11 - Action screenshot artifact registration

Owns:

- Store action screenshots through existing session artifact infrastructure as private screenshot artifacts with `metadata.kind:"desktop_action_screenshot"`.
- Resolve authenticated `viewUrl`s for action screenshots.
- Preserve action rows when screenshots are pruned, failed, or quota-skipped.
- Add pruning/accounting for action screenshot quotas.

Tests:

- Artifact tests proving private access, no public token, metadata shape, authenticated view route, prune state, and no PR publication by default.
- UI/API contract fixture for `DesktopActionScreenshotRef`.

### PR 12 - Session Desktop workbench action path UI

Owns:

- Add `fetchSessionDesktopActionPath` and `useSessionDesktopActionPath`.
- Render `SessionDesktopWorkbench` with action rows, thumbnails, placeholders, expansion, and proof selection state.
- Subscribe to desktop action session events and reconcile from REST snapshot on reconnect.
- Keep screenshots out of the main transcript by default.

Tests:

- UI tests for loading, reconnect snapshot fallback, row ordering, thumbnail expansion, failed/pruned/quota placeholders, and proof-selected state.
- No live VNC panel yet.

### PR 13 - View-only desktop proxy backend

Owns:

- Add desktop viewing tickets with heartbeat, revoke, expiry, hard max lifetime, and moderate rate limits.
- Proxy noVNC/websockify through a same-origin authenticated route.
- Configure x11vnc/noVNC view-only server-side.
- Keep provider URLs, VNC ports, traffic-access tokens, and sandbox auth material out of browser/session state.
- Emit proxy ticket, connect, close, input-block, and rate-limit instrumentation.

Tests:

- Control-plane tests for ticket lifecycle, provider URL containment, rate limits, stale ticket rejection, and no side effects after `429`.
- Browser/proxy tests attempting keyboard, pointer, drag, and clipboard input through the viewer path.
- Add proxy-side RFB filtering only if server-side view-only fails these tests.

### PR 14 - Live desktop panel UI

Owns:

- Add the view-only live desktop panel to `SessionDesktopWorkbench`.
- Render preparing, connecting, connected, reconnecting, unavailable, and rate-limited states.
- Connect through the ticketed same-origin WebSocket path.
- Keep live pixels off the transcript WebSocket.

Tests:

- UI tests for viewer lifecycle states, reconnect behavior, unavailable copy, rate-limit copy, and cleanup on unmount.
- No human input forwarding.

### PR 15 - Desktop recording CLI and manifest

Owns:

- Implement `record_start`, `record_stop`, and `record_status`.
- Capture VP8 WebM from `:99` at 10 FPS with 60s/50 MB caps.
- Write private `DesktopRecordingManifest`.
- Stop/flush interrupted recordings on pause/resume hooks where available.
- Emit recording start/stop/failure instrumentation.

Tests:

- Recording state-transition tests, cap enforcement, interrupted recording tests, manifest schema tests, and WebM smoke.
- No PR publishing yet.

### PR 16 - Recording overlays and evidence selection

Owns:

- Apply action-trace post-processing overlays for click rings and generic typing indicators.
- Keep raw WebM private if overlay fails.
- Add workbench recording card and evidence selection controls.
- Copy selected WebM/proof screenshots into `/tmp/cycloid-evidence/` using the selection contract.

Tests:

- Overlay success/failure tests, secret redaction assertions, selection limit tests, and artifact-too-large UI state.

### PR 17 - PR evidence publishing

Owns:

- Publish one selected desktop WebM link and up to three selected proof screenshots through the existing PR evidence path.
- Exclude manifests, logs, action traces, auth state, raw frames, partial recordings, and unselected action screenshots.
- Render concise PR evidence copy.

Tests:

- Artifact classification tests, unsafe artifact exclusion tests, PR body/comment rendering tests, and fallback behavior when upload/publish fails.

### PR 18 - Observability dashboard and soak guardrails

Owns:

- Audit every desktop event and metric family in this spec against the implemented paths and fill any gaps.
- Add Terraform-managed Datadog dashboard for startup health, tool/action success, model image feedback, screenshot quota/pruning, recording health, proxy connections, route limits, and artifact publishing.
- Add monitors only for metrics with an internal baseline; otherwise document dashboard-only soak criteria.
- Add one end-to-end internal Cycloid session proving desktop tools, action screenshots, live view, recording, selected PR evidence, and blocked viewer input.

Tests:

- Telemetry unit tests for required fields and secret-free payloads.
- E2E session evidence recorded in the PR body or linked run notes.

## Testing Requirements

- Unit tests for desktop tool input validation and path containment.
- Unit tests proving mutating actions return post-action feedback.
- Unit tests proving first-party dynamic tool image content rejects unsafe paths, unsupported MIME types, and oversized images.
- Backend adapter tests proving Codex, Claude Code, and every approved opencode desktop model receive model-visible image content before enabling desktop tools for that backend/model.
- Visual-feedback fixture tests that fail when the model can answer from text alone, when the screenshot arrives after the next desktop action, or when native and fallback image delivery both fail.
- Tool-registration tests proving mutating `desktop.*` tools are hidden for unsupported backends/models and visible only after image-feedback capability passes.
- Persistence tests proving tool-call transcript output and SessionDO desktop events never contain base64 image bytes.
- Unit tests for screenshot quotas, pruning, and `desktop_busy` serialization.
- Unit tests for recording state transitions.
- Unit tests for manifest schema, overlay failure behavior, and secret redaction fields.
- Unit tests for artifact selection and publishable type filtering.
- SessionDO tests for action-row idempotency, monotonic `desktopActionSeq`, persist-before-broadcast recovery, and REST snapshot reconciliation.
- Control-plane tests for ticket lifecycle, heartbeat, revoke, expiry, and view-only proxy behavior.
- Control-plane tests for desktop route rate limits, `Retry-After`, and no side effects after rate-limit rejection.
- Control-plane/browser tests proving viewer keyboard, pointer, drag, and clipboard attempts cannot change the desktop.
- If server-side view-only fails, add RFB parser/filter tests that allow view protocol messages and block key/pointer/clipboard.
- UI tests for workbench states: unavailable, connecting, connected, recording, completed, failed.
- UI tests for action path rows: screenshot present, screenshot failed, screenshot pruned, and proof-selected screenshot.
- UI/API tests proving action screenshots are session-private, authenticated, expandable, and not PR evidence unless selected.
- Sandbox smoke test proving desktop screenshot and WebM recording work in the template.
- Sandbox smoke test proving desktop process restart after killing WM or VNC/websockify.
- Sandbox smoke fixture: minimal Electron app opened on the desktop, clicked, recorded, and screenshotted.
- Pause/resume smoke: stale tickets rejected, desktop re-healthchecked, stale recording marked interrupted.
- E2E Cycloid session evidence before broad rollout: app launches, operator records walkthrough, PR links WebM.

## Observability

Emit structured logs/events for these outcomes:

- `desktop.start`: startup attempt, duration, component versions, display, ports;
- `desktop.health`: status, failed component, restart count;
- `desktop.restart`: component, attempt, reason, success/failure;
- `desktop.tool_action`: action type, duration, success/failure, error code, screenshot present;
- `desktop.model_image_feedback`: backend, image count, total bytes, success/failure, failure code;
- `desktop.model_image_feedback_fixture`: backend, model id, delivery path, latency, success/failure, failure code;
- `desktop.model_image_feedback_unsupported`: backend, model id, reason, registration blocked boolean;
- `desktop.action_path_row`: action id, screenshot status, render status;
- `desktop.action_path_persist`: action id, sequence, duration, idempotent update, success/failure;
- `desktop.screenshot`: purpose, bytes, quota status, success/failure;
- `desktop.recording_start`: scenario id, label hash, display, max duration;
- `desktop.recording_stop`: duration, bytes, overlay status, publishable boolean;
- `desktop.recording_failed`: reason, partial artifacts present;
- `desktop.proxy_ticket_create`: session id, viewer user id hash, expires at;
- `desktop.proxy_connect`: ticket id hash, status, close reason;
- `desktop.proxy_input_attempt_blocked`: input type and connection id hash when an input attempt is detected or blocked;
- `desktop.rate_limited`: route class, session id hash, viewer user id hash when present, retry-after seconds;
- `desktop.artifact_selected`: artifact type, bytes, render mode;
- `desktop.artifact_publish`: success/failure and fallback mode.

Required metric families:

- Startup and health: desktop startup duration, health status gauge, restart count by component, unavailable duration.
- Tool actions: action count, duration, failure count by action/error code, `desktop_busy` count, screenshot feedback success rate.
- Model image feedback: delivery success rate by backend, image bytes per result, downscale count, unsupported-backend count.
- Backend readiness: visual-feedback fixture pass/fail by backend/model, selected delivery path, fixture latency, and last verified version.
- Screenshot storage: capture duration, bytes, quota usage, prune count, artifact upload success/failure.
- Action path: row persist duration, duplicate/idempotent update count, event broadcast count, REST snapshot fallback count.
- Recording: recording duration, bytes, overlay duration, overlay failure count, publishable/non-publishable count.
- Proxy/viewer: ticket create count, active viewer gauge, websocket connect/close count, close reason, input-block attempt count.
- Rate limits: limited request count by route class and session.
- PR evidence: selected artifact count, publish success/failure, fallback mode.

Every desktop log/metric should include stable, non-secret correlation fields where available: environment, session id hash, business id hash, agent runtime backend, sandbox template id, resource profile, component, action id, recording id, artifact id, and error code.

Before broad rollout, add a Terraform-managed Datadog dashboard covering startup health, action success, model image feedback, screenshot quota/pruning, recording health, proxy connections, rate limits, and artifact publish outcomes. Add monitors only after internal soak establishes a baseline, then alert on sustained desktop unavailability, model-image feedback failure spikes, recording publish failures, or proxy connect failure spikes.

Do not log screenshots, frame payloads, raw typed text, VNC URLs, ticket tokens, traffic-access tokens, cookies, or artifact signed URLs.

## Risks

- **Base image growth:** desktop packages are a shared cold-start cost. Measure and justify size delta before merge.
- **Secret exposure:** recording can capture credentials or private data. Mitigate by recording only during proof, keeping auth outside recording, and publishing only selected visual artifacts.
- **Noisy evidence:** full-desktop videos can be less focused than browser viewport videos. Mitigate with short recording guidance and selected screenshot proof.
- **Desktop flake:** X/VNC/WM processes can die independently. Mitigate with health checks and restart logic.
- **Agent confusion:** screen-coordinate tools are less deterministic than DOM tools. Mitigate by keeping Playwright as the deterministic path and returning post-action feedback from desktop actions.
- **UI scope creep:** human takeover is tempting. Keep V1 view-only and defer leases/input forwarding.

## References

- Browser tool and evidence wedge: [docs/work-trial-browser-use.md](../../work-trial-browser-use.md)
- Existing runtime/E2E evidence path: [docs/customer-e2e-runtime.md](../../customer-e2e-runtime.md)
- Recorder artifact contract: [docs/qa-recorder-sidecar-spec.md](../../qa-recorder-sidecar-spec.md)
- Browser-page vs virtual-desktop analysis: [docs/qa-recording-videos-research.md](../../qa-recording-videos-research.md)
- Sandbox lifecycle and base-image cost rule: [docs/sandbox-architecture.md](../../sandbox-architecture.md)
- Artifact security rules: [docs/security.md](../../security.md)
- PR #6840 pattern to reuse: ticketed live-view proxy, SessionDO ticket state, same-origin WebSocket, provider URL containment.
