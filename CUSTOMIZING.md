# Customizing Deck for Claude Code

Reference for changing the extension without touching its code. It is meant for people and for Claude Code: point Claude at this file and describe what you want.

There are three layers, in the order you should reach for them:

1. **Settings** (GSettings): position, icon, sections, terminal, shortcuts. Apply instantly.
2. **`~/.config/claude-deck/style.css`**: any visual change. Applies on save.
3. **`~/.config/claude-deck/actions.json`**: extra menu items. Applies on save.

Do not edit files inside the extension folder: updates replace them, and on Wayland code changes only load after logging out and back in.

## 1. Settings

The schema ships with the extension, so `gsettings` needs `--schemadir`:

```sh
EXT=~/.local/share/gnome-shell/extensions/claude-deck@artyomplokhikh.github.io
alias deckset="gsettings --schemadir $EXT/schemas set org.gnome.shell.extensions.claude-deck"
alias deckget="gsettings --schemadir $EXT/schemas get org.gnome.shell.extensions.claude-deck"
gsettings --schemadir $EXT/schemas list-recursively org.gnome.shell.extensions.claude-deck  # all values
```

| Key | Type, default | Meaning |
|---|---|---|
| `panel-position` | `left` \| `center` \| `right`, `right` | Panel area of the button |
| `panel-index` | int 0-20, `0` | Position inside that area, 0 is the first |
| `icon` | `sparkle` \| `burst`, `sparkle` | Panel icon |
| `icon-color-mode` | `claude` \| `panel` \| `custom`, `claude` | Orange `#d97757`; panel text color (accent while working); or `icon-color` |
| `icon-color` | string, `'#d97757'` | Color for `custom` mode |
| `pulse-when-busy` | bool, `true` | Pulse the icon while any session is working |
| `middle-click-new` | bool, `true` | Middle click on the icon starts a new session |
| `show-limits` `show-today` `show-chart` `show-sessions` `show-projects` `show-actions` | bool, `true` | Menu sections |
| `projects-count` | int 1-20, `6` | Recent projects shown |
| `chart-metric` | `messages` \| `tools` \| `sessions`, `messages` | Chart metric (also switched by clicking the chart title) |
| `terminal` | string, `'auto'` | `auto` picks the first installed of xdg-terminal-exec, ptyxis, kgx, gnome-terminal, kitty, alacritty, foot, wezterm, konsole, xterm. A name from that list uses it. Anything else is a command prefix that the command is appended to, e.g. `'wezterm start --'` |
| `shell` | string, `''` | Interactive shell for `claude`; empty uses `$SHELL` |
| `default-directory` | string, `''` | Folder for new sessions; empty is home |
| `claude-args` | string, `''` | Extra arguments for every `claude` launch, e.g. `'--model sonnet'` |
| `new-session` | strv, `['<Super>c']` | Shortcut: new session |
| `toggle-menu` | strv, `['<Super><Alt>c']` | Shortcut: open the menu |
| `notify-done` | bool, `true` | Notify when a session finishes while its terminal is not focused |
| `refresh-seconds` | uint 10-600, `60` | Background refresh; session changes are picked up immediately anyway |

Examples:

```sh
deckset panel-position left
deckset panel-index 0
deckset icon-color-mode custom && deckset icon-color '#a3be8c'
deckset show-chart false
deckset terminal kitty
deckset new-session "['<Super><Shift>Return']"
deckset toggle-menu "[]"          # disable a shortcut
```

Check a shortcut is free before assigning it: `gsettings list-recursively | grep -i "<super>x'"` and also the custom shortcuts in `dconf dump /org/gnome/settings-daemon/plugins/media-keys/`.

## 2. style.css

`~/.config/claude-deck/style.css` is loaded on top of the built-in stylesheet and reloaded on every save. It is GNOME Shell CSS (St), a subset of CSS: no variables, no `calc()`, no `!important` needed because it loads last. Useful functions: `st-transparentize(color, 0.5)`, `st-lighten(color, 10%)`, `st-darken(color, 10%)`, `st-mix(c1, c2, 50%)`. `-st-accent-color` and `-st-accent-fg-color` are the system accent.

A broken file shows `style.css: <error>` at the bottom of the menu.

### Classes

| Class | Element |
|---|---|
| `.cd-panel-button` | Panel button (`#panel .panel-button.cd-panel-button` for padding: `-natural-hpadding`) |
| `.cd-panel-icon` | Panel icon; `.busy` while working. Color set in settings wins over CSS `color` unless the mode is `panel` |
| `.cd-menu` | Menu box (`width: 340px`) |
| `.cd-static` | Non-clickable rows; also `.cd-header` `.cd-limits` `.cd-limits-off` `.cd-today-title` `.cd-today` `.cd-chart-title` `.cd-chart-item` `.cd-sessions-title` on the row |
| `.cd-row` | Horizontal row inside a static item |
| `.cd-title` | "Claude Code" |
| `.cd-dim` | Secondary text (model, summaries, "avg …/day") |
| `.cd-section-title` | TODAY, SESSIONS |
| `.cd-error` | Error line for style.css / actions.json |
| `.cd-icon-button` | Small round buttons; `.cd-settings`, `.cd-continue` (project clock) |
| `.cd-link-button` | "Set up" button when limits are not connected |
| `.cd-limit` | One limit row; parts `.cd-limit-name` `.cd-bar-track` `.cd-bar-fill` (`.warn` ≥50%, `.crit` ≥80%) `.cd-limit-pct` `.cd-limit-reset` |
| `.cd-tiles` `.cd-tile` `.cd-tile-value` `.cd-tile-caption` | Today tiles |
| `.cd-metric-button` | Chart title, click to switch metric |
| `.cd-chart` `.cd-chart-col` `.cd-chart-bar` | Chart; bars have `.today`, `.empty`, and `:hover` |
| `.cd-session` `.cd-dot` `.cd-session-name` `.cd-session-meta` | Session rows; dot has `.busy` or `.waiting` |
| `.cd-shortcut` | Shortcut hint next to "New session" |
| `.cd-project` `.cd-project-name` | Project rows in the Projects submenu |
| `.cd-user-action` | Items from actions.json |

Example, a warmer accent and a wider menu:

```css
.cd-menu { width: 380px; }
.cd-bar-fill, .cd-chart-bar.today, .cd-dot.busy { background-color: #d97757; }
.cd-chart-bar { background-color: st-transparentize(#d97757, 0.4); }
```

## 3. actions.json

`~/.config/claude-deck/actions.json` is a JSON array; each item becomes a menu entry under the built-in actions.

| Field | Required | Meaning |
|---|---|---|
| `label` | yes | Menu text |
| `command` | yes | Shell command line |
| `cwd` | no | Working folder, `~` allowed; default home |
| `terminal` | no | `true` (default) runs in a terminal and keeps the shell open; `false` runs in the background |
| `icon` | no | Symbolic icon name, e.g. `utilities-system-monitor-symbolic` |

```json
[
  {"label": "Review this branch", "command": "claude 'Review the changes on this branch against main'", "cwd": "~/code/shop"},
  {"label": "Summarize this week", "command": "claude -p 'Summarize my commits from this week' | wl-copy && notify-send Claude 'Summary copied'", "cwd": "~/code/shop", "terminal": false},
  {"label": "Usage report", "command": "npx ccusage@latest", "icon": "utilities-system-monitor-symbolic"}
]
```

## Limits

The 5-hour and weekly limits come from Claude Code's status line. See the README section [Limits](README.md#limits): wrap your `statusLine.command` in `~/.claude/settings.json` with `sh <extension folder>/tools/statusline-tee.sh`, keeping any existing command after it as arguments.

## Where things live

| Path | What |
|---|---|
| `~/.local/share/gnome-shell/extensions/claude-deck@artyomplokhikh.github.io/` | The extension (read-only for customizing) |
| `~/.config/claude-deck/` | `style.css`, `actions.json` |
| `~/.cache/claude-deck/` | `status.json` (last status line payload), `limits.json`, `scan.json` (transcript scan cache, safe to delete) |
| `~/.claude/` | Claude Code data the extension reads: `sessions/`, `projects/`, `history.jsonl`, `stats-cache.json` |
