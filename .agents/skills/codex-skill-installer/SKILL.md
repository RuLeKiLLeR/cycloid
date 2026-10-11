---
name: codex-skill-installer
description: Recommend and install useful Codex skills from openai/skills for this repo. Use when the user asks what Codex skills to install, mentions the openai/skills repo, or asks to use the skills installer.
user_invocable: true
argument: optional skill names or install source
---

# Codex Skill Installer

Use when a user asks which Codex skills to install or refers to the `openai/skills` repo.

## Workflow

1. Prefer Codex's installed `skill-installer` system skill if present:
   - Read `$CODEX_HOME/skills/.system/skill-installer/SKILL.md` or `~/.codex/skills/.system/skill-installer/SKILL.md`.
   - Use its helper scripts instead of reimplementing GitHub download logic.
   - Set `<SKILL_INSTALLER_DIR>` to the discovered directory containing that `SKILL.md`.
2. List curated skills from `openai/skills` before recommending:
   - `python3 <SKILL_INSTALLER_DIR>/scripts/list-skills.py --format json`
   - If `python3` is unavailable, use `python`.
3. Compare against skills already available in the current Codex session and already installed under `$CODEX_HOME/skills`.
4. Recommend a short set based on the repo's work, not every available skill.
5. Install only the selected skills with:
   - `python3 <SKILL_INSTALLER_DIR>/scripts/install-skill-from-github.py --repo openai/skills --path skills/.curated/<skill-name> ...`
6. After installing, tell the user to restart Codex to pick up new skills.

## Cycloid Defaults

Strongest default recommendations for this repository:

- `cloudflare-deploy` for Workers, Pages, and platform deploy work.
- `playwright` and `playwright-interactive` for real browser verification and iterative UI debugging.
- `screenshot` for OS-level capture when browser-specific tooling is not enough.
- `security-threat-model`, `security-best-practices`, and `security-ownership-map` for enterprise security review, threat modeling, and ownership risk analysis.
- `cli-creator` when turning internal APIs, scripts, or admin workflows into durable command-line tools.

Avoid recommending irrelevant platform skills unless the user is working in that stack. For example, `aspnet-core` and `winui-app` are not useful for normal Cycloid work. Figma skills are useful only when the task involves Figma files, design systems, or Figma-to-code work.
