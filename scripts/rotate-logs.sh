#!/usr/bin/env bash
#
# rotate-logs.sh — size-based copy-truncate rotation for the launchd logs.
#
# Usage: rotate-logs.sh
#   env LOG_DIR    directory to scan (default ~/.local/state/email-ai)
#   env MAX_BYTES  rotate a log once it exceeds this size (default 50 MB)
#   env KEEP       compressed generations to keep (default 5)
#
# launchd opens each job's StandardOutPath once, in append mode, and the
# process keeps that descriptor. Renaming the file (what newsyslog does)
# would leave the API writing into the renamed file. So instead: copy the
# log aside, truncate the live file in place, then compress the copy.
# Appending writers continue at the new end of file with no restart.
#
# Lines written between the copy and the truncate are lost; the window
# is milliseconds and the job runs at 03:15, away from the hourly sync.
#
# Scheduled via launchd (com.odnf.email-ai.log-rotate, daily 03:15).
set -euo pipefail

LOG_DIR="${LOG_DIR:-$HOME/.local/state/email-ai}"
MAX_BYTES="${MAX_BYTES:-52428800}"
KEEP="${KEEP:-5}"
SELF_LOG="log-rotate.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

rotate() {
  local file="$1" name
  name="$(basename "$file")"

  # Shift old generations: name.(KEEP-1).gz -> name.KEEP.gz, ... ; the
  # oldest falls off the end.
  rm -f "$file.$KEEP.gz"
  local i
  for ((i = KEEP - 1; i >= 1; i--)); do
    [ -f "$file.$i.gz" ] && mv "$file.$i.gz" "$file.$((i + 1)).gz"
  done

  cp -p "$file" "$file.1"
  : > "$file"
  gzip -f "$file.1"
  log "rotated $name -> $name.1.gz"
}

[ -d "$LOG_DIR" ] || { log "no log dir $LOG_DIR; nothing to do"; exit 0; }

shopt -s nullglob
for file in "$LOG_DIR"/*.log; do
  [ "$(basename "$file")" = "$SELF_LOG" ] && continue
  size="$(stat -f %z "$file")"
  if [ "$size" -gt "$MAX_BYTES" ]; then
    rotate "$file"
  fi
done
