// SPDX-License-Identifier: GPL-2.0-or-later
//
// Deck for Claude Code: launch, track and get notified about Claude Code sessions from the top bar.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {tildify} from './lib/format.js';
import {claudeCommand, runDetached, runInTerminal} from './lib/launcher.js';
import {DeckButton} from './lib/menu.js';
import {UserConfig} from './lib/userConfig.js';
import {findWindow} from './lib/windows.js';

// Settings that change how the button or menu is built; they rebuild it.
const LAYOUT_KEYS = new Set([
    'panel-position', 'panel-index', 'icon', 'icon-color-mode', 'icon-color', 'pulse-when-busy',
    'middle-click-new', 'show-limits', 'show-today', 'show-chart',
    'show-sessions', 'show-projects', 'show-actions', 'projects-count', 'chart-metric', 'new-session',
]);

export default class DeckExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        this._cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-deck']);
        GLib.mkdir_with_parents(this._cacheDir, 0o755);
        this._claudeDir = GLib.getenv('CLAUDE_CONFIG_DIR') || GLib.build_filenamev([GLib.get_home_dir(), '.claude']);

        this._prev = new Map();
        this._running = false;
        this._pending = false;
        this._quietKey = null;
        this._last = null;
        this._cancellable = new Gio.Cancellable();
        this._source = null;
        this._sourceDestroyId = 0;
        this._notifications = new Map();
        this._proc = null;

        this._userConfig = new UserConfig(() => this._button?.setUserActions());
        this._handlers = {
            launch: (dir, args) => this.launch(dir, args),
            runAction: action => this.runAction(action),
            focusSession: s => this.focusSession(s),
            refresh: () => this.refresh(),
            openPreferences: () => this.openPreferences(),
            setQuiet: (key, value) => this._setQuiet(key, value),
            userConfig: this._userConfig,
        };
        this._addButton();

        this._monitors = [];
        this._watch(GLib.build_filenamev([this._claudeDir, 'sessions']), null);
        this._watch(this._cacheDir, 'status.json');

        const mode = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        Main.wm.addKeybinding('new-session', this.settings, Meta.KeyBindingFlags.NONE, mode,
            () => this.launch(null, []));
        Main.wm.addKeybinding('toggle-menu', this.settings, Meta.KeyBindingFlags.NONE, mode,
            () => this._button?.menu.toggle());

        this._settingsIds = [
            this.settings.connect('changed::refresh-seconds', () => this._startTimer()),
            this.settings.connect('changed', (_s, key) => {
                if (LAYOUT_KEYS.has(key) && key !== this._quietKey) this._queueRebuild();
            }),
        ];
        this._startTimer();
        this.refresh();
    }

    disable() {
        Main.wm.removeKeybinding('new-session');
        Main.wm.removeKeybinding('toggle-menu');
        for (const id of this._settingsIds) this.settings.disconnect(id);
        this._settingsIds = null;
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = null;
        if (this._debounce) GLib.source_remove(this._debounce);
        this._debounce = null;
        if (this._rebuildId) GLib.source_remove(this._rebuildId);
        this._rebuildId = null;
        for (const [mon, id] of this._monitors) {
            mon.disconnect(id);
            mon.cancel();
        }
        this._monitors = null;
        this._cancellable.cancel();
        this._cancellable = null;
        // a running stats worker would otherwise outlive the extension
        this._proc?.force_exit();
        this._proc = null;
        for (const [notification, ids] of this._notifications) ids.forEach(id => notification.disconnect(id));
        this._notifications = null;
        if (this._source) {
            this._source.disconnect(this._sourceDestroyId);
            this._source.destroy();
        }
        this._source = null;
        this._sourceDestroyId = 0;
        this._button?.destroy();
        this._button = null;
        this._userConfig.destroy();
        this._userConfig = null;
        this._handlers = null;
        this._prev = null;
        this._last = null;
        this.settings = null;
    }

    _addButton() {
        this._button = new DeckButton(this, this._handlers);
        Main.panel.addToStatusArea(this.uuid, this._button,
            this.settings.get_int('panel-index'), this.settings.get_string('panel-position'));
        if (this._last) this._button.update(this._last);
    }

    _queueRebuild() {
        if (this._rebuildId) return;
        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._rebuildId = null;
            this._button?.destroy();
            this._addButton();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Change a setting from inside the menu without rebuilding it.
    _setQuiet(key, value) {
        this._quietKey = key;
        this.settings.set_string(key, value);
        this._quietKey = null;
    }

    _startTimer() {
        if (this._timer) GLib.source_remove(this._timer);
        const secs = Math.max(10, this.settings.get_uint('refresh-seconds'));
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, secs, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _watch(path, only) {
        try {
            GLib.mkdir_with_parents(path, 0o755);
            const mon = Gio.File.new_for_path(path).monitor_directory(Gio.FileMonitorFlags.NONE, null);
            const id = mon.connect('changed', (_m, file) => {
                if (!only || file.get_basename() === only) this._queue();
            });
            this._monitors.push([mon, id]);
        } catch (e) {
            console.warn(`claude-deck: cannot watch ${path}: ${e.message}`);
        }
    }

    _queue() {
        if (this._debounce) return;
        this._debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            this._debounce = null;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    refresh() {
        if (this._running) {
            this._pending = true;
            return;
        }
        this._running = true;
        let proc;
        try {
            // Stats run in a separate gjs process so parsing large transcripts never blocks the shell.
            proc = Gio.Subprocess.new(['gjs', '-m', this.dir.get_child('worker').get_child('stats-worker.js').get_path()],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this._running = false;
            console.error(`claude-deck: ${e.message}`);
            return;
        }
        this._proc = proc;
        proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
            this._running = false;
            if (this._proc === p) this._proc = null;
            try {
                const [, out, err] = p.communicate_utf8_finish(res);
                if (!p.get_successful()) throw new Error(err || 'stats worker failed');
                if (this._button) this._apply(JSON.parse(out));
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.error(`claude-deck: ${e.message}`);
                return;
            }
            if (this._pending) {
                this._pending = false;
                this._queue();
            }
        });
    }

    _apply(d) {
        this._last = d;
        this._button.update(d);

        const seen = new Map();
        for (const s of d.sessions) {
            const before = this._prev.get(s.id);
            seen.set(s.id, s.status);
            if (before === 'busy' && s.status !== 'busy' && this.settings.get_boolean('notify-done'))
                this._notifyDone(s).catch(e => console.error(`claude-deck: ${e.message}`));
        }
        this._prev = seen;
    }

    async _notifyDone(s) {
        const win = await findWindow(s.pid, this._cancellable);
        if (!this.settings || win?.has_focus()) return;
        if (!this._source) {
            this._source = new MessageTray.Source({
                title: 'Claude Code',
                icon: Gio.FileIcon.new(this.dir.get_child('icons').get_child(
                    `${this.settings.get_string('icon')}-symbolic.svg`)),
            });
            this._sourceDestroyId = this._source.connect('destroy', () => {
                this._source = null;
                this._sourceDestroyId = 0;
                this._notifications?.clear();
            });
            Main.messageTray.add(this._source);
        }
        const source = this._source;
        const notification = new MessageTray.Notification({
            source,
            title: s.name || tildify(s.cwd),
            body: `${s.status === 'idle' ? 'Done' : 'Needs input'} · ${tildify(s.cwd)}`,
        });
        const ids = [
            notification.connect('activated', () => this.focusSession(s)),
            notification.connect('destroy', () => this._notifications?.delete(notification)),
        ];
        this._notifications.set(notification, ids);
        source.addNotification(notification);
    }

    focusSession(s) {
        findWindow(s.pid, this._cancellable).then(win => {
            if (win) Main.activateWindow(win);
        }).catch(e => console.error(`claude-deck: ${e.message}`));
    }

    _terminalOptions(cwd, script) {
        return {
            cwd: cwd || this.settings.get_string('default-directory') || GLib.get_home_dir(),
            script,
            terminal: this.settings.get_string('terminal'),
            shell: this.settings.get_string('shell'),
        };
    }

    launch(dir, args) {
        try {
            const cmd = claudeCommand(this.settings.get_string('claude-args'), args);
            runInTerminal(this._terminalOptions(dir, cmd));
        } catch (e) {
            Main.notifyError('Deck for Claude Code', e.message);
        }
    }

    // Custom action from actions.json.
    runAction(action) {
        try {
            if (action.terminal === false) runDetached(action.cwd, action.command);
            else runInTerminal(this._terminalOptions(action.cwd, action.command));
        } catch (e) {
            Main.notifyError('Deck for Claude Code', `${action.label}: ${e.message}`);
        }
    }
}
