#!/usr/bin/env bash
set -euo pipefail

# Local cron driver for the control-plane worker.
#
# `wrangler dev` registers the worker's cron triggers but never fires them, so the
# scheduled() handler (review-loop sweep, automation tick, Linear bootstrap
# recovery, GitHub health, retention GC, etc.) only runs in prod/QA. Without a
# driver, organic RLA/verification never advances locally: a published PR enters
# review_listening and then sits forever because nothing drives the 5-minute sweep.
#
# This replays the registered crons against wrangler's scheduled-trigger endpoint:
#   - fast sweep                 every 5 minutes ("*/5 * * * *")
#   - hourly GC                  every 15 minutes locally ("17 * * * *")
# The handler branches on controller.cron, so the cron strings must match
# wrangler.toml exactly.
#
# Ticks are best-effort (|| true) so a transient miss never matters; the next tick
# retries. The ticker self-terminates after sustained API unreachability so it
# never orphans behind an exec'd (dogfood) or backgrounded (just dev-api) launcher.
#
# Usage: dev-cron-ticker.sh [api-base]   (default http://localhost:${API_PORT:-3000})

API_BASE="${1:-http://localhost:${API_PORT:-3000}}"
API_BASE="${API_BASE%/}"
SCHED="${API_BASE}/cdn-cgi/handler/scheduled"
MAX_DOWN="${DEV_CRON_TICKER_MAX_DOWN:-5}"
STARTUP_MAX="${DEV_CRON_TICKER_STARTUP_TRIES:-150}" # ~5 min at 2s/try

# Wait for the API to come up before the first tick (avoids 404 spam on cold
# start). Bounded: a launcher may start this detached before exec'ing wrangler
# (dogfood), so if the API never binds we must bail instead of orphaning here —
# the MAX_DOWN self-termination below only runs once the main loop is reached.
startup=0
until curl -fsS "${API_BASE}/api/health" >/dev/null 2>&1; do
  startup=$((startup + 1))
  if [ "${startup}" -ge "${STARTUP_MAX}" ]; then
    echo "[cron] API never came up after ${STARTUP_MAX} checks; stopping local cron ticker" >&2
    exit 0
  fi
  sleep 2
done
echo "[cron] local scheduled-trigger ticker started (fast sweep 5m, hourly GC 15m local) -> ${SCHED}"

i=0
down=0
while true; do
  if curl -fsS "${API_BASE}/api/health" >/dev/null 2>&1; then
    down=0
  else
    down=$((down + 1))
    if [ "${down}" -ge "${MAX_DOWN}" ]; then
      echo "[cron] API unreachable ${down}x; stopping local cron ticker" >&2
      exit 0
    fi
  fi

  # Fast sweep every 5th tick.
  if [ $((i % 5)) -eq 0 ]; then
    curl -fsS "${SCHED}?cron=*/5+*+*+*+*" >/dev/null 2>&1 || true
  fi
  # Hourly GC is accelerated locally so the branch gets exercised during dev.
  if [ $((i % 15)) -eq 0 ]; then
    curl -fsS "${SCHED}?cron=17+*+*+*+*" >/dev/null 2>&1 || true
  fi

  i=$((i + 1))
  sleep 60
done
