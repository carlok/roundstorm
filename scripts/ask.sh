#!/bin/bash
# Call Roundstorm from anything that can speak HTTP.
set -euo pipefail
API=http://127.0.0.1:8787/api
ROOM="$1"; QUESTION="$2"; ROUNDS="${3:-1}"

curl -sf -X POST "$API/rooms/$ROOM/deliberations" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg q "$QUESTION" --argjson r "$ROUNDS" \
        '{mode:"deliberation",rounds:$r,style:"parallel",sealedOpening:false,question:$q}')" \
  > /dev/null

# Poll until the room goes idle, then read the result card.
while :; do
  BODY=$(curl -sf "$API/rooms/$ROOM/messages")
  [ "$(jq -r '.active // "null"' <<<"$BODY")" = "null" ] && break
  sleep 3
done
jq -r '.results[-1] | "LEVEL: \(.level)\n\n\(.conclusion)\n\nNEXT STEPS:\n" + (.nextSteps | map("- "+.) | join("\n"))' <<<"$BODY"
