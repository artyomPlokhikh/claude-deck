// SPDX-License-Identifier: GPL-2.0-or-later
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {tildify} from './lib/format.js';
import {KNOWN_TERMINALS, detectTerminal} from './lib/launcher.js';

const REPO = 'https://github.com/artyomPlokhikh/claude-deck';

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle: subtitle ?? ''});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, min, max, step = 1) {
    const row = new Adw.SpinRow({
        title,
        adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step, page_increment: step * 10}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function enumRow(settings, key, title, items) {
    const row = new Adw.ComboRow({title, model: Gtk.StringList.new(items.map(i => i[1]))});
    const sync = () => {
        row.selected = Math.max(0, items.findIndex(i => i[0] === settings.get_string(key)));
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        const v = items[row.selected]?.[0];
        if (v && v !== settings.get_string(key)) settings.set_string(key, v);
    });
    return row;
}

function entryRow(settings, key, title) {
    const row = new Adw.EntryRow({title, show_apply_button: true, text: settings.get_string(key)});
    row.connect('apply', () => settings.set_string(key, row.text.trim()));
    settings.connect(`changed::${key}`, () => {
        if (row.text !== settings.get_string(key)) row.text = settings.get_string(key);
    });
    return row;
}

function openUri(uri, window) {
    new Gtk.UriLauncher({uri}).launch(window, null, null);
}

function linkSuffix(row, icon, cb) {
    const btn = new Gtk.Button({icon_name: icon, valign: Gtk.Align.CENTER, css_classes: ['flat']});
    btn.connect('clicked', cb);
    row.add_suffix(btn);
    row.activatable_widget = btn;
    return btn;
}

function shortcutRow(settings, key, title, window) {
    const row = new Adw.ActionRow({title, activatable: true});
    const lbl = new Gtk.ShortcutLabel({disabled_text: 'Disabled', valign: Gtk.Align.CENTER});
    const sync = () => {
        lbl.accelerator = settings.get_strv(key)[0] ?? '';
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.add_suffix(lbl);

    const reset = new Gtk.Button({icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
        tooltip_text: 'Reset'});
    reset.connect('clicked', () => settings.reset(key));
    row.add_suffix(reset);

    row.connect('activated', () => {
        const dialog = new Adw.AlertDialog({heading: title, body: 'Press Esc to cancel or Backspace to disable'});
        dialog.add_response('cancel', 'Cancel');
        const ctl = new Gtk.EventControllerKey();
        ctl.connect('key-pressed', (_c, keyval, keycode, state) => {
            let mask = state & Gtk.accelerator_get_default_mod_mask();
            mask &= ~Gdk.ModifierType.LOCK_MASK;
            if (!mask && keyval === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!mask && keyval === Gdk.KEY_BackSpace) {
                settings.set_strv(key, []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!mask || !Gtk.accelerator_valid(keyval, mask))
                return Gdk.EVENT_STOP;
            settings.set_strv(key, [Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask)]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(ctl);
        dialog.present(window);
    });
    return row;
}

function toHex(rgba) {
    const h = v => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${h(rgba.red)}${h(rgba.green)}${h(rgba.blue)}`;
}

function colorRow(settings, key, title, modeKey, modeValue) {
    const row = new Adw.ActionRow({title});
    const btn = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: false}),
        valign: Gtk.Align.CENTER,
    });
    const sync = () => {
        const c = new Gdk.RGBA();
        if (c.parse(settings.get_string(key))) btn.rgba = c;
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    btn.connect('notify::rgba', () => {
        const hex = toHex(btn.rgba);
        if (hex !== settings.get_string(key)) settings.set_string(key, hex);
    });
    row.add_suffix(btn);
    row.activatable_widget = btn;
    const syncMode = () => {
        row.sensitive = settings.get_string(modeKey) === modeValue;
    };
    syncMode();
    settings.connect(`changed::${modeKey}`, syncMode);
    return row;
}

// Terminal: Automatic, the known terminals installed here, or a custom command prefix.
function terminalRows(settings) {
    const installed = KNOWN_TERMINALS.filter(t => GLib.find_program_in_path(t));
    const values = ['auto', ...installed, 'custom'];
    const auto = detectTerminal();
    const names = [auto ? `Automatic (${auto})` : 'Automatic', ...installed, 'Custom'];
    const combo = new Adw.ComboRow({title: 'Terminal', model: Gtk.StringList.new(names)});
    const custom = new Adw.EntryRow({title: 'Terminal command', show_apply_button: true});
    custom.connect('apply', () => {
        if (custom.text.trim()) settings.set_string('terminal', custom.text.trim());
    });

    let syncing = false;
    const sync = () => {
        syncing = true;
        const v = settings.get_string('terminal');
        const i = values.indexOf(v);
        combo.selected = i >= 0 && v !== 'custom' ? i : values.length - 1;
        custom.visible = combo.selected === values.length - 1;
        if (custom.visible && custom.text !== v) custom.text = v;
        syncing = false;
    };
    sync();
    settings.connect('changed::terminal', sync);
    combo.connect('notify::selected', () => {
        if (syncing) return;
        const v = values[combo.selected];
        custom.visible = v === 'custom';
        if (v !== 'custom') settings.set_string('terminal', v);
    });
    return [combo, custom];
}

export default class DeckPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        window.set_default_size(620, 760);
        window.search_enabled = true;

        /* ---- Panel ---- */
        const panel = new Adw.PreferencesPage({title: 'Panel', icon_name: 'preferences-desktop-display-symbolic'});
        window.add(panel);

        const button = new Adw.PreferencesGroup({title: 'Button'});
        panel.add(button);
        button.add(enumRow(s, 'panel-position', 'Area', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']]));
        button.add(spinRow(s, 'panel-index', 'Index', 0, 20));
        button.add(enumRow(s, 'icon', 'Icon', [['claude', 'Claude'], ['sparkle', 'Sparkle']]));
        button.add(enumRow(s, 'icon-color-mode', 'Icon color',
            [['claude', 'Orange'], ['panel', 'Panel text'], ['custom', 'Custom']]));
        button.add(colorRow(s, 'icon-color', 'Custom color', 'icon-color-mode', 'custom'));
        button.add(switchRow(s, 'pulse-when-busy', 'Pulse while working'));
        button.add(switchRow(s, 'middle-click-new', 'Start a new session on middle click'));

        const sections = new Adw.PreferencesGroup({title: 'Menu'});
        panel.add(sections);
        sections.add(switchRow(s, 'show-prompt', 'Prompt'));
        sections.add(switchRow(s, 'show-limits', 'Limits'));
        sections.add(switchRow(s, 'show-today', 'Today'));
        sections.add(switchRow(s, 'show-chart', '14 days'));
        sections.add(enumRow(s, 'chart-metric', 'Chart metric',
            [['messages', 'Messages'], ['tools', 'Tool calls'], ['sessions', 'Sessions']]));
        sections.add(switchRow(s, 'show-sessions', 'Sessions'));
        sections.add(switchRow(s, 'show-projects', 'Projects'));
        sections.add(spinRow(s, 'projects-count', 'Projects shown', 1, 20));
        sections.add(switchRow(s, 'show-actions', 'Custom actions'));

        /* ---- Launch ---- */
        const launch = new Adw.PreferencesPage({title: 'Launch', icon_name: 'utilities-terminal-symbolic'});
        window.add(launch);

        const term = new Adw.PreferencesGroup({title: 'Terminal'});
        launch.add(term);
        for (const row of terminalRows(s)) term.add(row);
        term.add(entryRow(s, 'shell', 'Shell, empty for $SHELL'));

        const claude = new Adw.PreferencesGroup({title: 'Claude'});
        launch.add(claude);
        const dirRow = entryRow(s, 'default-directory', 'Default directory, empty for home');
        const pick = new Gtk.Button({icon_name: 'folder-open-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
        pick.connect('clicked', () => {
            const dlg = new Gtk.FileDialog({title: 'Default directory'});
            dlg.initial_folder = Gio.File.new_for_path(s.get_string('default-directory') || GLib.get_home_dir());
            dlg.select_folder(window, null, (d, res) => {
                try {
                    const f = d.select_folder_finish(res);
                    if (f) s.set_string('default-directory', f.get_path());
                } catch {}
            });
        });
        dirRow.add_suffix(pick);
        claude.add(dirRow);
        claude.add(entryRow(s, 'claude-args', 'Extra arguments'));

        /* ---- Behaviour ---- */
        const behave = new Adw.PreferencesPage({title: 'Behaviour', icon_name: 'preferences-system-symbolic'});
        window.add(behave);

        const keys = new Adw.PreferencesGroup({title: 'Shortcuts'});
        behave.add(keys);
        keys.add(shortcutRow(s, 'new-session', 'New session', window));
        keys.add(shortcutRow(s, 'toggle-menu', 'Open menu', window));

        const misc = new Adw.PreferencesGroup({title: 'Updates'});
        behave.add(misc);
        misc.add(switchRow(s, 'notify-done', 'Notify when a session finishes'));
        misc.add(spinRow(s, 'refresh-seconds', 'Refresh interval, s', 10, 600, 10));

        // limits come from Claude Code's status line, see tools/statusline-tee.sh
        const limits = new Adw.PreferencesGroup({title: 'Limits'});
        behave.add(limits);
        const cache = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-deck']);
        const connected = ['limits.json', 'status.json'].some(f =>
            GLib.file_test(GLib.build_filenamev([cache, f]), GLib.FileTest.EXISTS));
        const cmd = `sh ${tildify(this.dir.get_child('tools').get_child('statusline-tee.sh').get_path())}`;
        const cmdRow = new Adw.ActionRow({
            title: connected ? 'Connected' : 'Not connected',
            subtitle: cmd,
            subtitle_selectable: true,
        });
        cmdRow.add_css_class('property');
        linkSuffix(cmdRow, 'edit-copy-symbolic', () => {
            Gdk.Display.get_default().get_clipboard().set(cmd);
            window.add_toast(new Adw.Toast({title: 'Copied'}));
        });
        limits.add(cmdRow);
        const help = new Adw.ActionRow({title: 'Setup guide'});
        linkSuffix(help, 'adw-external-link-symbolic', () => openUri(`${REPO}#limits`, window));
        limits.add(help);

        // ~/.config/claude-deck: style.css and actions.json
        const custom = new Adw.PreferencesGroup({title: 'Customization'});
        behave.add(custom);
        const cfg = GLib.build_filenamev([GLib.get_user_config_dir(), 'claude-deck']);
        const folder = new Adw.ActionRow({title: 'Config folder', subtitle: tildify(cfg)});
        linkSuffix(folder, 'folder-open-symbolic', () => {
            GLib.mkdir_with_parents(cfg, 0o755);
            openUri(Gio.File.new_for_path(cfg).get_uri(), window);
        });
        custom.add(folder);
        const guide = new Adw.ActionRow({title: 'Customization guide'});
        linkSuffix(guide, 'adw-external-link-symbolic', () => openUri(`${REPO}/blob/main/CUSTOMIZING.md`, window));
        custom.add(guide);
    }
}
