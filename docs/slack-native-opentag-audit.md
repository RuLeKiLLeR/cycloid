# OpenTag Slack-Native Audit

Audit date: 2026-06-27; refreshed against latest `main` on 2026-06-29

Source audited:

- OpenTag clone: `/tmp/opentag-audit.rzUymW/OpenTag`
- Cycloid worktree: `../cycloid_2-opentag-audit`
- Cycloid base: `32a0c75dc` on `audit-opentag-slack-native`

Goal: understand exactly what OpenTag does technically to make an agent feel native/alive in Slack, then map the same paradigm onto Cycloid.

## Executive Summary

OpenTag feels Slack-native because it treats Slack as the primary product surface, not as a webhook trigger. The Slack thread is the conversation, the Slack message is the status UI, Slack buttons and modals are write gates, Slack assistant pane is a first-class chat home, and the agent is expected to render structured UI in Slack rather than dump prose.

Most of that behavior is not OpenTag business logic. OpenTag is a thin app layer over `@copilotkit/bot-slack`:

- OpenTag configures the Slack app surfaces: Socket Mode, assistant pane, DMs, slash commands, interactivity, file scopes, and response policy.
- `@copilotkit/bot-slack` owns transport: Bolt, Socket Mode, event filtering, thread mapping, native streaming, assistant pane lifecycle, Block Kit rendering, modals, ephemeral messages, interactions, user lookup, history reads, file upload/download, and ack-first delivery.
- OpenTag app code owns the product primitives: `read_thread`, render tools, issue/page/status cards, charts/diagrams/tables, `confirm_write`, slash commands, modal submission behavior, and per-turn sender context.

Cycloid already has the hard infrastructure: multi-workspace bot tokens, signed webhooks, identity binding, thread-to-session mapping, repo authorization, Slack status cards, PR updates, Slack thread tools, channel alert automation, and strict token boundaries. The gap is product feel. Cycloid currently behaves like a powerful coding service reachable from Slack; OpenTag behaves like a coworker whose desk is Slack.

The highest-leverage adaptation is not adopting CopilotKit. It is adopting the Slack product paradigm:

1. Make Slack threads and DMs real conversational sessions, with lower-friction follow-ups.
2. Add Slack Assistant pane support as a native home.
3. Expand status cards into interactive working objects: stop, resume, retry, answer, approve.
4. Add structured Slack render tools for Cycloid artifacts.
5. Add restart-safe human-in-the-loop interactions for approvals and pending questions.
6. Add real Slack E2E verification for visual rendering and interactions.

Recommended path: `build-smaller`. The cheapest useful signal is a Slack-native session card plus DM/follow-up behavior change plus one restart-safe interaction primitive. Scale if users continue conversations in Slack without being prompted back to the web UI; kill or narrow if Slack usage remains only session start/notification.

## 1. What OpenTag Does

### 1.1 Slack App Configuration

OpenTag's Slack app manifest is intentionally broad. It enables the surfaces users naturally expect from a Slack-native agent:

- App Home message tab enabled so users can DM the bot: `slack-app-manifest.yaml:12-15`.
- Slack Assistant pane via `assistant_view`: `slack-app-manifest.yaml:18-24`.
- Slash commands: `/agent`, `/triage`, `/preview`, `/file-issue`: `slack-app-manifest.yaml:25-41`.
- Bot scopes for mentions, assistant pane, channel/group/DM history, users/email lookup, team lookup, messages, public posting, customized posting, DMs, group DMs, files, channel joining, and commands: `slack-app-manifest.yaml:46-73`.
- Event subscriptions for `app_mention`, `assistant_thread_started`, `assistant_thread_context_changed`, `message.im`, and `message.mpim`: `slack-app-manifest.yaml:75-83`.
- Interactivity and Socket Mode: `slack-app-manifest.yaml:84-86`.

The important product decision is that Slack has multiple native entry points. OpenTag does not require every user interaction to be an `@mention` in a channel. It declares DMs, assistant pane, slash commands, buttons, and modals as peers.

### 1.2 Two-Process Architecture

OpenTag splits the Slack bridge from the agent runtime:

- `app/index.ts` is the chat-platform bot process.
- `runtime.ts` is the AG-UI agent backend.

The setup doc describes the flow as:

`Slack / Discord / Telegram / WhatsApp -> bot (app/) -> AG-UI -> runtime (runtime.ts)` (`setup.md:18-30`).

This matters because the Slack bridge can own Slack lifecycle and rendering, while the runtime owns LLM/MCP reasoning. OpenTag's `runtime.ts` says the Slack-side primitives (`read_thread`, `confirm_write`, issue/page cards) are forwarded to the agent as client-provided tools on every run (`runtime.ts:19-21`).

### 1.3 Adapter Composition

`app/index.ts` imports the Slack adapter and defaults from `@copilotkit/bot-slack`:

- `slack`
- `defaultSlackTools`
- `defaultSlackContext`
- `SanitizingHttpAgent`

Evidence: `app/index.ts:22-27`.

The bot starts Slack only when both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are present (`app/index.ts:78-82`). It then passes Slack-specific behavior:

```ts
respondTo: {
  directMessages: true,
  appMentions: { reply: "thread" },
  threadReplies: "mentionsOnly",
}
```

Evidence: `app/index.ts:90-94`.

This is a product-policy layer:

- DMs are conversational.
- Channel mentions reply in thread.
- Plain channel thread replies remain quiet unless they mention the bot.

OpenTag also disables tool-status noise (`showToolStatus: false`) so Slack does not fill with low-value progress rows (`app/index.ts:83-86`).

### 1.4 Assistant Pane

OpenTag opts into Slack's assistant pane and customizes greeting/suggested prompts:

- Manifest enables `assistant_view`: `slack-app-manifest.yaml:18-24`.
- Bot scope includes `assistant:write`: `slack-app-manifest.yaml:49`.
- App code passes greeting and suggested prompts to the Slack adapter: `app/index.ts:95-111`.
- App code personalizes suggested prompts when Slack starts an assistant thread: `app/index.ts:241-257`.

The adapter handles the real Slack mechanics. The sub-agent audit traced `@copilotkit/bot-slack` behavior:

- Registers Slack Bolt Assistant middleware.
- Handles `assistant_thread_started`.
- Posts greeting and suggested prompts.
- Scopes assistant-pane messages to a Slack thread.
- Auto-titles from the first message.
- Avoids duplicate handling by skipping assistant-thread DMs in the generic message listener.

I could not install the adapter package from npm because `npm install` failed with `No matching version found for @copilotkit/bot-discord@^0.1.0`. OpenTag's README acknowledges the standalone npm path is not dependable yet (`README.md:23-26`, `setup.md:60-89`). The adapter claims above come from the parallel source inspection, not from installed package verification in this worktree.

### 1.5 Thread and Session Model

OpenTag treats the Slack conversation as the session. Normal channel mentions scope to the thread root timestamp. DMs scope to a DM sentinel. Assistant pane messages scope to the pane thread.

OpenTag app code itself is small:

- `createBot` gets adapters, agent factory, tools, context, and commands: `app/index.ts:182-210`.
- `bot.onMention` is the normal turn handler and calls `thread.runAgent`: `app/index.ts:222-226`.
- The agent factory creates a `SanitizingHttpAgent`, assigns `threadId`, and sends work to `AGENT_URL`: `app/index.ts:190-197`.

The important UX consequence: a Slack thread is not just a trigger that creates an off-Slack session. It is the thing the agent keeps reading and writing.

### 1.6 Conversation Grounding: `read_thread`

OpenTag gives the agent a Slack-native tool:

```ts
const messages = await thread.getMessages();
```

Evidence: `app/tools/read-thread.ts:16-34`.

The tool description explicitly tells the agent to call it before turning a conversation into a Linear issue or Notion postmortem (`app/tools/read-thread.ts:18-22`). `runtime.ts` reinforces that rule: for "write this thread up", call `read_thread` first and never invent thread content (`runtime.ts:167-168`).

This makes the Slack thread a source of truth. The user can say "file this thread as a bug" and the agent has an actual local capability for reading the thread it is sitting in.

### 1.7 Sender Context

OpenTag injects the requesting Slack user into each run:

- `senderContext` formats name, email, platform, and platform user id: `app/sender-context.ts:12-21`.
- `bot.onMention` passes that context into `thread.runAgent`: `app/index.ts:224-226`.
- Slash commands also pass sender context: `app/commands/index.ts:33-36`, `app/commands/index.ts:50-53`, `app/commands/index.ts:117-122`.

`runtime.ts` then instructs the model to use that requester context for "my issues", assignee lookup, attribution, and mentions (`runtime.ts:190-199`).

This is small but important. It makes the agent feel like it knows who is talking, not like a stateless webhook.

### 1.8 Native Streaming and Message Editing

OpenTag relies on `@copilotkit/bot-slack` for streaming. The sub-agent source inspection found:

- Threaded replies stream with Slack's native `chat.startStream`, `chat.appendStream`, and `chat.stopStream`.
- Flat DMs fall back to placeholder `chat.postMessage` plus throttled `chat.update`.
- Legacy streaming auto-closes Markdown and converts to Slack mrkdwn.
- Assistant pane uses native composer status instead of thread placeholder messages.

OpenTag app code configures this indirectly by using `slack(...)` and not opting out (`app/index.ts:78-112`). The setup and E2E docs emphasize sampling while the bot streams (`e2e/README.md:3-12`, `e2e/run.ts:140-154`).

This is one of the largest differences from Cycloid. OpenTag users can see the response forming in Slack. Cycloid mostly posts lifecycle cards and final summaries.

### 1.9 Slash Commands

OpenTag defines four app-owned slash commands (`app/commands/index.ts:20-135`):

- `/agent <text>`: mention-free prompt entry point; command text is passed directly as the prompt because slash command args do not appear in channel history (`app/commands/index.ts:21-37`).
- `/triage [note]`: summarizes current conversation and proposes Linear issues (`app/commands/index.ts:40-55`).
- `/preview <title>`: posts a private draft via Slack ephemeral message, with DM fallback (`app/commands/index.ts:57-99`).
- `/file-issue`: opens a modal if the platform supports it; falls back to conversation otherwise (`app/commands/index.ts:101-134`).

The Slack-native idea is not the command names. It is the use of different Slack privacy surfaces:

- Public thread for shared work.
- Ephemeral for "only you see this".
- DM fallback when ephemeral is unavailable.
- Modal for structured input.

### 1.10 Modals

OpenTag's `/file-issue` modal uses Slack-native structured inputs:

- Title text input.
- Description multiline input.
- Priority select.
- Type radio buttons.

Evidence: `app/modals/file-issue.tsx:86-121`.

The submission handler is Slack-aware. It validates synchronously, then fire-and-forgets the agent run so the interaction can be acknowledged inside Slack's approximately three-second view submission deadline (`app/modals/file-issue.tsx:44-51`, `app/modals/file-issue.tsx:64-79`).

This is exactly the kind of operational detail that makes a Slack agent feel robust. It prevents Slack retry/double-submit behavior from becoming duplicate Linear issues.

### 1.11 Human-in-the-Loop Write Gates

OpenTag has a first-class `confirm_write` frontend tool:

- Tool schema and description: `app/human-in-the-loop/confirm-write-tool.tsx:16-37`.
- Handler posts a `ConfirmWrite` component and waits for `thread.awaitChoice`: `app/human-in-the-loop/confirm-write-tool.tsx:38-45`.
- The card has Create and Cancel buttons with structured values: `app/human-in-the-loop/confirm-write.tsx:41-71`.
- Button `onClick` handlers update the original card in place to approved/declined state: `app/human-in-the-loop/confirm-write.tsx:45-68`.

`runtime.ts` makes this a hard policy: before creating or modifying anything in Linear or Notion, call `confirm_write`, wait for approval, then write only if confirmed (`runtime.ts:229-235`).

The key pattern: approval lives in Slack, and the approved/declined state is reflected in the Slack message itself. The agent does not just ask "should I?" in prose and hope the next message is interpreted correctly.

### 1.12 Restart-Safe Interaction Design

OpenTag's E2E restart recovery test treats Slack message metadata as the durable source of truth:

- The test says Slack is source of truth for `button.value` and `message.metadata.event_payload`: `e2e/restart-recovery.ts:4-8`.
- Flow starts bridge instance 1, posts a picker, stops instance 1, starts instance 2, injects `block_actions`, and asserts the picker is replaced in place: `e2e/restart-recovery.ts:19-31`.

This is the "approve 20 minutes later after deploy" story. The caveat is that the click is synthetic via Bolt `app.processEvent`, not a real Slack client click, but the persistence pattern is correct.

OpenTag docs say Redis can be added for durable interactive state (`setup.md:171-177`). The current default is in-memory, which is not durable enough for production unless a store is configured.

### 1.13 Rich Slack Rendering

OpenTag avoids Markdown walls by giving the agent render tools. The model decides content; app code owns Slack rendering.

Tool wrappers:

- `issue_card`: `app/tools/render-tools.tsx:18-29`.
- `issue_list`: `app/tools/render-tools.tsx:32-44`.
- `page_list`: `app/tools/render-tools.tsx:47-58`.
- `show_incident`, `show_status`, `show_links`: `app/tools/showcase-tools.tsx:84-95`, `app/tools/showcase-tools.tsx:128-138`, `app/tools/showcase-tools.tsx:172-180`.
- `render_chart`, `render_diagram`, `render_table`: listed in `app/tools/index.ts:32-44`.

The runtime prompt makes rendering mandatory for structured output:

- "Whenever your answer contains structured output, you MUST call the matching render tool": `runtime.ts:201-205`.
- It maps issues, pages, tables, status, incidents, links, charts, and diagrams to concrete render tools: `runtime.ts:206-215`.
- It tells the model not to restate rendered content in prose: `runtime.ts:216-221`.

This is a product-quality lesson. Native Slack UX requires deterministic renderers for common artifacts, not hoping the LLM emits Slack-friendly Markdown.

### 1.14 Cards and Buttons

OpenTag's showcase incident card demonstrates both non-blocking interactions and in-place updates:

- Acknowledge button updates the card in place and attributes the user: `app/tools/showcase-tools.tsx:52-64`.
- Escalate button posts a follow-up: `app/tools/showcase-tools.tsx:68-75`.

This is a Slack-native "working object": the message is not just output; it is an interface.

### 1.15 Files, Charts, Diagrams, Tables

OpenTag makes visual output native to Slack:

- Charts are rendered through Chart.js in a local headless browser and posted as images.
- Mermaid diagrams are rendered to sanitized SVG/PNG and posted as images.
- Tables are rendered through a Slack table component with monospace fallback.

Relevant evidence:

- Chart runtime: `app/render/chart.ts`.
- Chart tool posts titled image: `app/tools/render-chart.tsx`.
- Diagram runtime: `app/render/diagram.ts`.
- Diagram tool: `app/tools/render-diagram.tsx`.
- Table tool: `app/tools/render-table.tsx`.
- Setup doc notes Chart.js/Mermaid are local browser renders and data is not sent to a rendering service: `setup.md:165-169`.

The key UX detail from the tool code: post a title/caption before upload so the Slack thread reads in the right order.

### 1.16 Testing Posture

OpenTag has useful but incomplete verification:

- Unit tests render JSX to Slack JSON via `renderSlackMessage(...)`.
- Live Slack E2E samples Slack API replies while streaming.
- Restart E2E validates interaction metadata and synthetic `block_actions`.

Known gaps:

- Standalone dependency install currently fails; README says monorepo is the dependable path.
- E2E README claims screenshots/browser sending, but current `e2e/run.ts` is API-first and does not implement screenshots.
- Live tests do not fully prove charts, diagrams, modals, ephemeral messages, native table rendering, or real user button clicks.

OpenTag's testing posture is still directionally useful: real Slack rendering needs real Slack E2E because Block Kit limits, Slack rendering quirks, rate limits, and event delivery behavior are not fully caught by unit tests.

## 2. What Cycloid Does Today

### 2.1 Strong Existing Foundations

Cycloid's Slack implementation is more production-hardened than OpenTag's demo app in several ways:

- Signed Slack webhook verification with timestamp freshness: `apps/control-plane-worker/src/webhooks/verify.ts`, `apps/control-plane-worker/src/webhooks/shared.ts`.
- Event idempotency before dispatch: `apps/control-plane-worker/src/webhooks/slack-events.ts:70-78`.
- Multi-workspace bot token model keyed by `team_id`: `docs/slack.md`.
- Encrypted workspace bot tokens and fail-closed token resolution: `apps/control-plane-worker/src/slack/workspaces.ts`, `apps/control-plane-worker/src/slack/tokens.ts`.
- Magic-link Slack identity binding: `docs/slack.md`.
- Slack-origin sessions persist `slackTeamId` in callback context: `apps/control-plane-worker/src/webhooks/shared.ts:2755-2761`.
- Thread-to-session mapping via `slack_thread` refs: `apps/control-plane-worker/src/webhooks/shared.ts:2641-2670`.
- Repo resolution, disambiguation, authorization, and provider credential gating before session start.
- Slack attachments handling.
- Slack dynamic tools are server-mediated; sandbox gets team id, not bot token.
- `send_message` is restricted to the originating Slack thread.
- User-token Slack search is optional and gated.
- Channel alert automation for Datadog/Sentry-like bot messages.

This means Cycloid should not copy OpenTag's security model. Cycloid should copy the UX paradigm while keeping the control plane as the boundary for auth, authorization, validation, state transitions, and credential use.

### 2.2 Current Ingress Behavior

Cycloid handles Slack Events API webhooks:

- `app_mention` is the normal channel trigger.
- `message.im` can be promoted onto the same path, but only when the DM text mentions the bot.
- Non-mentioned DMs are ignored by design.
- Existing channel thread follow-ups require a live bot mention, except `stop`.
- DMs are exempt from the follow-up mention gate once a session exists.

Evidence:

- DM explanation and detection: `apps/control-plane-worker/src/webhooks/slack-events.ts:86-97`.
- DM promotion only if message mentions bot: `apps/control-plane-worker/src/webhooks/slack-events.ts:191-197`.
- New session skips non-mentions: `apps/control-plane-worker/src/webhooks/slack-events.ts:441-444`.
- Existing thread follow-up mention gate: `apps/control-plane-worker/src/webhooks/slack-events.ts:410-419`.

This is robust but not natural. A coworker DM does not require `@Name` inside the DM; an active thread usually does not require repeatedly mentioning the teammate who is already participating.

### 2.3 Current Session Start Behavior

Cycloid session start is sophisticated:

1. Verify request.
2. Deduplicate event.
3. Resolve workspace/team/bot user.
4. Resolve actor to Cycloid user or send magic-link binding prompt.
5. Resolve business.
6. Claim thread to prevent duplicate sessions.
7. Resolve repo via explicit/default/inferred/disambiguation.
8. Verify repo access and GitHub installation.
9. Create session and callback context.
10. Post starting Slack status card.
11. Enqueue prompt.

Evidence:

- Identity resolution: `apps/control-plane-worker/src/webhooks/slack-events.ts:273-341`.
- Thread claim: `apps/control-plane-worker/src/webhooks/shared.ts:2641-2670`.
- Callback context: `apps/control-plane-worker/src/webhooks/shared.ts:2755-2761`.
- Starting status post: `apps/control-plane-worker/src/webhooks/shared.ts:2959-2977`.
- Bootstrap prompt enqueue: `apps/control-plane-worker/src/webhooks/shared.ts:2397-2515`.

Cycloid's weakness is not correctness. It is that Slack users mostly experience this as a status card and then a final reply, not as a living conversation.

### 2.4 Current Slack Status Surface

Cycloid posts a durable status card:

- Starting status before enqueue.
- In-place running update.
- PR-created update.
- Terminal completion/failure update.
- Optional separate prompt reply.
- PR-merged thread reply.

Evidence:

- Status posting: `apps/control-plane-worker/src/webhooks/shared.ts:2296-2353`.
- Running phase update only supports `"running"`: `apps/control-plane-worker/src/slack/phase-updates.ts:19-25`.
- `deliverThreadStatus` updates existing message or posts fallback: `apps/control-plane-worker/src/slack/notify.ts:264-290`.
- Terminal delivery path: `apps/control-plane-worker/src/session/durable-object.ts:13062-13153`.
- PR-created update: `apps/control-plane-worker/src/session/pr-notifications.ts:134-176`.

This is useful but thin. It does not expose enough of the agent's working state for Slack to feel like the native workspace.

### 2.5 Current Slack Interactions

Cycloid currently handles Slack interactions for:

- `stop_session`.
- Repo disambiguation selection.

Evidence: `apps/control-plane-worker/src/webhooks/slack-interactions.ts:46-94`.

The status card itself mostly has navigation buttons, not working controls. There is no general Slack-native interaction primitive for:

- Approving an action.
- Answering an agent question.
- Resuming a stopped session.
- Retrying a failed session.
- Changing repo selection after start.
- Assigning reviewer/owner.
- Choosing among plans.

### 2.6 Current Agent Slack Tools

Cycloid exposes Slack tools to the sandbox through a server-mediated path:

- Session DO proxies `get-thread`, `search-messages`, and `send-message`.
- Sandbox gets `ARCANIST_SLACK_TEAM_ID`, not the bot token.
- `send_message` is restricted to the originating Slack thread.
- Search requires the session owner's Slack user token.

This is the right security shape. The missing piece is product shape. The current `send_message` is a raw text post to the same thread, not a structured workflow like "ask this teammate", "request approval", or "post a status card".

### 2.7 Current Channel Automation

Cycloid has Slack channel automation for alert providers:

- Configured root messages from allowed alert apps can trigger sessions.
- Thread replies, unsupported subtypes, self events, and unsupported senders are rejected.
- It handles duplicate suppression, backpressure, status posts, and enqueue.

Evidence:

- Event handling in `apps/control-plane-worker/src/webhooks/slack-events.ts:119-147`.
- Trigger rules in `apps/control-plane-worker/src/automation/slack-channel-trigger.ts`.
- Session creation in `apps/control-plane-worker/src/automation/slack-channel-service.ts`.

This is alert-native, not coworker-native. It helps Cycloid react to monitoring tools, but not yet "live in a channel" as an ambient teammate.

## 3. Cross-Examination: OpenTag vs Cycloid

### 3.1 Product Surface

OpenTag:

- Slack app is configured as an AI app with assistant pane.
- DMs are conversational.
- Slash commands offer mention-free actions.
- Modals collect structured input.
- Ephemeral messages reduce channel noise.
- Buttons turn messages into interactive controls.

Cycloid:

- Slack is mostly `app_mention` plus strict DM mention promotion.
- No Assistant pane support documented or implemented.
- No slash-command product surface observed in this audit.
- Interactions are narrow: stop and repo disambiguation.
- Status cards are mostly links and lifecycle updates.

Change needed:

- Add Assistant pane events/scopes/config.
- Add slash command endpoints if we want `/cycloid`, `/verify`, `/ask-cycloid`, etc.
- Add modal and ephemeral helpers in `apps/control-plane-worker/src/slack/notify.ts`.
- Expand `slack-interactions.ts` into a small interaction router with typed action ids and authorization.

### 3.2 Conversation Model

OpenTag:

- Slack conversation is the session substrate.
- Thread history is re-read and passed to the agent.
- The adapter handles conversation keys and Slack-native streaming.

Cycloid:

- Slack thread maps to a Cycloid session.
- Thread follow-ups enqueue into that session.
- Context is collected into prompts.
- The actual canonical session lives in Cycloid, not Slack.

This is mostly aligned. Cycloid's model is stronger for coding sessions. The UX gap is friction:

- Mention-free DMs should be accepted.
- Existing Cycloid-owned channel threads should allow mention-free replies under a narrow active-session rule.
- Slack should surface waiting-for-input and approvals as structured interactions.

Recommended rule for Cycloid:

- New channel session: require `@Cycloid` or slash command.
- Existing active channel session: accept mention-free thread replies only if the session is in `waiting_for_input` or the last Cycloid Slack reply explicitly requested user input.
- Existing active channel session during normal running: keep mention required to avoid absorbing chatter.
- DM: accept all non-bot messages as addressed to Cycloid once identity is bound.

This gives the "coworker" feel without sweeping every thread reply into the agent.

### 3.3 Streaming and Progress

OpenTag:

- Streams tokens into Slack or uses native assistant status.
- Suppresses tool-status noise by default.

Cycloid:

- Updates status at coarse lifecycle points.
- Does not stream agent output into Slack.
- Running phase update only supports `"running"`.

Change needed:

- Do not blindly stream full Codex output into Slack. For coding sessions, raw streaming is noisy.
- Instead stream or periodically edit a concise "working state" card:
  - setting up sandbox
  - reading repo
  - planning
  - editing files
  - running tests
  - opening PR
  - waiting for input
  - blocked
  - done
- Add a Slack-specific phase projection from existing session events rather than exposing every event.
- Keep one durable message updated in place to avoid thread spam.

The OpenTag principle is "make work visible where the user is." The Cycloid version should be a live status object, not token streaming.

### 3.4 Rendered Artifacts

OpenTag:

- Agent calls render tools for cards, tables, charts, diagrams.
- System prompt forbids restating structured output as prose.
- Components encode Slack-specific limits and formatting.

Cycloid:

- Has status blocks, prompt reply blocks, repo disambiguation blocks, and PR merged blocks.
- Most agent output still lands as text summary/final reply.
- No general agent-facing render tools for Cycloid-specific artifacts.

Change needed:

Add server-owned Slack renderers for common Cycloid artifacts:

- `session_status_card`
- `plan_card`
- `test_results_card`
- `pr_card`
- `question_card`
- `approval_card`
- `file_change_summary_card`
- `verification_result_card`

Do not expose arbitrary Block Kit generation to sandbox agents initially. Let agents emit structured events or call typed control-plane tools; control plane renders allowed cards.

### 3.5 Human-in-the-Loop

OpenTag:

- `confirm_write` is a blocking frontend tool.
- Slack button values carry structured decision payload.
- Button click updates card in place.
- Restart recovery treats Slack metadata as durable source of truth.

Cycloid:

- Has waiting-for-input session phase.
- Has Slack follow-ups.
- Has interactions only for stop and repo disambiguation.
- No generic Slack-native approval/question primitive.

Change needed:

Build a first-class `slack_interaction_requests` or equivalent table keyed by:

- `request_id`
- `business_id`
- `session_id`
- `slack_team_id`
- `channel_id`
- `thread_ts`
- `message_ts`
- `kind`
- `payload_json`
- `allowed_actor_user_ids` or business authorization policy
- `expires_at`
- `consumed_at`

Interaction kinds:

- `answer_question`
- `approve_action`
- `choose_option`
- `resume_session`
- `retry_session`
- `stop_session`

Slack action ids should carry a short request id, not all payload. The control plane should re-load and authorize the request before mutating state.

### 3.6 DMs

OpenTag:

- DMs are enabled and natural.

Cycloid:

- DMs require `@Cycloid` by design (`docs/slack.md`).

Change needed:

- Accept mention-free DMs from linked users.
- Preserve DM privacy by continuing to exclude DMs from company memory.
- Keep unlinked DM behavior conservative: send magic-link identity binding, then let future DMs be natural.
- Ensure no accidental bot loops by ignoring bot/app subtypes as today.

This is likely the cheapest high-signal change. It affects only 1:1 DM behavior and aligns with Slack user expectations.

### 3.7 Follow-Ups

OpenTag:

- Configured as `threadReplies: "mentionsOnly"` for plain channel threads.
- But assistant pane and DMs are conversational.

Cycloid:

- Existing channel session follow-ups require live mention.
- DMs are exempt only after a promoted session exists.

Change needed:

- Keep channel mention requirement for broad safety, but add "awaiting user" exception.
- If Cycloid asks a specific question in Slack, the next human reply in the same thread should be accepted without another mention.
- Add clear status text: "Waiting for your answer" with an Answer button or modal.

### 3.8 Slash Commands

OpenTag:

- Uses slash commands as native shortcuts.

Cycloid:

- This audit did not find a Slack slash command surface.

Potential Cycloid commands:

- `/cycloid <prompt>`: start session in current channel.
- `/cycloid verify <pr-url>`: start verifier.
- `/cycloid status`: show user's active sessions.
- `/cycloid stop`: stop current bound thread session.
- `/cycloid settings`: ephemeral links to settings.

Implementation cost:

- New Slack command endpoint using the same Slack signature verifier.
- D1 idempotency keyed on `trigger_id`/body hash.
- Immediate ack within Slack deadline.
- Command-specific authorization and repo resolution.
- Tests and Slack app manifest/scopes update.

Recommendation: defer slash commands until DM/follow-up/card interactions are proven. Commands add app config and UX surface; they are useful, but not the smallest proof of "living in Slack."

### 3.9 Assistant Pane

OpenTag:

- Assistant pane is a first-class surface.

Cycloid:

- No assistant pane path observed.

Potential Cycloid use:

- "Ask Cycloid" side panel for repo questions and session launch.
- Suggested prompts based on user's recent sessions/repos.
- Context change events could inject current channel context.
- Pane can be private by default, avoiding noisy channel starts.

Implementation cost:

- Add `assistant:write` scope.
- Slack app config update.
- Events: `assistant_thread_started`, `assistant_thread_context_changed`, assistant message routing.
- Session mapping for assistant pane threads.
- UX design for suggested prompts and privacy.

Recommendation: second wave after interactive status cards. Assistant pane is high-upside but less immediately tied to current Cycloid Slack sessions.

## 4. Concrete Cycloid Adaptation Plan

### Phase 1: Make Existing Slack Sessions Feel Alive

Scope:

- No new dependency.
- No Socket Mode.
- No Assistant pane.
- No arbitrary Block Kit from sandbox.
- Extend current Events API and Web API architecture.

Changes:

1. Accept mention-free DMs from linked users.
2. Add `waiting_for_input` Slack status rendering.
3. Add Stop button to the durable status card.
4. Add Resume/Retry button where state allows.
5. Add one restart-safe `answer_question` interaction card.
6. Add real Slack E2E for DM and button interaction.

Why this is the right 80/20:

- Uses existing multi-workspace token model.
- Uses existing webhook/interactions route.
- Uses existing session state and waiting-for-input semantics.
- Directly attacks the "Slack is just a trigger" feel.
- Avoids committing to a new Slack app surface before we prove users want deeper Slack usage.

Kill/scale signal:

- Scale if Slack-origin sessions get follow-up replies and user questions answered in Slack without UI clicks.
- Kill or narrow if users still mostly open the web UI for every meaningful interaction.

### Phase 2: Structured Slack Work Objects

Add typed renderers and interactions:

- `ApprovalCard`: approve/cancel risky or user-visible actions.
- `QuestionCard`: answer in thread or modal.
- `PlanCard`: approve selected plan or ask for smaller plan.
- `VerificationCard`: rerun verification, open logs/session/PR.
- `PRCard`: merge readiness, PR URL, CI state, review status.

Control plane owns rendering and authorization. Sandbox can request these through typed events/tools, but never sends arbitrary Block Kit.

### Phase 3: Slack-Native Commands and Private Surfaces

Add:

- `/cycloid` command endpoint.
- Ephemeral previews for settings/errors/session selection.
- Modals for structured session start if needed.
- Optional Assistant pane.

Use this only after Phase 1/2 show Slack is becoming a real workspace surface.

### Phase 4: Ambient Coworker Behaviors

Careful later-stage ideas:

- Channel memory/context cards for configured channels.
- "Ask teammate" workflow that posts a structured request to the source thread or DM.
- Scheduled or event-driven Slack check-ins for blocked sessions.
- Slack search-backed repo/context retrieval when user has OAuth.

These are high-blast-radius if done too early. Keep them gated by explicit workspace/channel settings.

## 5. Implementation Assessment: Exact Work Needed

This is the concrete implementation map for bringing the OpenTag paradigm into Cycloid without importing OpenTag's stack.

### 5.1 Capability Matrix

| Capability                   | OpenTag behavior                                             | Cycloid today                                                                         | Required Cycloid change                                                                                          | Phase |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----- |
| Mention-free DMs             | DMs are natural conversations.                               | DMs require `@Cycloid` before promotion.                                              | Treat `message.im` from linked users as addressed to Cycloid after bot/self filtering.                           | 1     |
| Channel thread follow-ups    | Channel thread replies require mentions by policy.           | Existing session follow-ups require live mention except stop.                         | Keep mention requirement except when the session is `waiting_for_input`; route that reply as the pending answer. | 1     |
| Durable status card          | Slack message is the active work object.                     | Status card mostly shows lifecycle plus View PR/View Session.                         | Render all meaningful phases and phase-gated buttons.                                                            | 1     |
| Stop/resume/respond controls | Buttons mutate state inside Slack.                           | Stop exists as a narrow ad hoc interaction; resume/respond exist as web routes.       | Generalize interactions and call existing `stopSession`, `resumeSession`, `respondToSession` services.           | 1     |
| Approval/question cards      | `confirm_write` blocks until Slack button choice.            | Questions primarily live in UI/session state; Slack can notify but not fully control. | Persist Slack interaction requests, render cards, single-consume clicks/submissions.                             | 2     |
| Structured renderers         | Agent calls app-owned render tools for issues/status/charts. | Cycloid mostly posts summaries, status, PR links, and prompt replies.                 | Add typed control-plane renderers for plans, questions, approvals, verification, PR readiness.                   | 2     |
| Ephemeral/private workflow   | Slash commands can answer privately or DM fallback.          | No command or ephemeral helper observed.                                              | Add `postEphemeral`; use for private repo selection, settings, errors, previews.                                 | 3     |
| Modals                       | Slash commands/buttons open structured modals.               | No `views.open` helper observed.                                                      | Add modal helper and state-backed submissions for answer/session-start flows.                                    | 3     |
| Assistant pane               | First-class Slack Assistant home.                            | No assistant event path observed.                                                     | Add Slack app assistant config, event handlers, and assistant-thread session mapping.                            | 3     |
| Native token streaming       | Uses Slack streaming/update APIs.                            | Cycloid exposes lifecycle/status, not token streaming.                                | Prefer richer phase/event projection first; consider streaming only after cards prove useful.                    | Later |

### 5.2 Slack App Configuration Delta

Phase 1 can avoid new Slack scopes if it stays within current events, bot posting, and existing interactivity. The app already receives Events API callbacks and has an interactions endpoint.

New scope/config needs by later phase:

- Slash commands: add command definitions to the Slack app and route command payloads through a signed endpoint.
- Assistant pane: add `assistant:write`, `assistant_thread_started`, `assistant_thread_context_changed`, and assistant view config.
- File or chart upload: current documented scopes include `files:read`; bot-origin uploads would need a write-capable file scope.
- Public-channel proactive posting or customized identity should remain out of Phase 1; avoid `chat:write.public` and `chat:write.customize` until there is a user-facing reason.

### 5.3 Persistent Slack Interaction Model

OpenTag's restart-safe pattern should become a D1-backed control-plane primitive, not in-memory state. Proposed table:

```sql
CREATE TABLE slack_interaction_requests (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  session_id TEXT,
  slack_team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT,
  message_ts TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  allowed_actor_user_id TEXT,
  allowed_slack_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
```

Rules:

- `id` is the only payload embedded in Slack `action_id` or `value`: `cycloid:<kind>:<id>`.
- `payload_json` holds question id, candidate answer metadata, approval target, or retry parameters.
- `status` is `pending`, `consumed`, `expired`, or `canceled`.
- Consumption is transactional: update `pending -> consumed` with `WHERE id = ? AND status = 'pending' AND expires_at > ?`.
- Authorization is always reloaded server-side; Slack button payloads are hints, not authority.
- DAOs should be raw prepared statements under the existing D1 pattern.

This table is needed before approvals, answer cards, restart-safe modals, or long-lived action buttons. Without it, clicks after deploy/restart become unreliable or must encode too much state in Slack payloads.

### 5.4 Interaction Dispatch Flow

All interactive Slack controls should share one control-plane flow:

1. Verify Slack signature and timestamp using the existing interaction route.
2. Ack quickly. If the operation may touch a Durable Object or external service, return the Slack ack and continue with `ctx.waitUntil`.
3. Parse `action_id` or `value` as `cycloid:<kind>:<request_id>`.
4. Load the request from D1 and fail closed if missing, expired, consumed, wrong team, wrong channel, wrong thread, or wrong session.
5. Resolve the Slack actor to a Cycloid user for that team.
6. Authorize the actor against the business/session policy. At minimum, match session owner or existing shared-session permission.
7. Re-check the current session phase with shared eligibility helpers.
8. Call the existing service:
   - Stop: `stopSession(env, sessionId, requestId)`.
   - Resume: route-equivalent checks plus `resumeSession(env, sessionId, requestId)`.
   - Answer: `respondToSession(env, sessionId, answer, questionId, requestId)`.
   - Retry: add only if there is already a server-side retry primitive with equivalent route authorization.
9. Update the source Slack message in place. If the update fails for non-terminal cards, log and avoid posting duplicate status spam.
10. Mark consumed only after the state mutation is accepted, or mark failed with retry semantics if the click should remain usable.

This is an extension of Cycloid's current `stop_session` pattern, not a replacement for route-level auth. Slack buttons need the same fail-closed posture as UI routes.

### 5.5 DM and Follow-Up Routing

DM change:

- In `slack-events.ts`, after existing bot/self/subtype filters, treat `isDirectMessage && linkedSlackUser` as addressed to Cycloid even when no bot mention is present.
- If the Slack user is unlinked, reply with the existing account-linking path and do not start a session.
- Continue excluding DMs from company memory.
- Preserve the current behavior that channel messages require an app mention for new sessions.

Waiting-for-input follow-up change:

- For an existing thread-bound session, if there is no live mention and the message is in a channel thread, load the session projection.
- If `phase === "waiting_for_input"` and `isRespondAvailable(phase)`, treat the human text as an answer to the pending question and call the respond path.
- Otherwise keep the current mention requirement.

This keeps the broad Slack safety model intact while removing the unnatural `@Cycloid yes` requirement when Cycloid just asked a direct question.

### 5.6 Status Card State Machine

Current `buildStatusBlocks` accepts a coarse `SlackStatusStage` and renders View PR/View Session. The Slack-native version should render from session phase and eligibility:

- `running`: headline, current step/summary if available, Stop button.
- `waiting_for_input`: question summary, Answer button, View Session button, optional "reply in this thread" text.
- `finalizing`: publish/post-execution substate, no destructive buttons.
- `stopped`: Resume button when `isResumeAvailable(phase)`.
- `failed` or `blocked`: Retry/View Session buttons only when the existing retry contract allows it.
- `completed`: PR/branch/result actions; no stale Stop/Answer.

Button availability should use `shared/session/eligibility.ts`:

- `isStopAvailable(phase, sandboxSubstate)`
- `isResumeAvailable(phase)`
- `isRespondAvailable(phase)`
- `isRetryAvailable(phase)`

`phase-updates.ts` should expand beyond update-only `running` support so a single durable Slack card tracks the whole lifecycle. Terminal failures may still post a fallback reply if the original card is gone; non-terminal update failures should prefer observability over duplicate cards.

### 5.7 Structured Render Tools

OpenTag's renderer model is worth copying, but Cycloid should keep rendering server-owned:

- Sandbox emits typed events or calls typed tools such as `request_user_answer`, `request_approval`, `render_plan`, `render_verification`, or `render_pr_status`.
- Control plane validates the event against session state, business policy, and Slack thread binding.
- Control plane renders the exact Block Kit layout.
- Sandbox never receives bot tokens and never emits arbitrary Block Kit JSON.

Initial renderers:

- `QuestionCard`: displays the pending question, Answer action, and fallback thread instruction.
- `ApprovalCard`: approve/cancel a specific server-side pending operation.
- `PlanCard`: compact plan, "approve plan", "make smaller", "open session".
- `VerificationCard`: status, evidence links, rerun if allowed.
- `PRCard`: PR link, branch, CI/review summary, merge-readiness text.

### 5.8 Slash Commands, Modals, and Assistant Pane

These should not be first. They are the durable version once cards and DMs prove Slack usage.

Slash command route requirements:

- New signed endpoint for command payloads or extend existing Slack webhook routing with a command content type.
- Idempotency keyed by Slack team, command, trigger id, channel, user, and body hash.
- Immediate ack, with async work in `waitUntil`.
- Repo/session resolution must reuse existing control-plane authorization.

Modal requirements:

- `views.open` helper in `slack/notify.ts` using bot token resolution.
- Modal callback id mapped to a D1 interaction request.
- Submission validates synchronously and acks within Slack's deadline.
- Long work continues asynchronously and updates the bound Slack thread/card.

Assistant pane requirements:

- Slack app config and scope update.
- New event handlers for assistant thread start/context change.
- Assistant-thread-to-session mapping separate from normal channel thread timestamps.
- Private default behavior; explicit action required before posting to channels.

### 5.9 Acceptance Criteria

The first implementation is successful only if all of these are true:

- A linked user can DM Cycloid without an `@mention` and get a real session.
- A channel session that asks a question accepts the next same-thread user reply without another `@mention`.
- The Slack status card shows the live phase and exposes only valid actions for that phase.
- Stop and Answer work entirely inside Slack and survive a worker restart.
- Unauthorized Slack users cannot stop, resume, answer, or approve another user's session.
- The same button click cannot mutate state twice.
- The behavior is verified in a real Cycloid-owned Slack workspace, not just mocked route tests.

## 6. Specific File-Level Changes Likely Needed

### Slack Ingress

Files:

- `apps/control-plane-worker/src/webhooks/slack-events.ts`
- `apps/control-plane-worker/src/webhooks/prompts.ts`
- `apps/control-plane-worker/src/webhooks/shared.ts`

Changes:

- Change DM gate so `message.im` from a linked user is a genuine trigger even without bot mention.
- Keep DMs excluded from company memory.
- Add existing-session follow-up exception for sessions waiting on user input; route it through `respondToSession`, not a new prompt.
- Preserve current bot/app/self-event filters.

### Slack Interactions

Files:

- `apps/control-plane-worker/src/webhooks/slack-interactions.ts`
- `apps/control-plane-worker/src/slack/blocks.ts`
- New DAO/service files under `apps/control-plane-worker/src/slack/` or `src/session/`
- Migration for durable interaction requests

Changes:

- Replace ad hoc action handling with a typed interaction dispatcher.
- Add request lookup, authorization, expiry, and single-consume semantics.
- Keep `stop_session` and repo disambiguation behavior intact while migrating new actions to `cycloid:<kind>:<request_id>`.
- Reuse `stopSession`, `resumeSession`, and `respondToSession` instead of creating Slack-only state mutation paths.
- Add tests for cross-business IDOR, replay, expired request, unauthorized actor, and duplicate click.

### Status Rendering

Files:

- `apps/control-plane-worker/src/slack/blocks.ts`
- `apps/control-plane-worker/src/slack/phase-updates.ts`
- `apps/control-plane-worker/src/session/durable-object.ts`
- `shared/session/phase.ts`

Changes:

- Expand Slack status stage model beyond `"starting" | "running" | "done" | "failed"`.
- Add `waiting_for_input`, `blocked`, `finalizing`, `publishing`, `verifying`.
- Add action buttons based on `shared/session/eligibility.ts`: Stop, Answer, Resume, Retry.
- Keep fallback text under Slack message limits.

### Slack API Helpers

Files:

- `apps/control-plane-worker/src/slack/notify.ts`

Changes:

- Add `postEphemeral`.
- Add `openView` / modal helper if slash commands or modal answers are added.
- Consider a safer update-only mode that does not fork cards on non-terminal update failures.

### Agent Runtime / Sandbox Tools

Files:

- `apps/control-plane-worker/src/slack/dynamic-tools.ts`
- `apps/sandbox-bridge/src/services/slack-dynamic-tool.ts`
- Prompt/tool docs for Slack tools

Changes:

- Add structured "ask user" / "request approval" tool instead of raw `send_message` for user-blocking questions.
- Keep raw `send_message` restricted to source thread, but make polished workflows prefer typed interactions.

### Tests

Existing mocked coverage is good but not enough for Slack-native UX. Add:

- Unit tests for DM mention-free trigger.
- Unit tests for waiting-for-input mention-free follow-up.
- Unit tests for interaction request authorization and consumption.
- Block Kit snapshot tests for new cards.
- DAO tests for request expiry, single-consume, and same-team/session constraints.
- Real Slack E2E:
  - mention-free DM starts a session
  - status card shows Stop
  - Stop button archives session
  - question card accepts button/modal answer after a worker restart
  - Slack client screenshot for card rendering

## 7. Risks and Guardrails

### Risk: Absorbing Human Chatter

Do not allow every reply in a channel thread to enqueue forever. Use narrow exceptions:

- DMs are always addressed to Cycloid.
- Channel replies are accepted mention-free only while the session is explicitly waiting for user input.
- Otherwise require `@Cycloid`.

### Risk: Cross-Business or Cross-Session Interaction Mutations

All Slack button clicks must be authorized server-side:

- Resolve Slack user to Cycloid user.
- Check session owner or same-business shared-session policy.
- Verify request belongs to same business/team/channel/thread/session.
- Enforce one-time consume.
- Fail closed on missing team/token/request/session.

Cycloid already does this well for `stop_session`; extend that pattern.

### Risk: Slack Thread Spam

Prefer one durable status card updated in place. Avoid posting new status cards except terminal fallback. For non-terminal update failure, consider logging and skipping rather than fallback posting.

### Risk: Overexposing Sandbox to Slack

Do not put bot tokens in sandbox. Keep all Slack writes server-mediated. Do not let the agent emit arbitrary Block Kit.

### Risk: App Scope Creep

Assistant pane, slash commands, modals, public posting, and customized posting each add app config and review complexity. Sequence them after the low-surface card/DM interaction proof.

## 8. Direct Borrow List

Borrow now:

- Slack thread as the native conversation object.
- Mention-free DMs.
- App-owned renderers for structured output.
- Restart-safe button interactions.
- In-place message state transitions.
- Sender context as first-class per-turn input.
- Real Slack E2E for rendering and interactions.

Borrow with Cycloid-specific shape:

- Streaming: use live status projection, not raw token stream.
- `confirm_write`: implement as control-plane approval requests for risky Cycloid actions.
- `read_thread`: Cycloid already has Slack thread tools; elevate them into polished workflows.
- Ephemeral/modal surfaces: use for previews/settings/answers, not core coding loop at first.

Do not borrow directly:

- OpenTag's dependency stack.
- OpenTag's default in-memory interaction store.
- OpenTag's raw demo-level auth/integration model.
- Arbitrary client-side render tool execution from sandbox.

## 9. Bottom Line

OpenTag's Slack-native feel comes from treating Slack messages as UI, Slack threads as sessions, and Slack interactions as durable control flow. Cycloid already has the harder backend and security pieces. The work is to expose them through Slack-native objects instead of making Slack a trigger/notification adapter.

The first serious Cycloid version should be small: natural DMs, lower-friction waiting-for-input replies, interactive status cards, and one restart-safe question/approval primitive. That is enough to test whether users actually want Cycloid to live in Slack before we add assistant pane, slash commands, modals, and broader ambient channel behaviors.
