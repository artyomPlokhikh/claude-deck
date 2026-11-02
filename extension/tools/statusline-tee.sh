#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Status line wrapper for Deck for Claude Code.
# Claude Code pipes a JSON payload (model, rate limits, session) to the status line command.
# This script saves it for the extension and passes it on to your own status line, if any.
#
# In ~/.claude/settings.json:
#   "statusLine": {"type": "command",
#     "command": "sh ~/.local/share/gnome-shell/extensions/claude-deck@artyomplokhikh.github.io/tools/statusline-tee.sh"}
# With an existing status line, append it:
#   ".../statusline-tee.sh bash ~/.claude/statusline-command.sh"
#   ".../statusline-tee.sh 'my-cmd | other-cmd'"   (one argument is run with sh -c)

input=$(cat)

dir="${XDG_CACHE_HOME:-$HOME/.cache}/claude-deck"
mkdir -p "$dir" 2>/dev/null &&
    printf '%s' "$input" > "$dir/status.json.$$" 2>/dev/null &&
    mv -f "$dir/status.json.$$" "$dir/status.json" 2>/dev/null

[ "$#" -eq 0 ] && exit 0
if [ "$#" -eq 1 ]; then
    printf '%s' "$input" | sh -c "$1"
else
    printf '%s' "$input" | "$@"
fi
