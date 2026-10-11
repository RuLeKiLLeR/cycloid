#!/usr/bin/env bash
# Map a deploy's github.actor to the Slack mention(s) to cc on a failed deploy.
#
# Usage: deploy-slack-mention.sh "$ACTOR"
# Prints a Slack message fragment like " cc <@U0AHJCUSM70>" (note the leading space),
# or nothing when there is no actor.
#
# Used by the deploy-notification workflows so a failed deploy pings the person who
# triggered it instead of always pinging the same people. Unknown actors (bots,
# automated dispatches, anyone not in the map) fall back to the on-call default so a
# failure is never silent.
set -euo pipefail

actor="${1:-}"

# Fallback when the actor is empty or unmapped: Shivam + Josiah.
fallback=" cc <@U0AHT782S65> <@U0AHJCUSM70>"

case "$actor" in
  josiah-arcanist) echo " cc <@U0AHJCUSM70>" ;;
  shiv-cycloid)   echo " cc <@U0AHT782S65>" ;;
  jag-arcanist)    echo " cc <@U0B1HH898LQ>" ;;
  vrn21-arcanist)  echo " cc <@U0B4P7UE04X>" ;;
  jeman-arcanist)  echo " cc <@U0B8V7UJLM9>" ;;
  *)               echo "$fallback" ;;
esac
