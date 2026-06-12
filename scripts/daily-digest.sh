#!/usr/bin/env bash
#
# daily-digest.sh — run the full email-ai pipeline and feed results into qi.
#
#   1. Ensure Postgres (docker compose) and the API are running
#   2. Sync all IMAP accounts, then parse -> normalize -> classify
#   3. Write the daily digest markdown into the qi vault
#   4. `qi capture` each actionable email (deduped across runs)
#
# Designed to run unattended from launchd. Safe to re-run: pipeline
# endpoints only process new records, digest output is idempotent per
# date, and captures are deduped via a state file.
#
# Override any of the defaults below via environment variables.

set -euo pipefail

# launchd starts with a minimal PATH; include mise shims (node), qi,
# homebrew (jq), and docker.
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

REPO_DIR="${EMAIL_AI_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
API_URL="${EMAIL_AI_API_URL:-http://localhost:3000}"
VAULT_DIGEST_DIR="${EMAIL_AI_DIGEST_DIR:-$HOME/Documents/obsidian/Qi/20-notes/email-digests}"
STATE_DIR="${EMAIL_AI_STATE_DIR:-$HOME/.local/state/email-ai}"
CAPTURED_IDS_FILE="$STATE_DIR/captured-ids.txt"
API_PID_FILE="$STATE_DIR/api.pid"
HEALTH_TIMEOUT="${EMAIL_AI_HEALTH_TIMEOUT:-90}"

mkdir -p "$STATE_DIR" "$VAULT_DIGEST_DIR"
touch "$CAPTURED_IDS_FILE"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

api_healthy() {
  curl -fsS --max-time 5 "$API_URL/health" 2>/dev/null \
    | jq -e '.status == "ok" and .db == "ok"' >/dev/null 2>&1
}

STARTED_API=0
cleanup() {
  if [ "$STARTED_API" = 1 ] && [ -f "$API_PID_FILE" ]; then
    log "Stopping API (started by this script)"
    kill "$(cat "$API_PID_FILE")" 2>/dev/null || true
    rm -f "$API_PID_FILE"
  fi
}
trap cleanup EXIT

ensure_stack() {
  if api_healthy; then
    log "API already healthy"
    return
  fi

  log "Starting Postgres via docker compose"
  (cd "$REPO_DIR" && docker compose up -d)

  log "Starting API"
  (cd "$REPO_DIR/apps/api" && nohup node dist/main \
    >>"$STATE_DIR/api.log" 2>&1 & echo $! >"$API_PID_FILE")
  STARTED_API=1

  local waited=0
  until api_healthy; do
    waited=$((waited + 3))
    if [ "$waited" -ge "$HEALTH_TIMEOUT" ]; then
      log "ERROR: API not healthy after ${HEALTH_TIMEOUT}s — see $STATE_DIR/api.log"
      exit 1
    fi
    sleep 3
  done
  log "API healthy after ~${waited}s"
}

run_pipeline() {
  local accounts
  accounts=$(curl -fsS "$API_URL/email-accounts" | jq -r '.[].id')
  if [ -z "$accounts" ]; then
    log "WARNING: no email accounts registered — nothing to sync"
  fi

  for id in $accounts; do
    log "Syncing account $id"
    curl -fsS -X POST "$API_URL/email-sync/$id/run?dryRun=false" \
      | jq -c '.' | while read -r line; do log "  sync: $line"; done
  done

  log "Parsing raw emails"
  curl -fsS -X POST "$API_URL/email-parser/run" | jq -c '.' \
    | while read -r line; do log "  parse: $line"; done

  log "Normalizing parsed emails"
  curl -fsS -X POST "$API_URL/normalization/run" | jq -c '.' \
    | while read -r line; do log "  normalize: $line"; done

  # Classify from yesterday onward: mail that arrived after the previous
  # run would otherwise fall before today's default cutoff and never get
  # classified. Already-classified emails are skipped, so overlap is free.
  local since
  since=$(date -v-1d '+%Y-%m-%d')
  log "Classifying normalized emails since $since"
  curl -fsS -X POST "$API_URL/classification/run?since=$since" | jq -c '.' \
    | while read -r line; do log "  classify: $line"; done
}

write_digest() {
  local today
  today=$(date '+%Y-%m-%d')
  log "Writing digest for $today to $VAULT_DIGEST_DIR"
  curl -fsS -X POST "$API_URL/digest/generate" \
    -H 'Content-Type: application/json' \
    -d "{\"outputPath\": \"$VAULT_DIGEST_DIR\", \"date\": \"$today\"}" \
    | jq -c '.' | while read -r line; do log "  digest: $line"; done
}

capture_actionables() {
  local digest captured=0 skipped=0
  digest=$(curl -fsS "$API_URL/digest")

  # One line per actionable email: id<TAB>capture text
  while IFS=$'\t' read -r id text; do
    [ -z "$id" ] && continue
    if grep -qxF "$id" "$CAPTURED_IDS_FILE"; then
      skipped=$((skipped + 1))
      continue
    fi
    if qi capture "$text"; then
      echo "$id" >>"$CAPTURED_IDS_FILE"
      captured=$((captured + 1))
    else
      log "WARNING: qi capture failed for $id"
    fi
  done < <(jq -r '
    .data.actionable.emails[]
    | [.id, "Email: \(.subject // "(no subject)") — \(.fromName // .fromAddress // "unknown") [\(.recommendedAction)]"]
    | @tsv' <<<"$digest")

  log "Captured $captured actionable emails into qi inbox ($skipped already captured)"
}

log "=== email-ai daily digest run ==="
ensure_stack
run_pipeline
write_digest
capture_actionables
log "=== done ==="
