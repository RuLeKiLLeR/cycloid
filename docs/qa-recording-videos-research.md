# QA Recording Videos Research

Date: 2026-07-01

## Recommendation

Build the first version as a Cycloid-owned verification artifact generator, not as a generic agent screen recorder.

The 80/20 path is a stateful browser recorder attached to the same browser-control surface the verifier uses to click, type, and navigate. The verifier should be able to start recording in the middle of an operated flow, keep clicking through the live browser, show cursor/click overlays from those same action events, then stop recording after the changed happy path is visibly complete. Keep screenshots as the primary visual anchor, attach one WebM video for the main flow, and keep traces/logs private supporting evidence.

Verdict: `build-smaller`

## What Competitors Do

### Devin

Devin has the clearest public precedent. Its docs describe a post-PR testing mode where Devin runs the app locally, plans one focused end-to-end flow, starts a screen recording, interacts through the browser, annotates key moments, compresses idle time, and sends the result as a message attachment.

Source: https://docs.devin.ai/work-with-devin/testing-and-recordings

Implication: the bar is not exhaustive QA. It is a short reviewer artifact that makes the changed happy path obvious enough to merge faster.

### Cursor

Cursor Cloud Agents publicly document PR-attached artifacts. The docs say Cloud Agents produce screenshots, videos, and logs to demo changes, run in isolated VMs with full desktop environments, can control the desktop/browser, and support optional artifact posting to GitHub.

Sources:

- https://cursor.com/docs/cloud-agent
- https://cursor.com/docs/cloud-agent/capabilities

Implication: Cursor is treating visual proof as part of the PR review surface, not just as chat transcript decoration. The desktop model is useful for broad demos, but Cycloid should avoid full-desktop capture as v1 unless browser capture cannot show the behavior.

### Replit Agent

Replit Agent's App Testing docs describe a browser preview, watching the agent cursor click through the app, real-user simulation, automatic analysis, and video replay/navigation for review.

Source: https://docs.replit.com/references/agent/app-testing

Implication: live preview plus replay is becoming a product expectation for app-building agents. A static screenshot-only QA comment will feel weaker for UI changes.

### Claude Code

Claude Code's Chrome integration supports visible browser automation, web-app testing, console/DOM inspection, and session recording as GIFs. Its computer-use preview can drive GUI apps and screenshot each step, but it is macOS-local and interactive.

Sources:

- https://code.claude.com/docs/en/chrome
- https://code.claude.com/docs/en/computer-use

Implication: Claude has useful local/manual recording workflows, but that is not the same as a Cycloid-controlled QA artifact in a sandbox. For Cycloid, the recorder should be our infrastructure, usable by Codex, Claude, or any future backend.

### OpenAI Codex

Codex has an in-app browser with browser use, screenshots, page inspection, and optional CDP developer mode. Appshots capture a frontmost Mac app window as an image/text attachment. Record & Replay records a demonstrated Mac workflow into a reusable skill. The public Codex docs I checked do not describe automatic PR happy-path demo videos.

Sources:

- https://developers.openai.com/codex/app/browser
- https://developers.openai.com/codex/appshots
- https://developers.openai.com/codex/record-and-replay

Implication: Codex can consume and operate visual contexts, but Cycloid should not depend on Codex-native video recording for QA. The video recorder should be a verifier tool with a stable artifact contract.

### GitHub Copilot Coding Agent

GitHub Copilot's public coding-agent docs emphasize commits, PRs, logs, validation steps, and review iteration. I did not find public docs for automatic browser/video QA artifacts.

Source: https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent

Implication: video evidence is still differentiating among coding agents, especially when attached directly to the review surface.

## Infrastructure Options

### 1. Playwright Context Video

Use Playwright to drive the app route and record the browser context. This is the lowest-cost capture primitive, but only if it is wrapped by a stateful browser session controller rather than exposed as `--url --script --out`.

The important API is:

- `browser_recording.start({ label })`
- normal browser actions: `navigate`, `click`, `type`, `select`, `scroll`, `wait`
- `browser_recording.stop({ outcomeLabel })`

The recorder should emit:

- `happy-path.webm`
- `happy-path-final.png`
- `happy-path-manifest.json`
- optional private Playwright trace/log bundle

This matches Cycloid's existing artifact contract: screenshots plus `.webm` videos. Playwright supports video recording, action annotations, fixed viewport sizes, page video access, and trace viewer artifacts.

Sources:

- https://playwright.dev/docs/videos
- https://playwright.dev/docs/trace-viewer

Pros:

- Lowest new surface area.
- Works in headless Linux/sandbox environments.
- Produces WebM directly.
- Easy to cap at 10-45 seconds and 1280x720.
- Easy to pair with screenshots, console errors, network failures, URL, viewport, and commit metadata.

Cons:

- Captures browser viewport, not the whole desktop.
- Multi-tab and file-picker/native-dialog flows are weaker.
- Native `recordVideo` starts with the browser context and saves on close, so it is awkward for true mid-session start/stop unless we control context lifecycle or trim the output after the fact.
- It does not automatically show the OS cursor. We need action overlays from the browser-control layer or Playwright action annotations where available.

Use this for v1 only as the video encoding primitive, not as the product API.

### 2. Chrome DevTools Screencast

Use CDP `Page.startScreencast` to capture frames from the already-open controlled tab and assemble WebM with ffmpeg or a node encoder.

Source: https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast

Pros:

- Best control over exact start/stop around an already-open browser.
- Does not require closing/recreating the browser context.
- Natural fit for a stateful recorder service that runs beside `agent-browser`.
- Can share the same CDP session used for console/network/DOM inspection.

Cons:

- More implementation surface.
- Requires frame encoding and timing correctness.
- CDP captures the page, not the OS cursor, so click/cursor overlays are still needed.

Use if mid-session start/stop is the priority. This is likely the right durable implementation after the smallest Playwright-backed spike.

### 3. Full Desktop Recording

Record the virtual display with ffmpeg/Xvfb/noVNC while the agent operates browser, terminal, or desktop apps.

Pros:

- Closest to Devin/Cursor style "watch the agent test it" video.
- Covers terminal plus browser plus native windows.
- Useful if Cycloid adds remote-desktop takeover.

Cons:

- Higher secret-leak risk.
- More noise and larger files.
- Harder to keep focused and reviewer-friendly.
- Requires more runtime image and display-server ownership.

Use as a fallback or durable v2, not the first implementation. However, design v1 so this can be added without changing the agent-facing tool API.

### 4. Hosted Browser Recording

Use Browserbase/Browserless-style managed browser sessions. Browserbase automatically records sessions, supports dashboard replay, multi-tab streams, and HLS replay APIs.

Source: https://docs.browserbase.com/platform/browser/observability/session-recording

Pros:

- Outsources browser recording and replay UI.
- Strong debugging story for network/session inspection.

Cons:

- Adds vendor dependency, cost, credential routing, data exposure review, and network requirements.
- Does not naturally fit our existing sandbox evidence path.

Do not use for v1.

### 5. Test-Runner Native Video

Let repo-native Playwright Test or Cypress generate videos when tests run.

Sources:

- https://playwright.dev/docs/videos
- https://docs.cypress.io/app/guides/screenshots-and-videos

Pros:

- Excellent when the customer already has reliable E2E tests.
- Produces test-aligned artifacts.

Cons:

- Many repos will not have useful E2E tests.
- It proves the test, not necessarily the changed reviewer happy path.
- Hard to make universal across stacks.

Use as supporting evidence when present, not as the default recorder.

### 6. Agent-Native Recording

Ask Codex/Claude/etc. to record from their own product surfaces.

Pros:

- Good for local human workflows.
- Minimal Cycloid implementation when manually invoked.

Cons:

- Product-specific and not stable across backends.
- Often tied to local desktop permissions or extensions.
- Does not produce a normalized Cycloid artifact in the sandbox.

Do not build the QA process on this.

## Repo Fit

The current verification system already has the right publication path:

- Operator evidence can live under `/tmp/phase-evidence/operator/`.
- The judge selects concise publishable artifacts into `/tmp/cycloid-evidence/`.
- The bridge classifies screenshots and `.webm` videos as visual artifacts.
- Video uploads are WebM-only and capped at 50 MB.
- Managed QA comments already render screenshots and recordings.

Relevant code:

- `apps/sandbox-bridge/src/services/verification-phase-runner.ts`
- `apps/sandbox-bridge/src/utils/artifact-classification.ts`
- `shared/constants/artifacts.ts`
- `apps/control-plane-worker/src/github/verification-comment.ts`
- `docs/security.md`

The important design point: add recording to the verification/operator contract, not to PR publishing. Publishing is already solved.

## Proposed V1 Contract

Do not expose recording as a route runner with `--url`, `--script`, and `--out`. That repeats the current problem: the model has to predeclare the route and scenario, then a separate script acts instead of the verifier. The recorder must attach to the live browser session the verifier is already operating.

Add stateful browser tools:

```text
browser.open(url)
browser_recording.start(label: "settings happy path")
browser.click(selector or description)
browser.type(selector or description, text)
browser.click(selector or description)
browser_recording.stop(outDir: "/tmp/phase-evidence/operator/settings-happy-path")
browser.screenshot(path: "/tmp/phase-evidence/operator/settings-happy-path/final.png")
```

The tool should emit:

- `happy-path.webm`: short browser recording.
- `happy-path-final.png`: final changed state screenshot.
- `manifest.json`: URL, viewport, start/end timestamps, scenario label, action list, commit SHA/head context, auth-state source path if used, and redaction status.
- `console-errors.json`: filtered console/page errors, private supporting evidence unless promoted intentionally.
- optional `trace.zip`: private supporting evidence, not PR-public by default.

The recorder must visualize agency:

- Maintain a synthetic cursor overlay in the page or video compositor.
- On every browser action, move the cursor to the target coordinates before the action.
- On click, draw a short ripple/ring and optionally a small action label.
- On type/select/submit, show a short non-secret action label such as "typing into Email" or "click Save"; never render typed secret values.
- Record the action stream in `manifest.json` so the video can be audited against the verifier's tool calls.

The operator prompt should say:

- Record a short video only when the proof is user-visible and the app is runnable.
- Start recording after auth/setup, not during credential entry.
- Demonstrate the single most important changed happy path.
- Stop after the changed state is visibly confirmed.
- Copy only the final WebM and one final screenshot to `/tmp/cycloid-evidence/` if the judge needs them.

## Safety Rules

- Do not record full sessions by default.
- Do not record login, token entry, OAuth callback setup, seed data containing secrets, or terminal output containing env vars.
- Keep `/tmp/cycloid-auth/` out of evidence directories.
- Keep WebM below 50 MB.
- Prefer 10-45 second recordings.
- Use fixed viewport and deterministic seed data.
- Public PR evidence remains screenshot/WebM only. Logs, traces, manifests, auth state, and raw files stay private unless explicitly allowlisted with tests.

## What To Measure

Track the feature as a review-quality experiment:

- percent of UI-affecting QA runs with a usable recording
- recording generation failure rate
- average video size and duration
- QA inconclusive rate due to missing visual proof
- reviewer clicks/opens on recording links
- time from QA completion to PR merge for PRs with video vs screenshot-only
- count of recordings rejected for secret/sensitive-content risk

Scale it if reviewers actually open the videos and merge/review faster. Kill or narrow it if recordings are rarely opened, frequently flaky, or mostly duplicate screenshots.

## Implementation Shape

1. Make browser operation first-class in the bridge or verifier phase runner: `open`, `observe`, `click`, `type`, `scroll`, `screenshot`.
2. Add stateful recorder controls on that same browser session: `start_recording`, `stop_recording`, `recording_status`.
3. Capture click/cursor intent from the browser action wrapper, not from model prose.
4. Render click/cursor overlays either by injecting a non-interactive high-z-index overlay into the page before capture, or by compositing overlays onto captured frames before encoding WebM.
5. Use Playwright native video for the smallest spike if it can support the session lifecycle; use CDP screencast for durable mid-session start/stop.
6. Keep the recorder backend pluggable: `browser-page` first, `virtual-desktop` later.
7. Preserve the existing judge selection model: raw evidence under `/tmp/phase-evidence/operator/`, final evidence under `/tmp/cycloid-evidence/`.
8. Keep `.webm` as the only public video format.
9. Add focused tests for recorder state transitions, action-to-overlay event logging, artifact classification, size-limit handling, manifest generation, and prompt/judge behavior.
10. Run one local verification session against a simple UI fixture before broad rollout.

## Recorder Architecture

The recorder should be a small state machine owned by the browser session:

- `idle`: browser can operate normally; screenshots still work.
- `recording`: frame capture is active; every browser action also emits an overlay event.
- `stopping`: recorder flushes frames, closes or trims encoder output, writes manifest.
- `completed`: artifact paths are available for the operator/judge.
- `failed`: browser actions continue, but the operator records why video evidence was unavailable.

This makes the agent workflow natural:

1. Navigate and set up state.
2. Start recording when the meaningful happy path begins.
3. Click/type through the actual UI.
4. Stop recording when the changed state is visible.
5. Save one final screenshot.
6. Let the judge decide whether the video and screenshot are publishable.

The model should not synthesize a scenario file just to get a video. Scenario files are fine for repo-native E2E tests, but QA demo recording needs to observe the verifier's live actions.

## Browser Control Requirement

The current `agent-browser`-through-shell style is not enough if it hides the action stream. A good recorder needs structured events:

- action id
- action type
- target selector or accessibility description
- target bounding box / click coordinates
- timestamp
- before/after URL
- success/failure

If `agent-browser` can expose that stream, wrap it. If not, build the verification browser tools directly on Playwright/CDP so Cycloid owns the action stream. Without this, click overlays become guesswork and the video is just pixels, not proof of agency.

Page-viewport recording is enough for most web-app happy paths. If the proof needs browser chrome, file pickers, native windows, terminal output, or live takeover, use full desktop/Xvfb recording as an explicit fallback with stricter redaction rules.

## noVNC / CUA Future Compatibility

The agent-facing API should not expose the capture backend. Keep these stable:

```text
browser.open(...)
browser.click(...)
browser.type(...)
recording.start(...)
recording.stop(...)
recording.status()
```

Underneath, support capture backends:

- `browser-page`: page viewport frames from Playwright/CDP, synthetic cursor overlay, best for web-app QA.
- `virtual-desktop`: Xvfb/noVNC/ffmpeg display capture, real desktop cursor, best for browser chrome, terminal, native dialogs, remote takeover, and CUA.

This keeps v1 narrow while leaving room for a Devin/Cursor-style desktop environment. The same action manifest should work for both backends:

- Browser actions produce DOM targets and viewport coordinates.
- Desktop/CUA actions produce screen coordinates, window metadata, and active app/window title.
- Both write the same artifact bundle: WebM, final screenshot, manifest, private logs/traces.

The backend decision should be automatic but explainable:

- Use `browser-page` when the proof is inside a web app viewport.
- Use `virtual-desktop` when the flow leaves the page viewport, needs visible browser chrome, involves a native/file dialog, needs terminal UI, requires live takeover, or uses a CUA model that acts at screen-coordinate level.

Do not make noVNC the default recorder yet. It is the right long-term substrate for CUA and take-control sessions, but it increases secret exposure, video noise, runtime image size, and flake surface. The v1 browser recorder should define the stable control/evidence contract; noVNC should later implement the same contract as a second capture backend.
