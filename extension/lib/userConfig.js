// SPDX-License-Identifier: GPL-2.0-or-later
//
// User customisation that survives extension updates, both reloaded on change:
//   ~/.config/claude-deck/style.css     loaded on top of the built-in stylesheet
//   ~/.config/claude-deck/actions.json  extra menu items
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

const decoder = new TextDecoder();

export class UserConfig {
    constructor(onActionsChanged) {
        this._onActionsChanged = onActionsChanged;
        this.dir = GLib.build_filenamev([GLib.get_user_config_dir(), 'claude-deck']);
        this.stylePath = GLib.build_filenamev([this.dir, 'style.css']);
        this.actionsPath = GLib.build_filenamev([this.dir, 'actions.json']);
        this.actions = [];
        this.actionsError = null;
        this.styleError = null;
        this._styleFile = null;
        this._cancellable = new Gio.Cancellable();
        this._debounce = {};

        GLib.mkdir_with_parents(this.dir, 0o755);
        this._monitor = Gio.File.new_for_path(this.dir).monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', (_m, file) => {
            const name = file.get_basename();
            if (name === 'style.css') this._queue('style', () => this._reloadStyle(true));
            else if (name === 'actions.json') this._queue('actions', () => this._loadActions());
        });

        // On a light/dark switch the shell reloads extension stylesheets, which would put the
        // built-in one after the user's; load the user's again so it keeps winning.
        this._schemeId = St.Settings.get().connect('notify::color-scheme', () => {
            if (this._styleFile) this._queue('style', () => this._reloadStyle(true));
        });

        this._reloadStyle(false);
        this._loadActions();
    }

    _queue(key, fn) {
        if (this._debounce[key]) return;
        this._debounce[key] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            delete this._debounce[key];
            fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    _theme() {
        return St.ThemeContext.get_for_stage(global.stage).get_theme();
    }

    _unloadStyle() {
        if (!this._styleFile) return;
        this._theme().unload_stylesheet(this._styleFile);
        this._styleFile = null;
    }

    _reloadStyle(restyle) {
        this._unloadStyle();
        this.styleError = null;
        const file = Gio.File.new_for_path(this.stylePath);
        if (file.query_exists(null)) {
            try {
                this._theme().load_stylesheet(file);
                this._styleFile = file;
            } catch (e) {
                this.styleError = e.message;
                console.warn(`claude-deck: style.css: ${e.message}`);
            }
        }
        // Rebuild the theme so already-styled actors pick up the change.
        if (restyle) Main.loadTheme();
    }

    async _loadActions() {
        let actions = [], error = null;
        try {
            const [bytes] = await Gio.File.new_for_path(this.actionsPath).load_contents_async(this._cancellable);
            const data = JSON.parse(decoder.decode(bytes));
            if (!Array.isArray(data)) throw new Error('expected a JSON array');
            actions = data.filter(a => a && typeof a.label === 'string' && typeof a.command === 'string');
            if (actions.length !== data.length) error = 'items need "label" and "command"';
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) error = e.message;
        }
        this.actions = actions;
        this.actionsError = error ? `actions.json: ${error}` : null;
        this._onActionsChanged?.();
    }

    destroy() {
        this._cancellable.cancel();
        for (const id of Object.values(this._debounce)) GLib.source_remove(id);
        this._debounce = {};
        this._monitor.cancel();
        this._monitor = null;
        St.Settings.get().disconnect(this._schemeId);
        this._onActionsChanged = null;
        if (this._styleFile) {
            this._unloadStyle();
            Main.loadTheme();
        }
    }
}
