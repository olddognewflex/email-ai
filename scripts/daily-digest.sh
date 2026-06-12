#!/usr/bin/env bash
#
# daily-digest.sh — run the email-ai pipeline and feed results into qi.
#
# Usage: daily-digest.sh [stage]
#   sync    sync IMAP accounts, parse, normalize, classify
#   digest  write digest markdown into the qi vault and qi-capture
#           actionable emails (yesterday's final + today-so-far)
#   all     both (default)
#
# Scheduled via launchd: the hourly job runs "sync" so classification
# keeps up with incoming mail; the 07:30 job runs "digest". Safe to
# re-run: pipeline endpoints only process new records, digest output is
# idempotent per date, and captures are deduped via a state file.
#
# Override any of the defaults below via environment variables.

set -euo pipefail

# launchd starts with a minimal PATH; include mise shims (node), qi,
# homebrew (jq), and docker.
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

STAGE="${1:-all}"
case "$STAGE" in
  sync|digest|all) ;;
  *) echo "Usage: $(basename "$0") [sync|digest|all]" >&2; exit 2 ;;
esac

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

  # Classify from yesterday onward: covers mail that arrived before
  # today's default cutoff. Already-classified emails are skipped,
  # so overlap is free.
  local since
  since=$(date -v-1d '+%Y-%m-%d')
  log "Classifying normalized emails since $since"
  curl -fsS -X POST "$API_URL/classification/run?since=$since" | jq -c '.' \
    | while read -r line; do log "  classify: $line"; done
}

write_digest() {
  local day="$1"
  log "Writing digest for $day to $VAULT_DIGEST_DIR"
  curl -fsS -X POST "$API_URL/digest/generate" \
    -H 'Content-Type: application/json' \
    -d "{\"outputPath\": \"$VAULT_DIGEST_DIR\", \"date\": \"$day\"}" \
    | jq -c '.data.digest.summary' | while read -r line; do log "  digest: $line"; done
}

capture_actionables() {
  local day="$1"
  local digest captured=0 skipped=0
  digest=$(curl -fsS "$API_URL/digest?date=$day")

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

  log "Captured $captured actionable emails for $day ($skipped already captured)"
}

run_digest_stage() {
  # Yesterday's digest is final (all of its mail is classified by now);
  # today's covers overnight mail and will be regenerated tomorrow.
  local yesterday today
  yesterday=$(date -v-1d '+%Y-%m-%d')
  today=$(date '+%Y-%m-%d')
  for day in "$yesterday" "$today"; do
    write_digest "$day"
    capture_actionables "$day"
  done
}

log "=== email-ai run: stage=$STAGE ==="
ensure_stack
case "$STAGE" in
  sync)   run_pipeline ;;
  digest) run_digest_stage ;;
  all)    run_pipeline; run_digest_stage ;;
esac
log "=== done ==="
