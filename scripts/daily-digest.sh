#!/usr/bin/env bash
#
# daily-digest.sh — run the email-ai pipeline and feed results into qi.
#
# Usage: daily-digest.sh [stage]
#   ingest    sync IMAP accounts, parse, normalize (no AI)
#   classify  classify normalized emails (AI; skipped while the AI
#             circuit breaker is open)
#   sync      ingest + classify + apply trash sender rules
#   digest    write digest markdown into the qi vault and qi-capture
#             actionable emails (yesterday's final + today-so-far)
#   all       sync + digest (default)
#
# The apply step moves mail matched by enabled `trash` sender rules to
# the server's Trash folder ONLY when the API reports the
# MAILBOX_WRITES_ENABLED kill switch on; otherwise it is a dry run that
# only logs what would move.
#
# Scheduled via launchd: the hourly job runs "sync" so classification
# keeps up with incoming mail; the 07:30 job runs "digest". Safe to
# re-run: pipeline endpoints only process new records, digest output is
# idempotent per date, and captures are deduped via a state file.
#
# Steps are isolated: a failing account or stage is logged and the rest
# still run (ingest keeps going while AI is down, classification still
# covers mail already normalized). The script exits 1 if any step failed.
#
# Override any of the defaults below via environment variables.

set -euo pipefail

# launchd starts with a minimal PATH; include mise shims (node), qi,
# homebrew (jq), and docker.
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

STAGE="${1:-all}"
case "$STAGE" in
  ingest|classify|sync|digest|all) ;;
  *) echo "Usage: $(basename "$0") [ingest|classify|sync|digest|all]" >&2; exit 2 ;;
esac

REPO_DIR="${EMAIL_AI_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# The always-on API runs under launchd on PORT 3100 (see
# com.odnf.email-ai.api.plist); 3000 is the dev API. Override with
# EMAIL_AI_API_URL to point a run at the dev server. The API binds
# 127.0.0.1 only.
API_URL="${EMAIL_AI_API_URL:-http://127.0.0.1:3100}"
VAULT_DIGEST_DIR="${EMAIL_AI_DIGEST_DIR:-$HOME/Documents/obsidian/Qi/20-notes/email-digests}"
STATE_DIR="${EMAIL_AI_STATE_DIR:-$HOME/.local/state/email-ai}"
CAPTURED_IDS_FILE="$STATE_DIR/captured-ids.txt"
HEALTH_TIMEOUT="${EMAIL_AI_HEALTH_TIMEOUT:-90}"

mkdir -p "$STATE_DIR" "$VAULT_DIGEST_DIR"
touch "$CAPTURED_IDS_FILE"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# Every API call goes through here. Write-capable endpoints (live apply)
# require the X-Email-AI-Client header; sending it everywhere is harmless.
api() { curl -H "X-Email-AI-Client: daily-digest" "$@"; }

FAILED=0

# Run a step without letting its failure abort the run. Commands inside
# an `if` condition are exempt from `set -e`, so each step function must
# return its own status (single pipelines do, via pipefail).
step() {
  local name="$1"; shift
  if ! "$@"; then
    log "ERROR: $name failed"
    FAILED=1
  fi
}

# POST an endpoint and log its JSON response one line at a time.
post_step() {
  local label="$1" url="$2"
  api -fsS -X POST "$url" | jq -c '.' \
    | while read -r line; do log "  $label: $line"; done
}

# Prints the AI circuit breaker status JSON ({open, nextAllowedAttempt,
# reason}); fails if the API can't be reached.
breaker_status() {
  api -fsS --max-time 5 "$API_URL/ai-providers/breaker"
}

api_healthy() {
  api -fsS --max-time 5 "$API_URL/health" 2>/dev/null \
    | jq -e '.status == "ok" and .db == "ok"' >/dev/null 2>&1
}

# The API runs as an always-on launchd service (com.odnf.email-ai.api,
# KeepAlive). This only makes sure Postgres is up — launchd restarts
# the API until it can reach the database — then waits for health.
ensure_stack() {
  if api_healthy; then
    log "API healthy"
    return
  fi

  log "API not healthy; ensuring Postgres is up"
  (cd "$REPO_DIR" && docker compose up -d)

  local waited=0
  until api_healthy; do
    waited=$((waited + 3))
    if [ "$waited" -ge "$HEALTH_TIMEOUT" ]; then
      log "ERROR: API not healthy after ${HEALTH_TIMEOUT}s — check" \
        "launchctl list com.odnf.email-ai.api and $STATE_DIR/api.log"
      exit 1
    fi
    sleep 3
  done
  log "API healthy after ~${waited}s"
}

run_ingest() {
  local accounts
  if ! accounts=$(api -fsS "$API_URL/email-accounts" | jq -r '.[].id'); then
    log "ERROR: could not list email accounts; skipping IMAP sync"
    FAILED=1
  elif [ -z "$accounts" ]; then
    log "WARNING: no email accounts registered — nothing to sync"
  fi

  for id in $accounts; do
    log "Syncing account $id"
    step "sync $id" post_step sync "$API_URL/email-sync/$id/run?dryRun=false"
  done

  # Parse/normalize whatever is already stored, even if a sync failed.
  log "Parsing raw emails"
  step parse post_step parse "$API_URL/email-parser/run"

  log "Normalizing parsed emails"
  step normalize post_step normalize "$API_URL/normalization/run"
}

run_classify() {
  local status
  # The breaker check here only saves a round trip: the classification
  # endpoint enforces the breaker itself. So if the status can't be read
  # (e.g. an API build without the route), flag it but classify anyway.
  if ! status=$(breaker_status); then
    log "WARNING: could not read AI breaker status; classifying anyway"
    FAILED=1
  # An open breaker is an expected state, not a failure: ingest already
  # ran, and the next run after the reset time picks the backlog up.
  elif jq -e '.open' >/dev/null <<<"$status"; then
    log "AI breaker open until $(jq -r '.nextAllowedAttempt // "unknown"' <<<"$status")" \
      "($(jq -r '.reason // "unknown"' <<<"$status")); skipping classification"
    return
  fi

  # Classify from yesterday onward: covers mail that arrived before
  # today's default cutoff. Already-classified emails are skipped,
  # so overlap is free.
  local since
  since=$(date -v-1d '+%Y-%m-%d')
  log "Classifying normalized emails since $since"
  step classify post_step classify "$API_URL/classification/run?since=$since"
}

# Apply enabled `trash` sender rules. Live only when the API reports the
# mailbox-write kill switch on; otherwise a dry run that logs the
# would-move totals. Never falls back from dry run to live.
run_apply() {
  local status enabled
  if ! status=$(api -fsS --max-time 5 "$API_URL/mailbox-actions/status"); then
    log "ERROR: could not read mailbox-write status; skipping apply"
    return 1
  fi
  enabled=$(jq -r '.writesEnabled == true' <<<"$status") || return 1

  local mode="true"
  if [ "$enabled" = "true" ]; then
    mode="false"
    log "Applying trash sender rules (mailbox writes ENABLED: moving to Trash)"
  else
    log "Applying trash sender rules (dry run: mailbox writes disabled)"
  fi

  # Bounded so a hung API cannot stall the hourly job.
  api -fsS --max-time 600 -X POST "$API_URL/sender-rules/apply?dryRun=$mode" \
    | jq -c '{dryRun, writesEnabled, limit, totals}' \
    | while read -r line; do
        if [ "$mode" = "true" ]; then
          log "  apply (would move): $line"
        else
          log "  apply: $line"
        fi
      done
}

write_digest() {
  local day="$1"
  log "Writing digest for $day to $VAULT_DIGEST_DIR"
  api -fsS -X POST "$API_URL/digest/generate" \
    -H 'Content-Type: application/json' \
    -d "{\"outputPath\": \"$VAULT_DIGEST_DIR\", \"date\": \"$day\"}" \
    | jq -c '.data.digest.summary' | while read -r line; do log "  digest: $line"; done
}

capture_actionables() {
  local day="$1"
  local digest rows captured=0 skipped=0
  digest=$(api -fsS "$API_URL/digest?date=$day") || return 1

  # One line per actionable email: id<TAB>capture text
  rows=$(jq -r '
    .data.actionable.emails[]
    | [.id, "Email: \(.subject // "(no subject)") — \(.fromName // .fromAddress // "unknown") [\(.recommendedAction)]"]
    | @tsv' <<<"$digest") || return 1

  while IFS=$'\t' read -r id text; do
    [ -z "$id" ] && continue
    if grep -qxF "$id" "$CAPTURED_IDS_FILE"; then
      skipped=$((skipped + 1))
      continue
    fi
    if qi capture "$text"; then
      echo "$id" >>"$CAPTURED_IDS_FILE" || return 1
      captured=$((captured + 1))
    else
      log "WARNING: qi capture failed for $id"
    fi
  done <<<"$rows"

  log "Captured $captured actionable emails for $day ($skipped already captured)"
}

run_digest_stage() {
  # Yesterday's digest is final (all of its mail is classified by now);
  # today's covers overnight mail and will be regenerated tomorrow.
  local yesterday today
  yesterday=$(date -v-1d '+%Y-%m-%d')
  today=$(date '+%Y-%m-%d')

  # The digest itself needs no AI, but it only reflects classified mail.
  local status
  if status=$(breaker_status) && jq -e '.open' >/dev/null <<<"$status"; then
    log "WARNING: AI breaker open — digest may omit unclassified mail"
  fi

  for day in "$yesterday" "$today"; do
    step "digest $day" write_digest "$day"
    step "capture $day" capture_actionables "$day"
  done
}

log "=== email-ai run: stage=$STAGE ==="
ensure_stack
case "$STAGE" in
  ingest)   run_ingest ;;
  classify) run_classify ;;
  sync)     run_ingest; run_classify; step apply run_apply ;;
  digest)   run_digest_stage ;;
  all)      run_ingest; run_classify; step apply run_apply; run_digest_stage ;;
esac

if [ "$FAILED" -ne 0 ]; then
  log "=== done with errors ==="
  exit 1
fi
log "=== done ==="
