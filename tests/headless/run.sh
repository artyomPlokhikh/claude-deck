#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Runs the extension in an isolated headless GNOME Shell with fake Claude Code data and
# drives it with tests/headless/probe. Needs gnome-shell and mutter-devkit (for --headless).
# Your real session, dconf and ~/.claude are not touched: HOME and all XDG dirs point to a
# temporary directory and the shell gets its own D-Bus session.
#
# Output: test results on stdout, screenshots in tests/headless/out/.
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
UUID=claude-deck@artyomplokhikh.github.io
OUT="$REPO/tests/headless/out"
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/claude-deck-test.XXXXXX")
BUSY=; IDLE=
trap 'kill $BUSY $IDLE 2>/dev/null; rm -rf "$ROOT"' EXIT

rm -rf "$OUT"
mkdir -p "$OUT" "$ROOT/home" "$ROOT/config" "$ROOT/cache" "$ROOT/data/gnome-shell/extensions"
# CD_ZIP=path/to.zip tests the packed extension instead of the source folder
if [ -n "${CD_ZIP:-}" ]; then
    # unpack like the shell does for extensions.gnome.org installs, compiling the schema
    unzip -q "$CD_ZIP" -d "$ROOT/data/gnome-shell/extensions/$UUID"
    glib-compile-schemas "$ROOT/data/gnome-shell/extensions/$UUID/schemas"
else
    ln -s "$REPO/extension" "$ROOT/data/gnome-shell/extensions/$UUID"
fi
ln -s "$REPO/tests/headless/probe" "$ROOT/data/gnome-shell/extensions/probe@claude-deck.test"

# two long-running processes stand in for live claude sessions
sleep 600 & BUSY=$!
sleep 600 & IDLE=$!
XDG_CACHE_HOME="$ROOT/cache" gjs -m "$REPO/tests/fixtures/make-fixture.js" "$ROOT/home" "$BUSY" "$IDLE"

cat > "$ROOT/session.sh" <<EOF
#!/bin/sh
# probe first: disabling an extension also restarts every extension enabled after it
gsettings set org.gnome.shell enabled-extensions "['probe@claude-deck.test', '$UUID']"
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
gsettings set org.gnome.desktop.interface color-scheme 'prefer-dark'
exec gnome-shell --headless --virtual-monitor 1600x1000 --no-x11 --wayland-display claude-deck-test
EOF
chmod +x "$ROOT/session.sh"

env HOME="$ROOT/home" XDG_CONFIG_HOME="$ROOT/config" XDG_CACHE_HOME="$ROOT/cache" \
    XDG_DATA_HOME="$ROOT/data" CLAUDE_CONFIG_DIR="$ROOT/home/.claude" \
    CD_TEST_OUT="$OUT" \
    timeout 120 dbus-run-session -- "$ROOT/session.sh" > "$OUT/shell.log" 2>&1 || true

if [ ! -f "$OUT/results.json" ]; then
    echo "No results; see $OUT/shell.log"
    grep -E "JS ERROR|claude-deck|probe" "$OUT/shell.log" | head -20
    exit 1
fi

gjs -c "
const [, b] = imports.gi.GLib.file_get_contents('$OUT/results.json');
const r = JSON.parse(new TextDecoder().decode(b));
for (const x of r) print((x.ok ? 'ok   ' : 'FAIL ') + x.name + (x.ok ? '' : '  ' + x.detail));
const failed = r.filter(x => !x.ok).length;
print('\n' + (r.length - failed) + '/' + r.length + ' passed');
imports.system.exit(failed ? 1 : 0);
"
errors=$(grep -E "JS ERROR|JS WARNING|claude-deck:" "$OUT/shell.log" | grep -iE "claude-deck|$UUID" || true)
if [ -n "$errors" ]; then
    echo "Shell log errors:"
    echo "$errors"
    exit 1
fi
