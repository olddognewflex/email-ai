#!/usr/bin/env bash
#
# install-uri-handler.sh
#
# Installs a macOS URL handler for emailai://review/<id> links (as emitted in
# the Obsidian digest notes). Clicking a link opens a WezTerm window running
# the review TUI:
#
#   node <repo>/apps/tui/dist/index.js <id>
#
# It works by compiling a tiny AppleScript app (~/Applications/EmailReview.app)
# with an `on open location` handler, registering it for the `emailai` URL
# scheme, and pointing it at this repo's built TUI.
#
# Usage:
#   scripts/install-uri-handler.sh                # install / reinstall
#   scripts/install-uri-handler.sh --uninstall    # remove the handler
#   scripts/install-uri-handler.sh --print-source # print generated AppleScript
#
# Idempotent: safe to re-run; the app bundle is rebuilt from scratch each time.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Repo root. Override with REPO_DIR=... if installing for a different checkout.
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

APP_NAME="EmailReview"
APP_DIR="$HOME/Applications/$APP_NAME.app"
BUNDLE_ID="com.odnf.email-review"
URL_SCHEME="emailai"
TUI_PATH="$REPO_DIR/apps/tui/dist/index.js"
PLISTBUDDY="/usr/libexec/PlistBuddy"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

die() {
  echo "error: $*" >&2
  exit 1
}

# Emit the AppleScript source for the handler app. The TUI path is baked in as
# an AppleScript string literal; everything that crosses into a shell at
# runtime goes through `quoted form of`, and the review id itself is rejected
# unless it is purely lowercase [a-z0-9] (cuid alphabet), so a crafted URL
# cannot inject shell syntax.
generate_applescript() {
  printf 'property tuiPath : "%s"\n\n' "$TUI_PATH"
  cat <<'APPLESCRIPT'
on open location theURL
    set thePrefix to "emailai://review/"
    set prefixLen to length of thePrefix

    -- URL schemes are case-insensitive; the id check below is not.
    ignoring case
        if theURL does not start with thePrefix then
            my failWith("Unrecognised URL. Expected " & thePrefix & "<id>.")
            return
        end if
    end ignoring

    if (length of theURL) is less than or equal to prefixLen then
        my failWith("Missing review id in URL.")
        return
    end if

    set theID to text (prefixLen + 1) thru -1 of theURL

    -- Sanitize: ids are cuids, strictly lowercase [a-z0-9]. Refuse anything
    -- else (slashes, quotes, $(), spaces, uppercase, ...) so the id can never
    -- smuggle shell syntax into `do shell script`.
    if (length of theID) > 64 then
        my failWith("Review id is too long.")
        return
    end if
    set allowedChars to "abcdefghijklmnopqrstuvwxyz0123456789"
    considering case
        repeat with ch in (characters of theID)
            if allowedChars does not contain (contents of ch) then
                my failWith("Review id contains invalid characters (expected lowercase letters and digits only).")
                return
            end if
        end repeat
    end considering

    -- Locate wezterm: prefer the app bundle binary, fall back to PATH.
    set weztermPath to "/Applications/WezTerm.app/Contents/MacOS/wezterm"
    set haveWezterm to false
    try
        do shell script "test -x " & quoted form of weztermPath
        set haveWezterm to true
    end try
    if not haveWezterm then
        try
            set weztermPath to do shell script "PATH=\"$PATH:/opt/homebrew/bin:/usr/local/bin\" command -v wezterm"
            if weztermPath is not "" then set haveWezterm to true
        end try
    end if
    if not haveWezterm then
        my failWith("WezTerm not found. Install WezTerm.app in /Applications or put wezterm on your PATH.")
        return
    end if

    -- Locate node (`do shell script` runs with a minimal PATH).
    set nodeBin to ""
    try
        set nodeBin to do shell script "PATH=\"$PATH:/opt/homebrew/bin:/usr/local/bin\" command -v node"
    end try
    if nodeBin is "" then
        my failWith("node not found on PATH.")
        return
    end if

    do shell script quoted form of weztermPath & " start -- " & quoted form of nodeBin & " " & quoted form of tuiPath & " " & quoted form of theID & " > /dev/null 2>&1 &"
end open location

on failWith(msg)
    display dialog "Email Review: " & msg buttons {"OK"} default button "OK" with icon stop
end failWith
APPLESCRIPT
}

uninstall() {
  if [[ -d "$APP_DIR" ]]; then
    "$LSREGISTER" -u "$APP_DIR" || true
    rm -rf "$APP_DIR"
    echo "Uninstalled: removed $APP_DIR and unregistered the $URL_SCHEME:// handler."
  else
    echo "Nothing to uninstall: $APP_DIR not found."
  fi
}

main() {
  case "${1:-}" in
    --uninstall)
      uninstall
      exit 0
      ;;
    --print-source)
      generate_applescript
      exit 0
      ;;
    "")
      ;;
    *)
      die "unknown argument: $1 (expected --uninstall or --print-source)"
      ;;
  esac

  [[ "$(uname)" == "Darwin" ]] || die "this installer is macOS-only"
  command -v osacompile >/dev/null 2>&1 || die "osacompile not found"
  [[ -x "$PLISTBUDDY" ]] || die "PlistBuddy not found at $PLISTBUDDY"
  [[ -x "$LSREGISTER" ]] || die "lsregister not found at $LSREGISTER"

  # The TUI path is baked into an AppleScript string literal; refuse
  # characters that would break out of it.
  # shellcheck disable=SC1003 # '\' deliberately matches a literal backslash
  case "$TUI_PATH" in
    *'"'* | *'\'*) die "repo path must not contain double quotes or backslashes: $TUI_PATH" ;;
  esac

  if [[ ! -f "$TUI_PATH" ]]; then
    echo "warning: $TUI_PATH does not exist yet (build the TUI first); installing anyway." >&2
  fi

  # Not `local`: the EXIT trap fires after the function returns, when a
  # local would already be out of scope (unbound under `set -u`).
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT

  local src="$tmp_dir/$APP_NAME.applescript"
  generate_applescript > "$src"

  mkdir -p "$HOME/Applications"
  rm -rf "$APP_DIR" # rebuild from scratch so re-runs are clean
  osacompile -o "$APP_DIR" "$src"

  local plist="$APP_DIR/Contents/Info.plist"
  [[ -f "$plist" ]] || die "osacompile did not produce $plist"

  # Patch the bundle id (Set when present, Add when not).
  if ! "$PLISTBUDDY" -c "Set :CFBundleIdentifier $BUNDLE_ID" "$plist" 2>/dev/null; then
    "$PLISTBUDDY" -c "Add :CFBundleIdentifier string $BUNDLE_ID" "$plist"
  fi

  # Register the URL scheme; drop any existing entry first so re-runs don't
  # accumulate duplicates (Delete fails harmlessly when the key is absent).
  "$PLISTBUDDY" -c "Delete :CFBundleURLTypes" "$plist" 2>/dev/null || true
  "$PLISTBUDDY" -c "Add :CFBundleURLTypes array" "$plist"
  "$PLISTBUDDY" -c "Add :CFBundleURLTypes:0 dict" "$plist"
  "$PLISTBUDDY" -c "Add :CFBundleURLTypes:0:CFBundleURLName string $BUNDLE_ID" "$plist"
  "$PLISTBUDDY" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$plist"
  "$PLISTBUDDY" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string $URL_SCHEME" "$plist"

  "$LSREGISTER" -f "$APP_DIR"

  echo
  echo "Installed $APP_DIR and registered the $URL_SCHEME:// URL scheme."
  echo "TUI entry point: $TUI_PATH"
  echo
  echo "Test it with:"
  echo "  open \"$URL_SCHEME://review/<some-id>\""
  echo
  echo "To remove: $0 --uninstall"
}

main "$@"
