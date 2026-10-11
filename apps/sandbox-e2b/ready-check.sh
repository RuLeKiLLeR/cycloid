#!/usr/bin/env bash
set -euo pipefail

trap 'printf "[ready-check] failed line %s: %s\n" "${LINENO}" "${BASH_COMMAND}" >&2' ERR

(
  cd /tmp
  node --version
  npm --version
  pnpm --version
  yarn --version
  bun --version
)
python --version
uv --version
pytest --version
python -c "import pytest"
git --version
gh --version
if [ -n "${REPO_OWNER:-}" ] && [ -n "${REPO_NAME:-}" ]; then
  bash -lc 'gh api "repos/${REPO_OWNER}/${REPO_NAME}" --silent'
fi
ngrok version
rg --version
fd --version
fc-cache -V
require_font() {
  local query="$1"
  local expected_pattern="$2"
  fc-match -f "%{family}\n" "$query" | grep -Eiq "$expected_pattern"
}
require_font "Inter" "Inter"
require_font "Poppins" "Poppins"
require_font "DM Sans" "DM Sans"
require_font "Schibsted Grotesk" "Schibsted Grotesk"
require_font "Lora" "Lora"
require_font "Geist" "Geist"
require_font "Geist Mono" "Geist Mono"
require_font "Liberation Sans" "Liberation Sans"
require_font "Noto Sans" "Noto Sans"
require_font "Noto Color Emoji" "Noto Color Emoji"
require_font "Fira Code" "Fira[ ]?Code"
require_font "JetBrains Mono" "JetBrains Mono"
just --version
jq --version
sqlite3 --version
file --version
ffmpeg -version

# Desktop additions are presence checks only. Do not connect to DISPLAY, launch
# desktop/browser/VNC processes, capture screenshots, or probe live services.
command -v Xvfb
command -v dbus-daemon
command -v xfsettingsd
command -v xfwm4
command -v xfdesktop
command -v xfce4-panel
command -v xfce4-terminal
command -v thunar
command -v xfconf-query
command -v x11vnc
command -v websockify
test -r /usr/share/novnc/vnc.html
command -v xsetroot
command -v xdotool
command -v wmctrl
command -v scrot
test -d /usr/share/icons/Adwaita
test -d /usr/share/icons/hicolor

ps --version
ss --version
lsof -v
command -v nc
codex --version
opencode --version
cycloid --version
test -x /app/bridge-tools/terraform
/app/bridge-tools/terraform version
command -v agent-browser
cycloid-recorder --help
playwright --version
node -e "require('playwright')"
tsc --version
node -e "const expected=process.env.ARCANIST_TYPESCRIPT_VERSION; if (!expected) throw new Error('ARCANIST_TYPESCRIPT_VERSION is required'); const ts=require('typescript'); if (ts.version !== expected) throw new Error('unexpected TypeScript '+ts.version)"

if [ -e /etc/cycloid/layer-env.sh ] || [ -e /etc/profile.d/cycloid-layer-env.sh ]; then
  test -r /etc/cycloid/layer-env.sh
  test -r /etc/profile.d/cycloid-layer-env.sh
  layer_env_mode="$(stat -c "%a" /etc/cycloid/layer-env.sh)"
  profile_env_mode="$(stat -c "%a" /etc/profile.d/cycloid-layer-env.sh)"
  test "$((8#${layer_env_mode} & 8#022))" -eq 0
  test "$((8#${profile_env_mode} & 8#022))" -eq 0
fi

chromium --version
# agent-browser uses the Playwright-managed Chromium via this env (no own Chrome-for-Testing download).
test -x "${AGENT_BROWSER_EXECUTABLE_PATH:?AGENT_BROWSER_EXECUTABLE_PATH must be set}"
test "${PLAYWRIGHT_BROWSERS_PATH:?PLAYWRIGHT_BROWSERS_PATH must be set}" = /opt/cycloid/ms-playwright
resolved_chromium_path="$(readlink -f "${AGENT_BROWSER_EXECUTABLE_PATH}")"
case "${resolved_chromium_path}" in
  /opt/cycloid/ms-playwright/*) ;;
  *)
    echo "Chromium must resolve inside the root-owned Playwright browser directory: ${resolved_chromium_path}" >&2
    exit 1
    ;;
esac
test -x "${resolved_chromium_path}"
test "$(stat -c '%U' "${resolved_chromium_path}")" = root
chromium_mode="$(stat -c '%a' "${resolved_chromium_path}")"
test "$((8#${chromium_mode} & 8#022))" -eq 0

PLAYWRIGHT_CHROMIUM_FOUND=0
for playwright_chromium_dir in "${PLAYWRIGHT_BROWSERS_PATH}"/chromium-*; do
  if [ -d "$playwright_chromium_dir" ]; then
    PLAYWRIGHT_CHROMIUM_FOUND=1
    break
  fi
done
test "$PLAYWRIGHT_CHROMIUM_FOUND" -eq 1

test -s /app/bridge/bundle.js
test -x /app/start-bridge.sh
test -x /app/ready-check.sh
test -x /app/scripts/cycloid-desktop
test -x /app/scripts/cycloid-desktop-supervisor
test -d /workspace
test -d /workspace/repo
