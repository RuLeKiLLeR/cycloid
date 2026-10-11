# Cycloid UI design contract — Monochrome Control

The design system in `apps/ui/src/App.css`: how authenticated Cycloid UI should look and which visual patterns are allowed. (`AGENTS.md` covers how to build in this repo.)

"Monochrome Control" is a calm control room, not a chat toy. Sharp, elegant, punchy — every strand of hair in place. The rules:

- **Strictly achromatic grayscale on a pure-black void**, plus exactly two hues: **arcane violet** (`--color-live`) for liveness/focus only, and **error** `#ffb4ab` for blocked/failed only. Success, warning, and queued are grayscale — text label + icon, never a hue.
- **Elevation is tonal**: a lighter surface + a 1px border. No drop shadows. The only "shadows" are faint glows (white bloom on primary hover, accent bloom on live elements).
- **Corners are 0px, everywhere.** Sharp 90° angles are the brand signature. Selection indicators are 2px bars, not pills.
- **One UI type family**: Geist carries all interface text — reading text, labels, chips, eyebrows, IDs, timestamps, and data readouts. JetBrains Mono is reserved for actual code and copyable technical strings (code/diffs/logs, branch names, SHAs, paths, tokens).

Do not invent parallel colors, type scales, focus rings, or control heights. Components consume the token utilities generated from `@theme` (`bg-surface-1`, `text-text-muted`, `border-border`, etc.) and the component utilities in `App.css`.

## Scope

- Authenticated app surfaces use `apps/ui/src/App.css`.
- The logged-out public shell (`apps/ui/index.html`, `apps/ui/src/public-shell.css`, and `PublicLoginShell`) is intentionally minimal and separate. Do not migrate product UI patterns into it.
- `apps/ui/authenticated.html` owns the pre-hydration theme bootstrap. The app is dark-only: first paint hardcodes the palette (`#000000` background, `#f5f5f5` text, Geist) and the theme-color meta tag is `#000000`. No runtime theme switch.

## Product posture

Authenticated Cycloid UI should feel like a calm agent workspace, not an enterprise dashboard.

The primary object on each screen is the agent interaction:

- On dashboard/home, the composer is the hero.
- On session pages, the thread is the hero.
- Sidebars, metadata, reports, and progress are supporting surfaces.

Prefer:

- One clear center of gravity per screen.
- Fewer permanent columns.
- Fewer hard borders.
- Metadata compressed into headers, inspectors, or expandable details.
- Agent state made legible through one persistent status surface.

Avoid:

- Full-page bordered containers that make the app feel trapped.
- Multiple equal-weight panels competing with the composer or thread.
- Permanent metadata columns unless the metadata is the main task.
- Dashboard-like section chrome when a lighter list/card treatment works.

## Color

Use token utilities, not raw hex, inside React `className` strings. The `@theme` block in `App.css` is the source of truth. Dark is the only theme — the palette is achromatic.

**Surfaces and structure** (tonal elevation — depth is a lighter surface + a 1px border, never a shadow):

| Token                    | Value     | Role                                      |
| ------------------------ | --------- | ----------------------------------------- |
| `--color-surface-0`      | `#000000` | Page void / app base                      |
| `--color-surface-1`      | `#0a0a0a` | Cards, panels                             |
| `--color-surface-2`      | `#141414` | Nested containers, hover rows             |
| `--color-surface-3`      | `#1c1c1c` | Popovers, modals                          |
| `--color-border`         | `#1f1f1f` | Hairline dividers, card edges (structure) |
| `--color-border-strong`  | `#333333` | Inputs, interactive rest state            |
| `--color-border-hover`   | `#4d4d4d` | Hover                                     |
| `--color-border-focus`   | `#ffffff` | Focus + active                            |
| `--color-text-primary`   | `#f5f5f5` | Primary reading text                      |
| `--color-text-secondary` | `#a3a3a3` | Secondary metadata                        |
| `--color-text-muted`     | `#666666` | Tertiary, placeholders                    |
| `--color-text-inverse`   | `#0a0a0a` | Text on white surfaces (primary buttons)  |

**Accent = ink (white).** It backs the primary button and primary text, so the accent family stays achromatic. Soft steps are neutral gray washes.

| Token                        | Value     | Role                           |
| ---------------------------- | --------- | ------------------------------ |
| `--color-accent`             | `#ffffff` | Primary button bg, primary ink |
| `--color-accent-hover`       | `#d6d6d6` | Primary active / hover fill    |
| `--color-accent-text`        | `#f5f5f5` | Emphasized ink text            |
| `--color-accent-soft`        | `#141414` | Tinted surface wash            |
| `--color-accent-soft-hover`  | `#1c1c1c` | Tinted surface hover           |
| `--color-accent-soft-border` | `#333333` | Tinted surface border          |

**Live = arcane violet.** LIVENESS AND FOCUS ONLY (see accent discipline).

| Token                 | Value                         | Role                     |
| --------------------- | ----------------------------- | ------------------------ |
| `--color-live`        | `oklch(0.78 0.115 296)`       | Base — heartbeat, active |
| `--color-live-bright` | `oklch(0.86 0.09 296)`        | Hover / emphasized       |
| `--color-live-deep`   | `oklch(0.55 0.13 296)`        | Pressed, dense fills     |
| `--color-live-border` | `oklch(0.78 0.115 296 / .45)` | Live element borders     |
| `--color-live-tint`   | `oklch(0.78 0.115 296 / .10)` | Faint live wash          |
| `--color-on-live`     | `#0a0a0a`                     | Text on a live fill      |

**Error** — the only other hue, blocked/failed states ONLY:

| Token                       | Value                    |
| --------------------------- | ------------------------ |
| `--color-error`             | `#ffb4ab`                |
| `--color-error-deep`        | `#93000a`                |
| `--color-error-soft`        | `rgb(255 180 171 / .08)` |
| `--color-error-soft-hover`  | `rgb(255 180 171 / .14)` |
| `--color-error-soft-border` | `rgb(255 180 171 / .4)`  |

**Success and warning are grayscale** — status is conveyed by text label + icon, never a hue. These tokens resolve to grays so existing soft/border consumers stay legible:

| Token                         | Value     |
| ----------------------------- | --------- |
| `--color-success`             | `#a3a3a3` |
| `--color-success-soft`        | `#141414` |
| `--color-success-soft-hover`  | `#1c1c1c` |
| `--color-success-soft-border` | `#333333` |
| `--color-warning`             | `#d6d6d6` |
| `--color-warning-soft`        | `#141414` |
| `--color-warning-soft-hover`  | `#1c1c1c` |
| `--color-warning-soft-border` | `#4d4d4d` |

Rules:

- Use surfaces as a ladder: `surface-0` page, `surface-1` cards, `surface-2` nested/hover, `surface-3` popovers/modals.
- Use `accent` as ink: primary text and the primary (white) button share the neutral accent family.
- Success/warning/queued render as a grayscale chip + Lucide check/alert icon — pair the gray token with the icon so the state is legible without a hue.
- If an overlay is needed, use a tokenized expression such as `bg-[color-mix(in_srgb,var(--color-text-primary)_40%,transparent)]` in one shared primitive or CSS utility. Do not scatter `bg-black/40`. The dialog scrim is `rgb(0 0 0 / 0.7)`, no blur.

## Accent discipline

There are exactly two hues, and each is reserved.

**Arcane violet (`--color-live`) — liveness and focus only.** Allowed uses:

- The heartbeat and other live/running/active states (`.review-loop-breathe`, `.review-loop-sonar`).
- Active selection bars (2px, e.g. `.filter-chip-underline`, `.session-stack-surface-left-accent`).
- Link hovers and the keyboard-focus accent.
- The "spark" in the Cycloid mark.

Never a background wash, never decorative, never a gradient. If a screen has more than a few violet touches, it is overused.

**Error (`--color-error`, `#ffb4ab`) — blocked/failed states only.** Never a generic "primary action" color, never metadata decoration.

**Everything else is grayscale.** The primary button is white ink (`--color-accent`); emphasis comes from ink weight, case, scale, and spacing, not hue. Success, warning, and queued are grayscale chip + icon.

Allowed emphasis (white ink):

- Primary task action on dashboard/home (the white button).
- Selected workspace artifact tab.

Focus flips the border and adds a violet-adjacent white outline (see the Focus and interaction section).

Avoid:

- Using violet for anything that is not liveness or focus.
- Making every primary button full white ink; reserve it for the one clearest action per surface.
- Any hue for success/warning/queued — grayscale + icon only.
- Large tinted background fills, gradients, or blur anywhere.

Do not add new chromatic token families or scatter one-off teal/blue/green classes.

## Typography

One UI family. Geist carries **all** interface text — reading text, labels, chips, eyebrows, IDs, timestamps, and data readouts. JetBrains Mono is reserved for **actual code and copyable technical strings**, where character alignment and copy-fidelity are functional, not decorative.

- `--font-display`: `"Geist Variable", "Geist", "Helvetica Neue", Arial, sans-serif`
- `--font-sans`: `"Geist Variable", "Geist", "Helvetica Neue", Arial, sans-serif`
- `--font-mono`: `"JetBrains Mono Variable", "JetBrains Mono", "SFMono-Regular", Menlo, Monaco, monospace`

**Mono means "this is code you could copy."** Use `--font-mono` only for: code and diffs, log lines, shell/CLI snippets, branch names, git SHAs, file paths, domains/URLs-as-values, cron expressions, API tokens/keys, env-var names, and inline-code literals embedded in prose (`trycycloid/cycloid`, `Key=Value`). Everything else — including the chip family, section eyebrows, column headers, status words, counts, timestamps, and `.numeral` IDs — is Geist.

- **There is no uppercase instrument register.** Chips (`StatusChip`/`Badge`/`ArtifactChip`), eyebrows, and `h6` are Geist, sentence case, no wide tracking. The border/box + icon carries the "instrument" read, not a font switch.
- **Digit columns stay aligned without a font switch.** `.font-mono-tabular` and `.numeral` are Geist with tabular figures (`tnum`) so counts/timestamps/IDs still line up in columns.
- **Sentence case everywhere.** With the mono-label register retired, there is no uppercased UI text — all labels and prose are sentence case. Never hard-code an uppercase string or `.toUpperCase()` a label.

`App.css` overrides Tailwind v4's default text sizes. The Cycloid scale wins. Reading text floors at 14px; small labels floor at 12px:

| Token         |   Size | Line height | Use                                |
| ------------- | -----: | ----------: | ---------------------------------- |
| `--text-2xs`  | `11px` |       `1.2` | Micro readouts (dense floor)       |
| `--text-xs`   | `12px` |       `1.3` | Small labels, badges, timestamps   |
| `--text-sm`   | `13px` |       `1.5` | Data readouts / caption            |
| `--text-base` | `14px` |      `1.55` | Small reading text (reading floor) |
| `--text-md`   | `14px` |      `1.55` | Secondary body                     |
| `--text-lg`   | `16px` |       `1.6` | Body / primary reading (`p`/`li`)  |
| `--text-xl`   | `20px` |       `1.4` | Headline M — section titles (`h2`) |
| `--text-2xl`  | `24px` |       `1.3` | Large section heads                |
| `--text-3xl`  | `32px` |       `1.2` | Headline L — page titles (`h1`)    |
| `--text-4xl`  | `40px` |       `1.1` | Hero heading (opt-in)              |

Element defaults:

- Headlines are tight (`-0.02em`) and medium-heavy (500–600). `h1` `32px`, `h2` `20px`/500, `h3` `16px`.
- `p` and `li` are `16px` with `1.6` line height.
- `h6` is the small metadata label: Geist, 12px, sentence case, `-0.01em`, weight 600, secondary text.
- `small` and `.caption` are `13px` and `text-muted`.
- Markdown headings are scoped by `.markdown-content` so generated markdown keeps normal Geist prose rhythm.

Utilities:

- `.eyebrow`: Geist, 12px, weight 500, sentence case, muted text — the small metadata-label pattern (section kicker, column header).
- `.eyebrow-accent`: same, in `--color-live` — reserved for running/active readouts.
- `.font-display`: Geist, weight 600, `-0.02em`.
- `.font-display-tight`: Geist, weight 600, `-0.03em`, `line-height: 1.05`.
- `.font-display-italic`: Geist italic.
- `.font-mono-tabular` / `.numeral`: Geist with tabular figures for aligned digit columns (counts, IDs, timestamps) — same family as surrounding text, digits still align.

Avoid new arbitrary `text-[Npx]` values. If a needed size is missing, update the shared scale deliberately instead of adding a one-off.

## Eyebrow usage

Eyebrows are for metadata, not primary navigation or major page structure.

Use eyebrows sparingly for:

- Dense metadata groups.
- Secondary inspector labels.
- Small technical context labels.

Do not use eyebrows for:

- Main queue headings.
- Primary section titles.
- Empty-state titles.
- Navigation labels.
- User-facing report headings.

Prefer sentence-case headings for primary structure:

- "Needs attention"
- "Recently completed"
- "Pull requests"
- "Files changed"
- "Risks and follow-ups"

## Copy

Voice is calm professional: plain, precise, unhurried. Cycloid states what it did and shows the proof. It never hypes, never apologizes theatrically, never uses filler.

- **Sentence case everywhere** — buttons, labels, headings, nav, chips, eyebrows ("Review queue", not "Review Queue"). No exceptions: with the mono-label register retired, there is no uppercased UI text.
- **"You" for the user, "Cycloid" for the agent** — never "I", never "the AI". "Cycloid opened a PR." / "You'll be asked to approve destructive actions."
- **Verbs of proof** — lead with evidence, not enthusiasm: "Merged with 214 tests passing", not "Successfully completed!".
- **No emoji. No exclamation marks.** Punchiness is brevity, not punctuation.
- **Numbers are concrete** — "3 tasks awaiting review", "1h 42m", "214 tests". Never "several", never vague.
- **Buttons are verbs, 1–2 words** — "Send task", "Approve", "View evidence", "Retry".
- **Empty states are one calm sentence + one action** — "No tasks awaiting review." / "Nothing running. Send Cycloid a task."

Mechanics:

- This applies to buttons, labels, headings, menu items, toasts, empty states, dialog titles, tooltips, `aria-label` attributes, `title` attributes, and placeholder text.
- Proper nouns and product names stay capitalized, including Cycloid, Slack, GitHub, Jira, and Linear.
- Acronyms and initialisms stay capitalized, including PR, MCP, SSO, API, and URL.
- The first word after a colon stays lowercase unless it is a proper noun.
- Use the `…` character for ellipses in product copy, not three dots (`...`). Unicode glyphs (`→`, `·`) are permitted inside data readouts.
- Hard-coded inline strings are the source of truth because the UI has no i18n layer, so enforce this rule at the call site.

| Right                  | Wrong                  |
| ---------------------- | ---------------------- |
| `Connect a repository` | `Connect A Repository` |
| `Session behavior`     | `Session Behavior`     |
| `View PR`              | `View Pr`              |
| `View draft`           | `View Draft`           |
| `Test tools`           | `Test Tools`           |

## Radius, elevation, and surfaces

**Corners are 0px, everywhere.** All radius tokens resolve to `0px` — `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl` are held as names so `rounded-*` utilities keep compiling, but every one is a hard 90° edge. Native controls default to `--radius-md` (0) through the base selector. Do not reintroduce rounded corners; the sharp edge is the brand signature. The only round shapes are the heartbeat/status dots (small circles).

**Elevation is tonal, not shadowed.** Depth is a lighter surface + a 1px border. The shadow tokens now render a hairline ring instead of a soft drop:

- `--shadow-card`: `0 0 0 1px var(--color-border)` — a resting hairline ring. Exposed as `shadow-card`. `Card` is flat by default; structure comes from its border plus the `surface-1` step over `surface-0`.
- `--shadow-elevated`: `0 0 0 1px var(--color-border-strong)` — a slightly stronger ring for surfaces that lift (raised composer).

The only permitted glows (defined as tokens, applied by live/primary elements):

- `--glow-white`: `0 0 8px rgb(255 255 255 / 0.25)` — faint bloom on primary-button hover.
- `--glow-live`: `0 0 10px oklch(0.78 0.115 296 / 0.35)` — faint bloom on live elements (heartbeat).
- `--glow-error`: `0 0 8px rgb(255 180 171 / 0.3)` — blocked/failed emphasis.

Session stack utilities (all sharp, flat, bordered):

- `.session-stack-surface`: canonical transcript/action/composer card — 1px `--color-border`, `surface-1` background, 0 radius.
- `.session-stack-surface-raised`: composer variant — full `surface-1` plus the elevated hairline ring.
- `.session-stack-surface-accent` / `-accent-muted`: neutral soft (`surface-2`/`surface-1`) background and border.
- `.session-stack-surface-warning-muted`: `surface-2` background, warning-gray border.
- `.session-stack-surface-left-accent`: **2px `--color-live` left bar** — the active/selection indicator.
- `.session-stack-dense`: `min-height: 56px`, `padding: 14px 16px`.

Surface and layout utilities:

- `.rule`: hairline divider (`1px` top border in `--color-border`, no margins). Use instead of ad hoc `border-t` dividers.
- `.row-hover-lift`: interactive-row hover — steps background up to `surface-2` (200ms ease-out, no transform, no shadow). Use on `href`/`onClick` rows instead of a bare `hover:bg-surface-2`.
- `.dot-grid`: optional 32px dot-grid backdrop (`--color-border` dots at low opacity) for large canvases. Flat, no gradient.
- `.img-outline`: 1px inset outline for images (`--color-border-strong`, `outline-offset: -1px`). Single source of truth for image framing.
- `.contain-strict`: applies `contain: layout style paint` to isolate sidebar/list changes from the main content area.

Do not add arbitrary shadow values in component class strings. Add or reuse a named utility when a surface needs a different elevation.

## Layout constants

The shell snaps to a 4px baseline grid. Fixed chrome dimensions:

- **Top bar: 56px.**
- **Side nav: 232–256px.**
- **Status footer: 32px** (data readout strip).
- **Content max: 1040px** (`.control-room-content` caps at `65rem`). Container max: 1440px.
- Gutters 16px; desktop page margin 32px, mobile 16px.

Elements feel "snapped" to the grid. Do not introduce off-grid chrome widths.

## App shell composition

The authenticated app uses an open-canvas layout:

```text
sidebar | canvas
```

Do not wrap the entire main canvas in a large bordered panel. Use `surface-0` as the page/canvas background and reserve bordered or elevated surfaces for interactive objects: composers, cards, inspectors, dialogs, popovers, and actionable rows.

Sidebar:

- Sidebar is a persistent navigation surface.
- Keep the sidebar visually quieter than the active workspace.
- Primary actions such as "New task" may be prominent on dashboard/home, but should be quieter inside an active session.
- Avoid excessive section grouping. Use section labels only when they reduce cognitive load.

Canvas:

- The canvas should breathe.
- Separate regions with spacing first, surface changes second, and borders last.
- Prefer one active workspace object over many similarly weighted panels.

## Dashboard composition

The dashboard is an agent command center, not a reporting page.

Required hierarchy:

1. Hero composer.
2. Suggested actions / shortcuts.
3. Work queues.

Composer:

- The dashboard composer is the dominant surface on the page.
- Use an elevated or raised session/composer surface.
- Repo/model/thinking controls live in the composer toolbar, not as separate page chrome.
- The submit action should be the clearest action on the screen.

Work queues:

- Use simple headings in sentence case: "Needs attention", "Running", "Recently completed".
- Avoid letter-spaced all-caps queue headings unless using the documented eyebrow utility for true metadata.
- Counts should be small status pills.
- Rows should expose useful status text, not just dots.
- Prefer actionable row/card language over table-like dashboard chrome.

Avoid:

- Giant bordered dashboard frames.
- Multiple horizontal dividers when spacing or grouped rows are enough.
- Equal visual weight between composer and queues.

## Session composition

Session pages use this default hierarchy:

```text
sidebar | main thread | inspector
```

The thread is the primary surface. The inspector is secondary. Session metadata should not become its own permanent column unless the page is specifically a metadata/debug view.

Header:

- Compress title, status, repo, branch, model, and ownership into a compact session header.
- Use the header for orientation, not detailed progress.
- Example: `Verify readme emoji with Cycloid · Completed · trycycloid/cycloid · main · gpt-5.4-nano`

Thread:

- The thread column should be the widest and most visually dominant region.
- User prompts may use a stronger card treatment.
- Agent updates may use lighter transcript surfaces.
- Work/tool steps may render as compact log rows.
- Results, PRs, verification outcomes, and risks may use stronger cards or status surfaces.

Inspector:

- The right inspector contains secondary artifacts: Summary, PR, Checks, Files, Logs, Report.
- Keep inspector sections scannable and sentence case.
- Avoid dense all-caps report layouts for normal users.
- Warning/error content should use semantic status treatments, not raw colored text.

Progress:

- Do not dedicate a permanent full-height column to progress by default.
- Show current state in the header or status strip.
- Put detailed step timelines in the inspector or behind an expandable details surface.

Avoid this default layout:

```text
sidebar | metadata/progress | thread | report
```

Prefer:

```text
sidebar | thread | inspector
```

## Agent status strip

Every active session may expose one persistent agent status strip near the composer or session footer.

Purpose:

- Make the agent feel alive.
- Show the current execution state in one place.
- Avoid scattering state across pills, timelines, logs, and reports.

Examples:

- `Cycloid is planning · VM active`
- `Cycloid is verifying · 3 checks running`
- `Cycloid is done · Verification complete · PR ready`
- `Cycloid is idle · VM archived`

Rules:

- Use sentence case.
- Keep it one line when possible.
- Use semantic status tokens for completed, warning, and error states.
- Do not use the status strip as a dumping ground for detailed logs.

## Session artifacts

Agent sessions produce artifacts. Represent them as workspace tabs or inspector tabs when possible.

Preferred labels:

- Thread
- Plan
- Run
- PR
- Checks
- Files
- Logs
- Report

Rules:

- Artifact tabs should be compact and sentence case.
- Put generated outputs behind artifact tabs instead of permanently showing every panel.
- Prefer product nouns over implementation nouns.
- Use "PR" consistently for pull requests.

## Transcript density

Not every transcript item should be a full card.

Use different visual weight by event type:

- User prompt: strong transcript card.
- Agent response/update: normal transcript surface.
- Tool/work step: compact inline log row.
- Verification result: status card.
- PR/result: prominent actionable card.
- Risk/error: semantic warning/error card.

Avoid long sessions where every event has the same rounded-card treatment. Equal treatment makes the thread harder to scan.

## Controls

The control-height ladder in `App.css` is the source of truth — the kit ladder is 28/36/44:

- `.control-sm`: `min-height: 28px`, vertical padding `0.25rem`
- `.control-md`: `min-height: 36px`, vertical padding `0.375rem`
- `.control-lg`: `min-height: 44px`, vertical padding `0.5rem`
- `.control-textarea`: `min-height: 44px`, padding `0.5rem 0.75rem`, `line-height: 1.6`

Single-line buttons, inputs, and selects use `.control-sm`, `.control-md`, or `.control-lg`. Textareas use `.control-textarea`.

Button variants (from the kit): primary is white ink (`--color-accent` bg, `--color-text-inverse` text, faint `--glow-white` on hover); secondary is a bordered outline (`--color-border-strong`, border flips to white on hover); ghost is transparent (text brightens, background steps to `surface-2`); danger is bordered `--color-error`. The violet accent button exists but is reserved for live actions — use it sparingly.

Forbidden going forward:

- `min-h-[28px]`, `min-h-[36px]`, `min-h-[44px]`, or other arbitrary control heights in React class strings.
- Mixing `py-*` height hacks with arbitrary `min-h-*` to approximate controls.
- One-off disabled styles that diverge from `--disabled-opacity: 0.4`, `disabled:opacity-40`, and `disabled:cursor-not-allowed`.

## Conventions

Sanctioned idioms — do not hand-roll parallels:

- **Rows navigate whole-row** via the `Row` primitive (`href`/`onClick`). Secondary actions live in the trailing slot and stop propagation.
- **More than 2 row actions** fold behind the `Menu` overflow primitive (ellipsis trigger).
- **One confirm idiom** for destructive/unrecoverable actions: `useConfirm` + `Button variant="danger"`.
- **`IconButton`** is the only icon-only button (28/36px ghost square; `.hit-area-40` pads the pointer target to ≥40x40 via an invisible `::after`).
- **`CopyButton`** is the only copy affordance (wraps `useCopyToClipboard`, built-in copy→check swap).
- **Chips/pills** come from the shared chip family: `Badge`, `StatusChip`, `ArtifactChip`, or `chipClasses(tone)` — never a bespoke pill.
- **Dynamic numerals** use `.numeral`/`.font-mono-tabular` so digit columns stay aligned.

## Focus and interaction

`App.css` defines one global focus rule — the kit spec: a 1px white outline offset 2px, and the border flips to white:

```css
*:focus-visible {
  outline: 1px solid var(--color-border-focus); /* white */
  outline-offset: 2px;
  border-color: var(--color-border-focus);
}
```

That white outline is the standard. Do not add per-component `ring-accent/40`, `ring-*`, or box-shadow ring replacements. Component-level focus rules may change border color to white, but they must preserve the global focus-visible outline.

Buttons and button-like roles get:

- `cursor: pointer` when enabled.
- `cursor: not-allowed` when disabled.
- `touch-action: manipulation`.
- **No shrink on press.** Presses flatten (darken), not transform. `.btn-press` darkens via `filter: brightness(0.9)` — there is no translateY. Apply it to higher-emphasis controls; routine nav links stay unstyled.

Never remove outlines without an equal or better visible focus treatment.

## Motion

Motion is crisp and minimal: 120–200ms ease-out fades and single-axis slides. No bounces, springs, or parallax. Only two ambient animations are sanctioned — the heartbeat pulse and the indeterminate progress sweep.

Motion tokens:

- `--ease-out` / `--ease-editorial` / `--ease-marketing`: all `cubic-bezier(0.2, 0, 0, 1)` (names held for existing consumers).
- `--duration-fast`: `120ms`. `--duration-med`: `200ms`.

Named animations and utilities:

- `.editorial-rise`: `--duration-med` fade + 6px rise; delays `.editorial-rise-1`…`-5` at 20ms increments (rise-4/5 share 80ms to cap at 200ms).
- `.editorial-slide-in`: `--duration-med` single-axis slide from left.
- `.editorial-fade`: `--duration-med` fade.
- `.menu-pop`: `--duration-fast` fade + 4px drop for anchored popover/dropdown panels; exits stay instant.
- `.group-reveal`: `--duration-fast` fade + 4px rise for expandable group bodies (RowGroup); collapse stays instant.
- `.sidebar-collapse`: the one sanctioned width transition (`--duration-med`) — sidebar rail collapse/expand, where the canvas must reflow; suppressed via `body[data-sidebar-resizing]` during drag-resize.
- `.status-dot`: `--duration-med` `background-color` transition only. `.status-dot-pulse`: 2s opacity pulse.
- `.status-pill`: `--duration-med` `color`/`background-color`/`border-color` transitions.
- `.review-loop-breathe`: the **heartbeat** — the sanctioned liveness pulse. Opacity dips and a faint accent glow blooms at mid-cycle (`arc-heartbeat`). Reserved for live (violet) elements.
- `.review-loop-sonar` / `.review-loop-settle`: live sonar ping and one-time done-state settle.
- `.progress-sweep`: the **indeterminate progress sweep** (`arc-sweep`) — apply to a child of a clipped 4px track.
- `.filter-chip-underline`: left-anchored 2px violet bar that reveals via a `--duration-med` `transform: scaleX`; `.filter-chip-underline-active` is the revealed state.

The global reduced-motion media query clamps animations and transitions to 1ms. Heartbeat, sonar, and sweep define explicit reduced-motion resting states.

### Motion playbook

Every authenticated surface applies the same patterns. New UI copies these; it does not invent motion:

1. **Page entrance — three beats, ≤200ms total.** Heading/PageHeader `.editorial-rise .editorial-rise-1`, toolbar/filter band `-2`, content region `-3`. Two toolbar bands share `-2`. The dashboard hero is the one five-beat exception.
2. **Skeleton → content**: one `.editorial-fade` on the loaded container. Never per row — long lists animate at the container.
3. **Conditional appearance** (notices, banners, post-action errors/status): `.editorial-fade` on mount.
4. **Anchored panels** (menus, dropdowns, popovers): `.menu-pop`. Exits stay instant.
5. **Expandables** (group bodies): `.group-reveal` on open; collapse stays instant.
6. **Dialogs**: scrim `.editorial-fade` + panel `.editorial-rise` — the `Modal` primitive owns both; call sites add nothing.
7. **Liveness**: live/running indicators are a `--color-live` dot with `.review-loop-breathe`; indeterminate progress is `.progress-sweep` in a clipped 4px track (no track, no sweep).
8. **Completion**: an element that stays mounted across a live→done transition plays `.review-loop-settle` once, keyed to the observed transition (never on mount of an already-done state).
9. **Interaction**: presses darken (`.btn-press`, from the kit), interactive rows lift (`.row-hover-lift`). No transform on press, no hover scale.

Placement rules: animation classes go on elements that mount once — navigation, open, or appearance — never on streaming/re-render paths (a class on a re-rendering element strobes). Exits are instant unless listed above. The logged-out shell gets none of this.

## Layers and z-index

Use named layers instead of undocumented `z-[N]` values:

- Page/background effects: `0`
- App root and normal content: `2`
- Sticky local headers: `10`
- Dropdowns, menus, popovers, and fixed-position controls: `30`
- Modal overlays: `50`
- Toasts and global notifications: `60`

If a new layer is required, update this ladder and introduce a named utility or primitive-level constant. Do not add isolated arbitrary z-index values.

## What to avoid

Forbidden patterns for new or touched authenticated UI:

- Raw hex values in React `className` strings or inline styles when a token exists.
- Any hue outside the two sanctioned families: violet for liveness/focus, `#ffb4ab` error for blocked/failed. Success/warning/queued are grayscale + icon.
- Rounded corners — `rounded-[Npx]`, `rounded-full` (except the small status/heartbeat dots), or reintroducing radius. Corners are 0.
- Drop shadows, gradients, or blur (except the `rgb(0 0 0 / 0.7)` dialog scrim). Elevation is a lighter surface + 1px border; only glows are permitted.
- `bg-black/40` overlays; use a shared tokenized overlay treatment.
- Arbitrary control heights such as `min-h-[28px]`, `min-h-[36px]`, or `min-h-[44px]`.
- Per-component focus rings using `ring-accent/*` or box-shadow rings; the focus rule is a white outline + white border flip.
- Arbitrary shadows such as `shadow-[...]` in component class strings.
- Arbitrary tracking values. (The old `0.08em` mono-label tracking is retired — no wide-tracked labels.)
- Transform/shrink press feedback; presses darken, they do not move.
- Undocumented `z-[N]` values.
- Title Case in product copy; use sentence case (there is no uppercase register — not even for labels or chips). See `## Copy`.
- New badges or pills unless the shared badge/pill primitive owns the shape — and it is square, not rounded.
- Adding product or marketing content to the logged-out shell.

When existing code violates this contract, fix it only within the requested scope. Do not turn a narrow visual task into a broad cleanup.
