# QA Recorder Sidecar Spec

Date: 2026-07-03
Status: proposed

## Verdict

Cost: one sandbox helper, one recorder-owned Chromium process, local lifecycle state, prompt changes, and focused artifact tests. It avoids a full Cycloid browser product while producing reviewer-grade videos with visible cursor movement and clicks.

Decision: build a live recorder sidecar that starts an authenticated browser, returns a CDP URL, and exposes only CLI start/record/stop/shot/close commands. `build-smaller`

## Problem

Current visual evidence is too weak for UI verification:

- Screenshots show state but not the interaction that reached it.
- The existing demo recorder is route/script/output oriented, so it asks the agent to recreate a flow after exploration.
- Agents need to start an authenticated browser, inspect and operate it live, start recording at the proof moment, then stop once the changed state is visible.
- Reviewers need to see agency: cursor movement and click rings in the same browser the agent operated.

We do not want a broad first-class browser-control product in v1. The recorder owns exactly one local browser for publishable proof and returns a CDP URL so existing browser tooling can drive it.

## Current Harness Facts

The current sandbox already has enough pieces for an 80/20 recorder:

- Chromium and Playwright are installed in the E2B image.
- `ffmpeg` is already installed in the image.
- Agents can run shell commands and connect browser tooling to a CDP endpoint during verification.
- The bridge uploads artifacts from `/tmp/cycloid-evidence`.
- Verification v2 already uses `/tmp/phase-evidence/operator` for raw operator evidence and lets the judge copy publishable artifacts into `/tmp/cycloid-evidence`.
- `.webm` files are classified as video artifacts and capped at 50 MB.

So the smallest useful product is not a full browser platform. It is a helper that starts one recorder-owned browser, loads existing auth state, records on command, and leaves normal screenshot and artifact flows intact.

## Goals

- Let Codex, Claude Code, opencode, or any command-capable agent record a UI happy path.
- Preserve the current screenshot workflow exactly; video is additive evidence, not a replacement.
- Make recording easy while the agent is operating the browser live, not only after it writes a replay script.
- Let the agent choose when to start and stop recording through CLI commands.
- Show a synthetic cursor and click rings in the video.
- Save one WebM, multiple screenshots, and one manifest under `/tmp/phase-evidence/operator/<scenario>/`.
- Reuse existing artifact upload and QA comment publishing.
- Keep the API simple enough that the verifier prompt can teach agents to use it.

## Non-goals

- No general-purpose Cycloid browser integration in v1.
- No hosted browser vendor.
- No full remote desktop recording by default.
- No replay system.
- No multi-browser orchestration.
- No automatic generation of perfect UI tests.
- No requirement that agents use recorder-specific click/fill wrappers.
- No recording of login, token entry, OAuth, secrets, or terminal env output.

## Evidence Policy

For QA scenarios where the changed behavior is a user-visible flow, interaction, animation, or state transition that screenshots alone do not prove well, the target evidence set is:

- multiple screenshots from the operated flow, exactly as today;
- one short demo video of the changed happy path or interaction;
- a short action trace in the operator notes that names the video and screenshot artifacts.

Video is strongly preferred for operated UI flows and time-based behavior. It is not mandatory for every UI PR: a static visible state can still be conclusive with screenshots plus a focused assertion, test, API response, log, or data-path proof.

Acceptable reasons to omit video include:

- the PR has no user-visible/app-operable surface;
- the visible behavior is static and screenshots already prove the merge-critical claim;
- the runtime cannot be launched after concrete repair attempts;
- recording would expose secrets, credentials, OAuth, private customer data, or destructive state;
- the recorder fails after a real attempt, in which case the failure is a QA evidence gap that must be named.

When video is omitted, screenshots and stronger alternate evidence are still required where possible. For operated UI flows where video would materially prove the claim, a missing video should push the judge toward INCONCLUSIVE unless the omission reason is explicitly non-applicable, already covered by stronger evidence, or risk-based.

## Product Shape

Ship a sandbox helper called `cycloid-recorder`.

The primary interface is a small CLI that starts a recorder-owned Chromium browser and prints the CDP endpoint the agent should drive. It is not a dependency added to the customer repo, and it does not expose a public `controlUrl`.

```bash
cycloid-app auth
cycloid-recorder start \
  --storage-state /tmp/cycloid-auth/state.json \
  --out-dir /tmp/phase-evidence/operator/settings-flow
```

`start` launches Chromium with the storage state already loaded, binds remote debugging to loopback only, and prints JSON:

```json
{
  "recorderId": "rec_123",
  "cdpUrl": "ws://127.0.0.1:43001/devtools/browser/...",
  "outDir": "/tmp/phase-evidence/operator/settings-flow"
}
```

Then the agent connects browser tooling to `cdpUrl`, operates the browser normally, and controls recording through the CLI:

```bash
cycloid-recorder record --id rec_123 --label "settings happy path"
# agent drives the CDP browser with Playwright, browser tooling, or another CDP client
cycloid-recorder shot --id rec_123 settings-saved
cycloid-recorder stop --id rec_123 --label "saved state visible"
cycloid-recorder close --id rec_123
```

Recording is off until `record`, so auth, setup, and exploratory navigation do not appear in the video unless the agent explicitly starts recording too early.

## Why Live Sidecar First

Live sidecar mode fits how agents actually verify UI:

- The agent does not need to recreate a discovered flow in a separate script.
- Auth remains the existing `cycloid-app auth` contract; the recorder only consumes the produced Playwright storage state.
- The helper is preinstalled in the sandbox image, so no customer repo dependency or package install is required.
- The recorder owns one browser and can capture that browser without becoming a general Cycloid browser product.
- The agent keeps real agency: it connects to the CDP browser, inspects the page, starts recording at the proof moment, operates normally, and stops when the changed state is visible.
- The recorder can inject passive overlays and event listeners so cursor/click evidence appears even when the agent drives through raw CDP or Playwright.

Passive attachment to arbitrary `agent-browser` sessions is not robust enough for v1. If `agent-browser` launches a hidden or separate browser without a CDP endpoint, a recorder cannot reliably see it. Keep `agent-browser` for quick inspection and fallback screenshots; use the recorder-owned CDP browser for publishable videos.

## Recorder CLI

### `cycloid-recorder start`

Starts one recorder-owned Chromium browser and returns the CDP endpoint.

```bash
cycloid-recorder start \
  --out-dir /tmp/phase-evidence/operator/<scenario-id> \
  [--storage-state /tmp/cycloid-auth/state.json] \
  [--viewport 1280x720] \
  [--max-duration-ms 45000] \
  [--frame-rate 10]
```

Defaults:

- outDir: required; must stay under `/tmp/phase-evidence/operator`
- viewport: `1280x720`
- maxDurationMs: `45000`
- frameRate: `10`
- storageState: omitted for unauthenticated flows; explicit path for authenticated flows

Output:

```json
{
  "recorderId": "rec_123",
  "cdpUrl": "ws://127.0.0.1:43001/devtools/browser/...",
  "outDir": "/tmp/phase-evidence/operator/settings-flow"
}
```

Rules:

- `cdpUrl` is loopback-only and sandbox-local. Do not put it in public artifacts, PR text, or logs meant for users.
- The browser starts with recording off.
- If the app needs login, the verifier runs `cycloid-app auth` first and passes the resulting storage state.
- `start` writes local recorder state keyed by `recorderId` so later CLI commands can find the process.
- `start` fails if `outDir` escapes `/tmp/phase-evidence/operator`.
- `start` does not copy or persist the storage-state file into evidence.

### `cycloid-recorder record`

Starts capture for an existing recorder.

```bash
cycloid-recorder record --id rec_123 --label "settings happy path"
```

Rules:

- fails if the recorder is already recording;
- injects or re-injects the overlay into the active page;
- starts CDP screencast capture;
- records the start timestamp and label in `manifest.json`;
- auto-stops at `maxDurationMs` with a clear status in the manifest.

### `cycloid-recorder stop`

Stops capture, encodes the WebM, and flushes the manifest.

```bash
cycloid-recorder stop --id rec_123 --label "saved state visible"
```

Rules:

- fails if the recorder is not recording;
- always attempts to flush a partial manifest when encoding fails;
- writes one WebM under `outDir`;
- checks the WebM size against the 50 MB publish limit;
- leaves screenshots and manifest under `outDir`.

### `cycloid-recorder shot`

Captures a screenshot from the active recorder page.

```bash
cycloid-recorder shot --id rec_123 settings-saved
```

The filename is sanitized, `.png` is appended when omitted, and the output path must remain under `outDir`.

### `cycloid-recorder close`

Closes the browser and recorder process.

```bash
cycloid-recorder close --id rec_123
```

If still recording, `close` first attempts the same stop/flush path as `stop`, then closes. It prints final artifact paths.

### Future module API

A module API can be added later for deterministic smoke scripts. It is not part of v1 because it makes agents replay flows instead of operating the recorded browser live.

## Capture Implementation

Use CDP screencast as the durable v1 capture path.

Process model:

1. `start` launches a small long-lived Node sidecar.
2. The sidecar launches Playwright Chromium with a fresh user-data dir, the optional storage state, deterministic viewport, and a loopback-only remote debugging port.
3. The sidecar resolves the browser CDP WebSocket endpoint and prints it as `cdpUrl`.
4. Later CLI commands locate the sidecar by `recorderId` using local state under `/tmp/cycloid-recorder/`. This local IPC detail is not part of the public contract.

Recording flow:

1. `record` selects the active page, creates a CDP session for that page, and injects the overlay script.
2. `record` calls `Page.startScreencast` with JPEG frames.
3. On each `Page.screencastFrame`, write the frame and timestamp to a temp dir under `outDir/.frames`, then call `Page.screencastFrameAck`.
4. `stop` calls `Page.stopScreencast`.
5. `stop` encodes frames to `happy-path.webm` using `ffmpeg`.
6. `stop` deletes `.frames` after successful encode unless debug is enabled.
7. `close` closes Chromium and removes local sidecar state.

Recommended defaults:

- 1280x720 viewport
- 10 FPS
- VP8 WebM
- target video duration 10-45 seconds
- enforce 50 MB output cap before publish

Why not Playwright native video first:

- It starts at context creation, not at the exact proof moment.
- It saves on context close, which makes mid-flow segmentation awkward.
- It does not solve click/cursor overlays by itself.

Playwright video can remain a later fallback if CDP screencast fails. V1 should instead fail visibly, capture screenshots where possible, and write `recorder-error.log`.

## Overlay Implementation

Inject a non-interactive overlay into every recorded page:

- fixed-position root
- `pointer-events: none`
- very high z-index
- synthetic cursor element
- click ripple element
- optional action label element

Expose a page function for the recorder's own overlay controls:

```js
window.__cycloidRecorder = {
  showClick(x, y),
  note(label),
  hideLabel()
};
```

Also install passive DOM listeners as fallback:

- `pointerdown`
- `click`
- `input`
- `change`
- `submit`
- `scroll`
- `keydown`

Passive listeners should show cursor/click/scroll/focus hints and generic labels only. They must not read or render input values. If the agent drives through CDP or Playwright, real pointer and keyboard events should trigger the overlay without requiring recorder-specific action helpers.

## Manifest

Write `manifest.json`:

```json
{
  "schemaVersion": 1,
  "tool": "cycloid-recorder",
  "label": "settings happy path",
  "outcomeLabel": "settings happy path complete",
  "startedAt": "2026-07-03T00:00:00.000Z",
  "stoppedAt": "2026-07-03T00:00:31.000Z",
  "durationMs": 31000,
  "viewport": { "width": 1280, "height": 720 },
  "video": "happy-path.webm",
  "screenshots": ["settings-saved.png"],
  "actions": [
    {
      "id": "act_1",
      "type": "click",
      "label": "click",
      "urlBefore": "http://127.0.0.1:3000/settings",
      "urlAfter": "http://127.0.0.1:3000/settings",
      "target": { "x": 1180, "y": 96, "width": 72, "height": 32 },
      "startedAtMs": 1510,
      "completedAtMs": 1840,
      "status": "success"
    }
  ],
  "redactions": {
    "inputValuesRendered": false,
    "storageStateCopied": false,
    "cdpUrlPublished": false
  }
}
```

The manifest is supporting evidence, not public PR evidence by default. It must not include cookies, storage-state contents, token-like strings, full typed values, or the `cdpUrl`.

## Artifact Contract

Output directory:

```text
/tmp/phase-evidence/operator/<scenario-id>/
  happy-path.webm
  before-edit.png
  settings-saved.png
  manifest.json
  console-errors.json
```

Judge behavior:

- Keep using screenshots as the normal visual proof path.
- Prefer videos alongside screenshots for operated flows, interactions, and time-based UI changes.
- Copy `happy-path.webm` to `/tmp/cycloid-evidence/...` only if it directly proves the changed flow.
- Copy the screenshots that directly show the changed states and important proof points.
- Leave manifest, frame temp files, and debug logs in `/tmp/phase-evidence/operator`.

No PR publishing changes are required.

## Prompt Changes

Update verification operator guidance:

- Continue taking screenshots exactly as today for changed UI states.
- Use `cycloid-recorder` when the runnable UI proof is an operated flow, interaction, animation, or state transition that video demonstrates better than screenshots alone.
- Treat recorder videos as additive to screenshots, not a replacement for screenshots.
- If the app needs login, run `cycloid-app auth` first and pass the produced storage state to `cycloid-recorder start`.
- Start the recorder browser, connect browser tooling to the returned `cdpUrl`, and operate that browser normally.
- Start recording after setup/auth and any unrelated navigation.
- Stop recording when the changed state is visible.
- Capture screenshots at the useful proof points for the flow, as the verifier does today.
- Keep raw output under `/tmp/phase-evidence/operator/<scenario-id>/`.

Update judge guidance:

- For operated UI/app flows, expect the current screenshot evidence plus one short recording when video materially strengthens the proof.
- Do not reject screenshot evidence merely because a video exists, and do not treat video as a reason to omit screenshots.
- Do not publish recordings of setup, login, or unrelated pages.
- Leave manifests/logs private unless they directly prove a merge-critical claim.

## Implementation Phases

Each phase should be a separate PR unless the previous phase is too small to review on its own. Keep the phase prefix in the PR title, for example `[1/7] Add recorder CLI skeleton`.

### Phase 1: Sandbox command skeleton

Purpose: make `cycloid-recorder` available in the sandbox image with a stable CLI contract, without launching a browser yet.

Scope:

- add `apps/sandbox-e2b/cycloid-recorder.mjs`;
- install the command from `apps/sandbox-e2b/template.ts`;
- implement `--help`, argument parsing, JSON/error output conventions, and command stubs for `start`, `record`, `stop`, `shot`, and `close`;
- add the ready-check assertion for `cycloid-recorder --help`;
- add the ready-check assertion for `ffmpeg -version`.

Verification:

- sandbox template test proves `cycloid-recorder` is installed;
- ready-check test proves `cycloid-recorder --help` and `ffmpeg -version` are checked;
- focused CLI tests cover help text, invalid commands, invalid args, and machine-readable failure output.

Exit criteria:

- agents can discover the command in the sandbox;
- no browser process or recording path exists yet;
- no prompt changes ask agents to use it yet.

### Phase 2: Recorder-owned browser lifecycle

Purpose: prove the sidecar can start exactly one recorder-owned browser and expose a loopback-only CDP endpoint that agents can drive.

Scope:

- implement `start` and `close`;
- launch Playwright Chromium with a fresh user-data dir, deterministic viewport, optional storage state, and loopback-only remote debugging;
- return `recorderId`, `cdpUrl`, and `outDir` JSON from `start`;
- persist local recorder metadata under `/tmp/cycloid-recorder/`;
- enforce `outDir` containment under `/tmp/phase-evidence/operator`;
- reject stale or unknown `recorderId` values;
- ensure `close` tears down Chromium and removes local sidecar state.

Verification:

- unit tests cover `start` output schema, viewport parsing, optional storage-state handling, path containment, missing state, stale recorder IDs, and loopback-only CDP URL behavior;
- a focused local script connects Playwright to the returned `cdpUrl`, opens a page, and closes the recorder.

Exit criteria:

- an agent can operate the recorder-owned browser live through CDP;
- no video recording is required yet.

### Phase 3: Screenshots and manifest foundation

Purpose: add useful non-video evidence and the manifest schema before introducing screencast encoding.

Scope:

- implement `shot`;
- sanitize screenshot labels and keep output paths under `outDir`;
- create and update `manifest.json`;
- record viewport, labels, timestamps, screenshot names, redaction booleans, and lifecycle status;
- always flush a partial manifest on command failure where possible.

Verification:

- unit tests cover screenshot filename sanitization, path traversal rejection, manifest schema, partial manifest flushing, and invalid lifecycle transitions;
- local smoke proves `shot` captures the active page from the recorder-owned browser.

Exit criteria:

- a recorder run can produce screenshots plus a private manifest under `/tmp/phase-evidence/operator/<scenario-id>/`;
- existing screenshot guidance still remains the primary proof path.

### Phase 4: CDP screencast capture and WebM output

Purpose: produce one short publishable WebM from the same browser the agent operates.

Scope:

- implement `record` and `stop`;
- select the active page and start `Page.startScreencast`;
- write frames and timestamps under `outDir/.frames`;
- acknowledge every `Page.screencastFrame`;
- encode VP8 WebM with `ffmpeg`;
- enforce `maxDurationMs`, max frame count, temp-frame directory limit, and the 50 MB WebM cap;
- delete temp frames after successful encode unless debug is enabled;
- write `recorder-error.log` and a partial manifest when capture or encoding fails;
- make `close` auto-stop and flush when it is called while recording.

Verification:

- unit tests cover idle -> recording -> stopping -> completed, double record/stop failures, auto-stop, encode failure, dropped-frame reporting, and output cap handling;
- local smoke produces a non-empty WebM under 50 MB from a simple page;
- artifact collector test confirms `.webm` remains classified as video.

Exit criteria:

- the recorder can produce `happy-path.webm`, screenshots, and `manifest.json`;
- failures leave enough private evidence to explain the gap.

### Phase 5: Cursor and click overlay

Purpose: make videos reviewer-grade by showing visible agency without requiring recorder-specific action wrappers.

Scope:

- inject a non-interactive overlay into every recorded page;
- render synthetic cursor movement, click rings, and optional generic labels;
- expose `window.__cycloidRecorder` only for recorder-owned overlay controls;
- install passive listeners for pointer, click, input, change, submit, scroll, and keydown events;
- re-inject after top-level navigation and keep SPA route changes working;
- suppress input values and token-like strings from labels and manifest actions;
- clamp coordinates to the viewport.

Verification:

- unit tests cover label redaction, input-value suppression, coordinate clamping, and overlay script reinjection decisions;
- smoke video shows a cursor and click ring after a button click on light and dark backgrounds.

Exit criteria:

- the demo video shows the interaction path, not only the final UI state;
- overlays do not obscure the changed UI state or expose typed values.

### Phase 6: Verification prompt and judge integration

Purpose: teach verification agents when and how to use the recorder without changing normal screenshot or artifact publishing flows.

Scope:

- update `apps/sandbox-bridge/src/services/verification-phase-runner.ts`;
- update `apps/sandbox-bridge/src/bridge.ts` if recorder guidance is assembled there;
- keep screenshots/tests/logs/API/data-path proof as required evidence;
- prefer `cycloid-recorder` for operated UI flows, interactions, animations, and state transitions where video materially strengthens proof;
- keep `agent-browser` guidance for quick exploration and fallback screenshots;
- tell agents to run `cycloid-app auth` first for protected app paths, pass the storage state, connect tooling to `cdpUrl`, and use `record`, `shot`, `stop`, and `close` around the proof interaction;
- tell agents never to add `cycloid-recorder` to the customer repo or install packages to use it;
- update judge guidance so missing video is a named evidence gap for interaction-heavy UI flows, not an automatic failure for non-visual/API-only work.

Verification:

- prompt snapshot/string tests prove recorder instructions are present and screenshot requirements remain present;
- judge prompt tests cover video-as-additive evidence and acceptable omission reasons;
- artifact collector test still proves only selected screenshots/WebM move to `/tmp/cycloid-evidence`.

Exit criteria:

- agents are instructed to use the recorder only where it is useful;
- no PR publishing changes are required.

### Phase 7: End-to-end recorder smoke

Purpose: prove the full flow works before relying on it for QA evidence.

Scope:

- add or document one local smoke fixture that starts a simple app, starts the recorder, connects Playwright to `cdpUrl`, records a button-click flow, captures screenshots, stops recording, and closes the recorder;
- verify the produced WebM has non-empty frames and stays under 50 MB;
- verify the manifest omits storage-state contents, `cdpUrl`, token-like strings, and typed input values;
- verify the artifact collector sees the WebM as `video`.

Verification:

- local command: `npm run smoke:qa-recorder`;
- run the smoke locally before marking the feature usable;
- preserve the generated artifact paths in the test output or operator notes for debugging.

Exit criteria:

- a verifier can produce publishable screenshots plus one WebM demo recording for an interaction-heavy runnable UI happy path;
- the final evidence set satisfies the acceptance criteria below.

Example smoke command shape:

```bash
cycloid-recorder start --out-dir /tmp/phase-evidence/operator/button-flow > /tmp/recorder.json
node /tmp/drive-recorder-browser.mjs "$(jq -r .cdpUrl /tmp/recorder.json)" "$(jq -r .recorderId /tmp/recorder.json)"
```

## Failure Behavior

If recording fails:

- continue the verification flow,
- capture screenshots for the useful proof points,
- write `recorder-error.log` under phase evidence,
- operator records the blocker in evidence refs,
- judge treats the missing video as a QA evidence gap when video would have materially strengthened the UI proof.

Failure to record video should not automatically fail non-visual/API-only verification. For interaction-heavy operated UI flows where video would materially strengthen the proof, it should usually make the result INCONCLUSIVE unless the judge has a specific, documented reason that screenshots plus alternate evidence still prove the merge-critical behavior.

## Security

- Do not record auth setup or secret entry.
- Do not copy `/tmp/cycloid-auth` into evidence.
- Do not render typed values in overlays.
- Default labels should be generic and non-secret.
- Bind CDP to `127.0.0.1` only.
- Treat `cdpUrl` as sandbox-local control data; do not publish it or copy it into artifacts.
- Public artifacts remain screenshot and WebM only.
- Enforce WebM 50 MB cap before publish.
- Keep manifests/logs private unless explicitly selected by the judge.

## Hardening Checklist

### Agent compliance

- The verifier prompt must make missing video a named evidence gap when an operated UI flow would benefit from video.
- The judge should check for both screenshot and video artifacts before returning CONCLUSIVE for interaction-heavy or time-based UI behavior.
- The operator note should include the recorder output directory and the names of the screenshots/video it produced.
- If the agent uses raw Playwright or screenshots without `cycloid-recorder` for an interaction-heavy UI happy path, it must explain why.

### Capture reliability

- Always write a partial manifest even when recording or encoding fails.
- Enforce `maxDurationMs`, max frame count, and max temp-frame directory size.
- Delete temporary frames after successful encode and after failures where possible.
- Confirm `ffmpeg` is present in `ready-check.sh` and fail the sandbox image build if not.
- Acknowledge every CDP screencast frame with `Page.screencastFrameAck`.
- Detect and report dropped CDP screencast frames in the manifest.
- If CDP screencast fails, fall back to Playwright screenshots plus `recorder-error.log`; do not silently produce no video.

### Video quality

- Use deterministic viewport defaults: `1280x720`, 10 FPS.
- Use a clear synthetic cursor and click ring visible on both light and dark backgrounds.
- Keep overlays small and non-blocking; never obscure the changed UI state.
- Do not use negative or absolute page coordinates without clamping to the viewport.
- Use passive pointer events where available; do not require recorder-specific action wrappers in v1.

### App compatibility

- Re-inject the overlay after top-level navigation.
- Handle single-page-app route changes without restarting capture.
- Treat cross-origin iframes as visible-only: do not inspect their DOM, but allow coordinate-based cursor/click overlays when the action target coordinates are known.
- Record viewport video only in v1; browser chrome, native dialogs, file pickers, terminal UI, and OS permission prompts are fallback/unsupported cases.
- If the flow needs native dialogs or browser chrome, record why video is incomplete and rely on screenshots/alternate evidence until a desktop fallback exists.

### Artifact and storage limits

- Check WebM size before copying to `/tmp/cycloid-evidence`.
- Keep the publishable evidence set small: multiple useful screenshots plus one demo video, not every intermediate frame.
- Never copy `.frames`, manifests, raw logs, storage state, or trace files into `/tmp/cycloid-evidence` by default.
- Sanitize artifact filenames to avoid control characters, path traversal, and long labels.
- Keep all recorder output under the configured `outDir`; reject paths outside `/tmp/phase-evidence/operator` unless explicitly allowed for local tests.
- Store sidecar metadata under `/tmp/cycloid-recorder/`; reject stale or mismatched `recorderId` values instead of attaching to an unknown process.

### Secret and data exposure

- Default to not rendering input values in labels or video overlays.
- Treat labels as potentially public because they may be visible in the video; prompts should use generic labels.
- Do not include storage-state file paths, `cdpUrl`, or token-like strings in public video labels, manifests selected for publication, or PR text.
- Do not record OAuth, login, token entry, billing pages, customer data exports, or admin secrets.
- Prefer seeded/test data for demos; if only sensitive production-like data is visible, omit video with a risk-based blocker.

### Test coverage

- Unit-test recorder state transitions: idle -> recording -> stopping -> completed, plus invalid double-start/double-stop.
- Unit-test `start` JSON schema and loopback-only CDP endpoint selection.
- Unit-test label redaction and secret-value suppression.
- Unit-test path containment for `outDir` and screenshot filenames.
- Unit-test WebM size-limit handling.
- Unit-test prompt text preferring screenshots plus video for interaction-heavy UI/app flows.
- Add one smoke that verifies a produced WebM contains non-empty frames and the overlay appears after a click.

## Tradeoffs

What this gives us:

- Good videos now.
- Works with command-only agents.
- No new hosted browser dependency.
- No platform-level browser product.
- Direct start/stop agency while the agent operates the browser live.

What it does not give us:

- It does not record arbitrary `agent-browser` sessions unless they connect to the recorder-owned CDP browser.
- It does not produce a perfect cross-tool action log when agents use raw browser tools.
- It does not support native dialogs or browser chrome well.
- It does not support live human takeover.

These are acceptable for v1. If recordings prove valuable, v2 can add a first-class browser-control surface or a virtual desktop fallback.

## Acceptance Criteria

- A verifier can start `cycloid-recorder`, connect browser tooling to the returned `cdpUrl`, start/stop recording mid-flow, and produce uploadable evidence.
- Existing screenshot capture guidance remains active; video recording does not replace screenshots.
- For an interaction-heavy runnable UI happy path, the published QA evidence contains useful screenshots and one WebM demo recording.
- The video shows cursor movement and click rings for actions performed in the recorder-owned browser.
- The screenshots show the changed states and important proof points.
- The output WebM is below 50 MB.
- Existing artifact upload publishes the WebM as a recording link in the managed QA comment.
- No auth state, typed secrets, raw storage state, or `cdpUrl` is copied to publishable evidence.

## Future Work

- Optional full-desktop recorder fallback for native dialogs and browser chrome.
- Optional passive CDP attach mode for browsers launched with `--remote-debugging-port`.
- Optional module API for deterministic smoke scripts.
- Optional action timeline UI in Cycloid.
- Optional video trimming and idle-time compression like Devin.
- Optional zoom around clicks.
- Optional automatic judge preference for "best recording" when multiple videos exist.
