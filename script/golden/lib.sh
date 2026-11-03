# Sourced by the golden scripts. Starts the fake site and checks the two pass conditions.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SURFACE=$(basename "$0")
PORT=${PORT:-4517}
URL=http://127.0.0.1:$PORT
TIMEOUT=90
PROMPT="I am shopping for running shoes. Answer in one short sentence."
AD_TEXT="Golden render check ad text"
READY_TEXT="Claude Code v"
export GOLDEN_IMPRESSION_ID=0badc0de-1234-4abc-8def-0123456789ab
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sidequest-golden.XXXXXX")
export GOLDEN_LOG=$WORK/impressions.log
EVIDENCE=
HINT=
SETTINGS=$HOME/.claude/settings.json
SETTINGS_BACKUP=$WORK/settings.json.bak

cleanup() {
  type extra_cleanup >/dev/null 2>&1 && extra_cleanup
  [ ! -f "$SETTINGS_BACKUP" ] || cp "$SETTINGS_BACKUP" "$SETTINGS"
  [ -z "${SITE_PID:-}" ] || kill "$SITE_PID" 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  echo "FAIL $SURFACE: $1"
  echo "  evidence: ${EVIDENCE:-none}"
  [ ! -f "$WORK/site.log" ] || echo "  site log: $WORK/site.log"
  # The hint is about connecting, so it only helps when the plugin never asked for an ad.
  [ -z "$HINT" ] || site_saw "POST /api/ad" || echo "  hint: $HINT"
  exit 1
}

start_site() {
  PORT=$PORT bun "$ROOT/script/golden/site.ts" >"$WORK/site.log" 2>&1 &
  SITE_PID=$!
  until curl -s -o /dev/null "$URL/icon.png"; do
    kill -0 "$SITE_PID" 2>/dev/null || fail "fake site did not start (is port $PORT in use?)"
    sleep 0.2
  done
}

# Runs claude from this repo's plugin folder against the fake site.
write_launcher() {
  cat >"$WORK/claude.sh" <<LAUNCH
#!/bin/bash
cd "$ROOT"
# Run as a person would: drop the markers of the Claude session that started this script.
unset \$(env | grep -o '^CLAUDE[A-Z_]*')
exec "$(command -v claude)" --plugin-dir "$ROOT/plugin" --settings '{"env":{"SIDEQUEST_URL":"$URL"}}'
LAUNCH
  chmod +x "$WORK/claude.sh"
}

# The Desktop surface runs the plugin installed from this folder, not --plugin-dir.
require_installed_plugin() {
  local marketplace install
  local fix="claude plugin marketplace remove sidequest && claude plugin marketplace add $ROOT && claude plugin install sidequest@sidequest"
  marketplace=$(claude plugin marketplace list --json | python3 -I -c 'import json, sys
print(next((m.get("path", "") for m in json.load(sys.stdin) if m["name"] == "sidequest"), ""))')
  install=$(claude plugin list --json | python3 -I -c 'import json, sys
print(next((p["installPath"] for p in json.load(sys.stdin) if p["id"] == "sidequest@sidequest"), ""))')
  [ "$marketplace" = "$ROOT" ] && [ -n "$install" ] || fail "sidequest@sidequest is not installed from $ROOT. Run: $fix"
  diff -rq "$install/hooks" "$ROOT/plugin/hooks" >/dev/null ||
    fail "the installed plugin differs from plugin/. Run: claude plugin uninstall sidequest@sidequest && claude plugin install sidequest@sidequest"
}

# Points the user's own settings at the fake site; cleanup puts the original file back.
override_site_url() {
  cp "$SETTINGS" "$SETTINGS_BACKUP"
  echo "Backed up $SETTINGS to $SETTINGS_BACKUP; restored on exit."
  python3 -I -c 'import json, sys
path, url = sys.argv[1:]
settings = json.load(open(path))
settings.setdefault("env", {})["SIDEQUEST_URL"] = url
json.dump(settings, open(path, "w"), indent=2)' "$SETTINGS" "$URL"
}

wait_until() {
  local label=$1 deadline=$((SECONDS + TIMEOUT))
  shift
  until "$@"; do
    ((SECONDS < deadline)) || fail "timed out waiting for $label"
    sleep 2
  done
}

site_saw() { grep -qF "$1" "$WORK/site.log"; }
impression_seen() { grep -qx "$GOLDEN_IMPRESSION_ID" "$GOLDEN_LOG" 2>/dev/null; }
# Waits for both proofs: the ad text on screen (the check passed in) and the impression.
finish() {
  local deadline=$((SECONDS + TIMEOUT)) drawn received
  while true; do
    drawn=no received=no
    "$@" && drawn=yes
    impression_seen && received=yes
    [ "$drawn$received" = yesyes ] && break
    ((SECONDS < deadline)) || fail "ad on screen: $drawn, impression received: $received"
    sleep 2
  done
  echo "PASS $SURFACE"
  echo "  evidence: $EVIDENCE"
}

window_id() {
  osascript -l JavaScript -e '
    ObjC.import("CoreGraphics");
    function run(argv) {
      const list = ObjC.deepUnwrap(ObjC.castRefToObject(
        $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID)));
      // The list runs front to back, so the first match is the frontmost window.
      let id = "";
      for (const w of list) {
        if (!id && w.kCGWindowOwnerName === argv[0] && w.kCGWindowLayer === 0) {
          id = w.kCGWindowNumber;
        }
      }
      return id;
    }' "$1"
}

# window_shot <app owner name> <out.png>
window_shot() {
  local id
  id=$(window_id "$1")
  [ -n "$id" ] && screencapture -o -x -l"$id" "$2"
}

ocr_has() { swift "$ROOT/script/golden/ocr.swift" "$1" | tr '\n' ' ' | grep -iqF "$2"; }

# window_has <app owner name> <text>: screenshot the app's window, then look for the text in it.
window_has() {
  EVIDENCE=$WORK/window.png
  window_shot "$1" "$EVIDENCE" && ocr_has "$EVIDENCE" "$2"
}

# type_line <text>: brings $APP to the front, types the text and presses Return.
# /sidequest-connect opens a browser, so the app must come back to the front each time.
type_line() {
  osascript -e "tell application \"$APP\" to activate"
  sleep 1
  osascript -e 'on run argv
    tell application "System Events"
      keystroke (item 1 of argv)
      delay 0.5
      key code 36
    end tell
  end run' "$1"
}

# Sets up a GUI surface: claude in the app, connected to the fake site, then asks the prompt.
# The caller starts the app and sets $APP first.
drive_cli_in_app() {
  osascript -e "tell application \"$APP\" to activate"
  wait_until "claude to start in $APP" window_has "$APP" "$READY_TEXT"
  sleep 3
  type_line "/sidequest-connect"
  wait_until "the fake site to confirm the connection" site_saw "GET /api/device"
  sleep 3
  type_line "$PROMPT"
  finish window_has "$APP" "$AD_TEXT"
}
