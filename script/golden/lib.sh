# Sourced by the golden scripts. Starts the fake site and checks the two pass conditions.
# Every run has its own folder, port, ad text and impression id, so runs can go in parallel.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SURFACE=$(basename "$0")
TIMEOUT=90
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sidequest-golden.XXXXXX")
# Letters only, and none that OCR confuses with a digit or another letter (O, I, B, S, Q, Z).
# The ad text is this run's proof on screen.
RUN_LETTERS=ACDEFGHJKLMNPRTUVWXY
RUN=
for n in $(jot -r 8 0 19); do RUN+=${RUN_LETTERS:n:1}; done
AD_TEXT="Golden ad $RUN"
IMPRESSION_ID=$(uuidgen)
PROMPT="I am shopping for running shoes. Answer in one short sentence."
EVIDENCE=

# This run's claude is the only process with this run's URL in its arguments.
cleanup() {
  [ -z "${URL:-}" ] || pkill -f "$URL" || true
  type extra_cleanup >/dev/null 2>&1 && extra_cleanup
  [ -z "${SITE_PID:-}" ] || kill "$SITE_PID" 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  echo "FAIL $SURFACE: $1"
  echo "  evidence: ${EVIDENCE:-none}"
  [ ! -f "$WORK/site.log" ] || echo "  site log: $WORK/site.log"
  exit 1
}

start_site() {
  GOLDEN_AD_TEXT=$AD_TEXT GOLDEN_IMPRESSION_ID=$IMPRESSION_ID bun "$ROOT/script/golden/site.ts" >"$WORK/site.log" 2>&1 &
  SITE_PID=$!
  until grep -q '^PORT ' "$WORK/site.log" 2>/dev/null; do
    kill -0 "$SITE_PID" 2>/dev/null || fail "fake site did not start"
    sleep 0.2
  done
  URL=http://127.0.0.1:$(sed -n 's/^PORT //p' "$WORK/site.log")
}

# claude from this repo's plugin folder, pointed at the fake site, asking $1 at startup.
# A prompt given at startup counts as typed, so no test needs the keyboard.
write_launcher() {
  cat >"$WORK/claude.sh" <<LAUNCH
#!/bin/bash
cd "$ROOT"
# Run as a person would: drop the markers of the Claude session that started this script.
unset \$(env | grep -o '^CLAUDE[A-Z_]*')
exec "$(command -v claude)" --plugin-dir "$ROOT/plugin" --settings '{"env":{"SIDEQUEST_URL":"$URL"}}' "$1"
LAUNCH
  chmod +x "$WORK/claude.sh"
}

site_saw() { grep -qF "$1" "$WORK/site.log" 2>/dev/null; }
yes_no() { "$@" && echo yes || echo no; }

# Waits for both proofs: this run's ad text on screen (the check passed in) and its impression.
# Without a saved device key the plugin asks for no ad, so check for the key before waiting.
finish() {
  local deadline=$((SECONDS + TIMEOUT)) drawn received identity=inline fix=script/golden/connect
  [ "$SURFACE" != desktop ] || { identity=sidequest; fix="/sidequest-connect in a Claude Desktop session"; }
  jq -e .deviceKey "$HOME"/.claude/plugins/store/sidequest_"$identity"-*.json >/dev/null 2>&1 ||
    fail "the plugin has no saved device key. Run $fix."
  while true; do
    received=$(yes_no site_saw "POST /api/impression/$IMPRESSION_ID")
    # The plugin sends the impression as it draws the ad, so read the screen only after it.
    # Not in a subshell: the check sets EVIDENCE.
    drawn=no
    [ "$received" = no ] || ! "$@" || drawn=yes
    [ "$drawn$received" = yesyes ] && break
    ((SECONDS < deadline)) ||
      fail "ad requested: $(yes_no site_saw "POST /api/ad"), on screen: $drawn, impression received: $received"
    sleep 2
  done
  echo "PASS $SURFACE"
  echo "  evidence: $EVIDENCE"
}

window_ids() {
  osascript -l JavaScript -e '
    ObjC.import("CoreGraphics");
    function run(argv) {
      const list = ObjC.deepUnwrap(ObjC.castRefToObject(
        $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID)));
      // All windows, not only on-screen ones: a new window can open on another Space,
      // and screencapture still captures it. Short ones are tab and title bars.
      return list
        .filter((w) => w.kCGWindowOwnerName === argv[0] && w.kCGWindowLayer === 0)
        .filter((w) => w.kCGWindowBounds.Height > 100)
        .map((w) => w.kCGWindowNumber)
        .join(" ");
    }' "$1"
}

# window_has <app owner name> <text>: true when any window of the app shows the text.
# Any window, because only this run's ad carries this run's text.
window_has() {
  local id
  for id in $(window_ids "$1"); do
    EVIDENCE=$WORK/window-$id.png
    screencapture -o -x -l"$id" "$EVIDENCE" &&
      swift "$ROOT/script/golden/ocr.swift" "$EVIDENCE" | tr '\n' ' ' | grep -qF "$2" && return 0
  done
  return 1
}
