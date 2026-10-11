# Settings Revamp — Design Brief

Output of `/shape` on branch `worktree-settings-ui-revamp`. Source of truth for the Settings UI rebuild. Implementation skills (`/impeccable craft`, etc.) should treat this as the brief.

## 1. Feature Summary

Settings today: nine flat tabs, inconsistent visual treatment (boxed card-rows, a 4xl-numeral editorial list in Personal Integrations, a long Business form). Revamp targets **new admins setting up a Cycloid workspace for the first time**: understand each section, see what's configured at a glance, complete setup without guessing. Returning admins get a scannable place to flip one control.

## 2. Primary User Actions

- **New admin (day 1):** "Where do I start, and what's left?" → Overview landing summarizing what's connected and incomplete.
- **New admin (in a tab):** "What does this control?" → One-sentence intent line per tab; not-configured rows show the next action inline.
- **Returning admin:** "Flip one toggle and leave." → Sidebar grouped by ownership; section eyebrows for wayfinding; dense rows.

## 3. Design Direction

Inherits the existing editorial language (warm cream / ink, Inter Tight, mono-tabular uppercase eyebrows, no chromatic accent) but **dialed down** — the most-sober page in the product.

- One typographic scale for page titles across all tabs — kill the 4xl numerals in personal Integrations.
- Rows over cards. Hairline dividers, not nested containers.
- Status visibility through case, weight, and a small ink dot — not green pills everywhere.
- Motion: gentle `editorial-rise` on first paint only. No row-level transitions.

This is **not** marketing-energy editorial — it's archival-document editorial.

## 4. Sidebar IA & Grouping

Three groups, mono-tabular uppercase eyebrow labels, flat items (no collapsibles). Personal/account items first (most-visited); admin-only groups below.

```
ACCOUNT
  Overview                     ← optional landing (see §7a)
  General
  Your integrations
  Model API keys
  Personal secrets
  CLI tokens
  Scheduled runs
  Usage

WORKSPACE                       (gated: canManageBusinessIntegrations)
  Workspace integrations
  Repository secrets

SYSTEM                          (gated: canAccessIntegrationDebug)
  Diagnostics
```

**Renames committed in this brief:**

- `Repositories` → **Repository secrets** (tab is only env vars today).
- `Business` → **Workspace integrations** (parallel naming with `Your integrations`).
- `Debug` → **Diagnostics**.
- `Integrations` → **Your integrations** (prefix disambiguates vs the workspace tab).

Group eyebrow styling: 10px Inter Tight medium, mono-tabular, `tracking-[0.22em]`, `text-muted`. Group eyebrows sit above the first item in each group with a 16px gap.

## 5. Layout Strategy

- **Sidebar**: 240px (down from 260). Items 13px medium. Active state: subtle `bg-surface-2` + 2px left-edge ink rule, not a chunky pill. Sticky from `lg` up.
- **Content column**: ~720px max width retained.
- **Page chrome per tab**: `SettingsPageHeader` stays — eyebrow + 28px title (down from 30–36px clamp) + one-sentence intent line, same scale every tab. Move `← Back to sessions` into the global top nav.
- **Section pattern**: replace boxed `SettingsSection` for most content with flat header-then-rows: section eyebrow, hairline rule, rows. Boxed treatment only where containment is needed (OAuth callback banner, Overview "Setup status" card).
- **Row density**: `py-1` + 6-gap → `py-3.5` between siblings with 1px hairline; control right-aligned in the row.

## 6. Key States

Every tab and the Overview need to handle:

- **Default (configured)** — status row + quiet "Manage"/"Edit" affordance.
- **Empty / not configured** — one-sentence why-this-matters + one primary action ("Connect", "Add token", "Set up"). No big illustrations.
- **Loading** — `text-muted` "Loading…" inline; skeletons only on Overview.
- **Error** — inline `text-error` under the control; global banner only for OAuth callbacks.
- **Permission gated** — sidebar hides the group; nothing on the page.

## 7. Per-Tab Plans

### 7a. Overview _(new, default landing)_

**Intent:** "What's set up in this workspace and what's left to configure."

**Content:**

- Workspace identity row: name, plan, member count, primary GitHub org.
- "Setup status" — 4–6 rows: GitHub installed, Linear connected (workspace), at least one default repo, billing/usage active, ≥1 member invited. Each row: state dot + label + "Manage →" or "Set up →" deep-linking to the relevant tab.
- "Your account" mini-row (email, role) — single line.

**Anti-goals:** no welcome headline, no "Getting started!" chrome, no progress bar.

**Implementation risk:** depends on what the existing bootstrap can fetch. If billing/members aren't queryable, ship Overview with fewer checks plus a "more coming" note, OR skip Overview for v1 and route to General.

### 7b. General

**Intent:** "Your account preferences, alerts, and session defaults."

**Now:** Theme + PR review auto-response with a nested bot checklist sub-form.

**Changes:**

- Split into **Preferences** (theme) and **Session behavior** (PR auto-response).
- Move the PR review bot checklist out of the inline expand into a dedicated sub-page (`/settings/general/pr-review-bots`) or a "Configure review bots" row opening a focused panel.
- Plain-language intent line per section.

### 7c. Your integrations _(personal OAuth)_

**Intent:** "Connect your GitHub, Linear, Notion, and Slack accounts so Cycloid can act on your behalf."

**Now:** Big 4xl numeral list (`01 GitHub`, `02 Linear`…), GitHub remediation banners, per-row connect/disconnect.

**Changes:**

- **Demote typography:** kill the 4xl + 01/02 numerals. Row = 24px service name (`font-display` weight, not `display-tight`), one status line, right-aligned action button.
- Keep the load-bearing GitHub remediation banner, but scope it to the GitHub row, not page-top.
- Canonical status: "Connected as @login" / "Not connected"; "Reconnect required" only when truthful.
- Order: GitHub first (always), then Linear / Notion / Slack alphabetical (or by `USER_OAUTH_INTEGRATION_IDS`).

### 7d. Model API keys

**Intent:** "Use your own API keys — for example, OpenAI — for the models Cycloid runs in your sessions."

**Now:** Per-provider form (currently just OpenAI) with validation status.

**Changes:**

- One row per provider, even with one provider — sets the pattern for adding Anthropic / others.
- Status line: validation result in plain language ("Validated 3 days ago" / "Saved but not yet validated" / "Marked invalid — replace").
- Key input hidden behind "Add key" / "Replace", not always visible.

### 7e. Personal secrets

**Intent:** "Secrets available only to your sessions. Values stay encrypted and write-only."

**Now:** New tab at `/settings/personal-secrets`. Per-user env vars injected into the owner's sandboxes; repository secrets override personal ones when keys collide.

**Content:**

- Secret list with key, masked value (or `(set)` for non-sensitive), and optional usage note.
- Add / Edit / Delete per secret. Edit replaces the value (current value is not retrievable).
- "Sensitive" toggle per secret: sensitive values show `••••••••`; non-sensitive values show `(set)`.
- Import modal: paste KEY=VALUE text or upload `.env`/`.txt` file, with inline `#` comments becoming usage notes.

### 7f. CLI tokens

**Intent:** "Install the Cycloid CLI and create tokens to authenticate it from your machine."

**Now:** Install command + create form + token list.

**Changes:**

- Keep the Install section as-is.
- Token list: flat hairline-divided table — name/scope/created/last used/revoke. Scope as a small mono-tabular pill (`READ` / `WRITE`), restrained color.
- New-token reveal stays a one-shot copy panel.

### 7g. Scheduled runs

**Intent:** "Have Cycloid run a prompt on a repo on a recurring schedule — for example, every weekday morning."

**Now:** List + create form with a raw cron-expression input.

**Changes — replace cron textbox with a structured schedule builder:**

```
SCHEDULE
  Repeats     [ Every weekday        ▾ ]
  At time     [ 09 ▾ : 00 ▾ ]  [ UTC ▾ ]
              (day-of-week selector appears when "Every Monday" / "Every Tuesday" etc.)
              (minute selector replaces clock when "Every hour" is chosen)

  Next run:   Mon, Jun 2 — 09:00 UTC
  After that: Tue, Jun 3 — 09:00 UTC

  Advanced    Use a cron expression instead →   (collapsed; reveals current cron textbox)
```

Frequency options: `Every hour` / `Every day` / `Every weekday` / `Every Monday` (Tue/Wed/…) / `Every 1st of the month` / `Custom cron`.

Structured inputs compose into a cron string and submit via the existing create-rule endpoint. "Advanced" disclosure keeps full cron access for power users without making it primary.

Rules list below: hairline rows with `name • repo`, `next run` and `last run` in mono-tabular small text on the right, single-click delete.

### 7h. Usage

**Intent:** "Current-month OpenAI spend on the keys Cycloid manages for you."

**Now:** Three boxed `SettingsSection`s with metric grids.

**Changes:**

- Tighten metric tiles: same boxed `surface-2` treatment, smaller, 4-up row.
- Add intent line: "Settled spend resets on the first of each month."
- Move "Virtual keys" list below metrics, hairline-row format matching CLI tokens.

### 7i. Workspace integrations _(workspace; formerly Business)_

**Intent:** "Choose how this workspace uses each integration: disabled, members connect their own accounts, or one shared credential for everyone."

**Now:** Long form mixing shared-sessions toggle, per-integration scope (Disabled / User-managed / Business-wide) with inline credential forms.

**Changes:**

- Split into **Workspace policies** (shared sessions, not integrations) and **Integration policies** (per-integration scope + creds).
- Surface the three-scope concept once at top as a 3-line legend ("Disabled — members cannot use this integration…" / "User-managed — each member connects their own account…" / "Business-wide — one shared credential used for everyone…"); per-row, only the dropdown, no re-tooltipping.
- Integration rows collapse unless set to `business` scope; then a credential editor unfolds beneath as a flat inset, not card-in-a-card.
- `IntegrationHealthBadge` moves to the row's right edge as a small dot + tooltip, not a pill below.

### 7j. Repository secrets _(workspace; formerly Repositories)_

**Intent:** "Environment variables Cycloid exposes to sessions running on each repository."

**Now:** Repo selector + env-var list.

**Changes:**

- Header: "Repository secrets" + intent line, making clear the tab is _only_ env vars.
- Repo selector becomes a combobox-style row at top.
- Env-var list as hairline table; "Add variable" as a row-style affordance at bottom, not a centered button.

### 7k. Diagnostics _(system; formerly Debug)_

**Intent:** "Recent events from integrations — useful when GitHub or Linear isn't behaving as expected."

**Now:** Card list of lifecycle events.

**Changes:**

- Demote cards to hairline rows — it's a log, not a feed.
- Top filter: dropdown for integration + status (failed / passed / all).
- Status uses the shared dot pattern; no soft-bg pills.

## 8. Interaction Model

- **Sidebar navigation:** keyboard-friendly (handled by `NavLink`). Active state animates via color transition only; no slide.
- **Saves:** optimistic where reversible (theme, toggles); pessimistic with explicit "Save" for typed fields (API keys, env vars, credentials). No success toast — the row's status line updates instead.
- **Confirms:** keep `confirm()` for destructive actions (GitHub re-auth, removing creds). Inline-confirm only where already implemented (Linear workspace remove flow).
- **Empty actions:** primary action button at the row's right edge; secondary "Learn more" docs link below in muted micro-copy where helpful.

## 9. Content Requirements

Group eyebrows: `ACCOUNT` / `WORKSPACE` / `SYSTEM`.

Tab intent lines (one sentence each), written for "I am a new user with no context — can I intuit what this controls?":

| Tab                    | Intent line                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Overview               | What's set up in this workspace and what's left to configure.                                                                         |
| General                | Your account preferences, alerts, and session defaults.                                                                               |
| Your integrations      | Connect your GitHub, Linear, Notion, and Slack accounts so Cycloid can act on your behalf.                                            |
| Model API keys         | Use your own API keys — for example, OpenAI — for the models Cycloid runs in your sessions.                                           |
| Personal secrets       | Secrets available only to your sessions. Values stay encrypted and write-only.                                                        |
| CLI tokens             | Install the Cycloid CLI and create tokens to authenticate it from your machine.                                                       |
| Scheduled runs         | Have Cycloid run a prompt on a repo on a recurring schedule — for example, every weekday morning.                                     |
| Usage                  | Current-month OpenAI spend on the keys Cycloid manages for you.                                                                       |
| Workspace integrations | Choose how this workspace uses each integration: disabled, members connect their own accounts, or one shared credential for everyone. |
| Repository secrets     | Environment variables Cycloid exposes to sessions running on each repository.                                                         |
| Diagnostics            | Recent events from integrations — useful when GitHub or Linear isn't behaving as expected.                                            |

Status microcopy (consistent across Your integrations and Workspace integrations):

- "Connected as @login"
- "Not connected"
- "Reconnect required"
- "Verification passed · 3 days ago"
- "Verification failed — see Diagnostics"

Cron preview format: `Next run: Mon, Jun 2 — 09:00 UTC`.

## 10. Recommended References

- `reference/spatial-design.md` — layout reshuffle is grid → flat rows + hairlines; row-density change is the load-bearing decision.
- `reference/interaction-design.md` — form patterns for API keys, env vars, schedules; progressive disclosure for the credential editor.
- `reference/typography.md` — normalizing page-header scale; pulling Your integrations back from 4xl numerals.
- `reference/ux-writing.md` — new intent line per tab; consistent status microcopy.

## 11. Open Questions

1. **Overview data availability:** which of "billing active / members invited / default repo set / GitHub installed" can the existing bootstrap surface, and which need new DAO/service work? Needs an inventory pass before building Overview. OK to ship a slimmer Overview with only currently-fetchable checks; do not block the revamp on this.
2. **PR review bot config placement (General):** sub-route under General (`/settings/general/pr-review-bots`), or under Your integrations → GitHub? Leaning sub-route; confirm during implementation.
3. **Implementation sequence:** shell + primitives + sidebar grouping first, then tabs in priority order (Overview → Your integrations → Workspace integrations → General → Scheduled runs → Repository secrets → Model API keys → CLI tokens → Usage → Diagnostics)? Confirm before kickoff.
