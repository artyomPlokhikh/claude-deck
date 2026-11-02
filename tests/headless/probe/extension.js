// SPDX-License-Identifier: GPL-2.0-or-later
//
// Test driver loaded next to the real extension inside a headless GNOME Shell.
// Writes results.json and screenshots to $CD_TEST_OUT, then stops the shell.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UUID = 'claude-deck@artyomplokhikh.github.io';
const OUT = GLib.getenv('CD_TEST_OUT');
const CONFIG = GLib.build_filenamev([GLib.get_user_config_dir(), 'claude-deck']);

const wait = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));
const enc = new TextEncoder();
const writeFile = (path, text) => GLib.file_set_contents(path, enc.encode(text));

async function shot(name) {
    const stream = Gio.File.new_for_path(`${OUT}/${name}.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot(false, stream);
    stream.close(null);
}

// GNOME restarts extensions enabled after the one being disabled; run the scenario only once.
let started = false;

export default class Probe {
    enable() {
        if (started) return;
        started = true;
        this._results = [];
        this._run().catch(e => this._check('probe finished without exceptions', false, `${e}\n${e.stack}`))
            .finally(() => {
                writeFile(`${OUT}/results.json`, JSON.stringify(this._results, null, 1));
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => global.context.terminate());
            });
    }

    disable() {}

    _check(name, ok, detail = '') {
        this._results.push({name, ok: Boolean(ok), detail: String(detail)});
    }

    get button() {
        return Main.panel.statusArea[UUID];
    }

    get ext() {
        return Main.extensionManager.lookup(UUID).stateObj;
    }

    async _click(actor, button = Clutter.BUTTON_PRIMARY) {
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        this._dev.notify_absolute_motion(GLib.get_monotonic_time(), x + w / 2, y + h / 2);
        await wait(120);
        this._dev.notify_button(GLib.get_monotonic_time(), button, Clutter.ButtonState.PRESSED);
        await wait(50);
        this._dev.notify_button(GLib.get_monotonic_time(), button, Clutter.ButtonState.RELEASED);
        await wait(350);
    }

    async _openMenu() {
        if (!this.button.menu.isOpen) this.button.menu.open();
        await wait(700);
    }

    async _run() {
        await wait(5000);
        Main.overview.hide();
        await wait(2500);
        this._dev = global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        // a fresh virtual pointer has no position yet; move it once so the first click is delivered
        this._dev.notify_absolute_motion(GLib.get_monotonic_time(), 800, 500);
        await wait(300);

        const ext = Main.extensionManager.lookup(UUID);
        this._check('extension is active', ext?.state === 1, `state=${ext?.state} error=${ext?.error}`);
        let b = this.button;
        this._check('button in panel', b, '');
        this._check('button is round-ish', b && b.width <= b.height + 8, `${b?.width}x${b?.height}`);

        // stub out launching so no terminal opens
        const calls = [];
        this.ext.launch = (dir, args) => calls.push({dir, args});
        this.ext.runAction = a => calls.push({action: a.label});

        await this._openMenu();
        this._check('data loaded', b._data?.days?.length === 14, JSON.stringify(b._data?.today));
        this._check('sessions listed', b._sessionItems.length === 2, b._sessionItems.length);
        this._check('limits shown', b._fiveItem.visible && b._five.pct.text === '34%', b._five.pct.text);
        // ages are recomputed on open even when the session rows are reused
        b.menu.close();
        await wait(300);
        const realNow = Date.now;
        Date.now = () => realNow() + 10 * 60000;
        b.menu.open();
        await wait(300);
        const ages = b._sessionItems.map(it => it._meta.text);
        Date.now = realNow;
        this._check('session age refreshes on open', ages.some(t => t.endsWith('· 10m')), ages.join(' | '));
        b.menu.close();
        await wait(300);
        b.menu.open();
        await wait(500);
        this._check('static rows not insensitive',
            !b.menu.box.get_children().some(c => c.has_style_class_name?.('cd-static') &&
                c.has_style_pseudo_class('insensitive')), '');

        // width stays fixed while hovering the chart and switching metrics
        const widths = new Set([b.menu.actor.width]);
        for (let i = 0; i < 14; i++) {
            b._hoverDay(i);
            await wait(30);
            widths.add(b.menu.actor.width);
        }
        b._hoverDay(null);
        for (let i = 0; i < 3; i++) {
            b._metricBtn.emit('clicked', 1);
            await wait(60);
            widths.add(b.menu.actor.width);
        }
        this._check('menu width is stable', widths.size === 1, [...widths].join(','));
        this._check('metric switch does not rebuild', b === this.button, '');

        // projects submenu opens in one frame
        const heights = [];
        const id = global.stage.connect('after-paint', () => heights.push(b.menu.actor.height));
        b._projects.setSubmenuShown(true);
        await wait(500);
        b._projects.setSubmenuShown(false);
        await wait(500);
        global.stage.disconnect(id);
        this._check('projects submenu has no intermediate heights', new Set(heights).size <= 2,
            [...new Set(heights)].join(','));

        b._hoverDay(12);
        await wait(200);
        await shot('menu-dark');
        b._hoverDay(null);

        // clicks
        b.menu.close();
        await wait(300);
        await this._click(b, Clutter.BUTTON_MIDDLE);
        this._check('middle click starts a session without opening the menu',
            calls.length === 1 && !b.menu.isOpen, JSON.stringify(calls));
        await this._click(b);
        await wait(500);
        this._check('left click opens the menu', b.menu.isOpen, '');
        b._projects.setSubmenuShown(true);
        await wait(300);
        const proj = b._projects.menu.box.get_children()[0];
        await this._click(proj.get_children().find(c => c instanceof St.Button));
        this._check('continue button launches --continue once',
            calls.length === 2 && calls[1].args?.[0] === '--continue', JSON.stringify(calls));
        await this._openMenu();
        b._projects.setSubmenuShown(true);
        await wait(300);
        await this._click(b._projects.menu.box.get_children()[1]);
        this._check('project row starts a new session in that folder',
            calls.length === 3 && calls[2].args.length === 0 && calls[2].dir?.endsWith('/code/blog'),
            JSON.stringify(calls[2]));

        // actions.json: valid, then broken, hot reloaded
        writeFile(`${CONFIG}/actions.json`, JSON.stringify([
            {label: 'Review current branch', command: 'claude review', cwd: '~/code/shop-api'},
            {label: 'Usage report', command: 'npx ccusage', icon: 'utilities-system-monitor-symbolic'},
        ]));
        await wait(1200);
        b = this.button;
        this._check('actions.json adds menu items', b._userActions.box.get_n_children() === 2,
            b._userActions.box.get_n_children());
        await this._openMenu();
        await this._click(b._userActions.box.get_children()[0]);
        this._check('action runs', calls.at(-1)?.action === 'Review current branch', JSON.stringify(calls.at(-1)));
        writeFile(`${CONFIG}/actions.json`, '[{"label": ');
        await wait(1200);
        const errText = b._userActions.box.get_children()[0]?.get_children()?.[1]?.text ?? '';
        this._check('broken actions.json shows an error row', errText.startsWith('actions.json:'), errText);
        writeFile(`${CONFIG}/actions.json`, JSON.stringify([
            {label: 'Usage report', command: 'npx ccusage', icon: 'utilities-system-monitor-symbolic'},
        ]));
        await wait(1200);

        // style.css hot reload
        writeFile(`${CONFIG}/style.css`, '.cd-title { color: #ff0000; }');
        await wait(1500);
        await this._openMenu();
        const title = this.button.menu.box.get_children()[0].get_children()[1].get_children()[0];
        const fg = title.get_theme_node().get_foreground_color();
        this._check('style.css applies without relogin', fg.red === 255 && fg.green === 0, `${fg.red},${fg.green}`);
        const scheme = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        scheme.set_string('color-scheme', 'prefer-light');
        await wait(2000);
        await this._openMenu();
        const title2 = this.button.menu.box.get_children()[0].get_children()[1].get_children()[0];
        const fg2 = title2.get_theme_node().get_foreground_color();
        this._check('style.css still wins after a light/dark switch', fg2.red === 255 && fg2.green === 0,
            `${fg2.red},${fg2.green}`);
        scheme.set_string('color-scheme', 'prefer-dark');
        await wait(1500);
        GLib.unlink(`${CONFIG}/style.css`);
        await wait(1500);

        // a busy session turning idle sends a notification
        const sessDir = `${GLib.getenv('CLAUDE_CONFIG_DIR')}/sessions`;
        const en = Gio.File.new_for_path(sessDir).enumerate_children('standard::name', 0, null);
        let info, flipped = false;
        while ((info = en.next_file(null))) {
            const path = `${sessDir}/${info.get_name()}`;
            const [, raw] = GLib.file_get_contents(path);
            const d = JSON.parse(new TextDecoder().decode(raw));
            if (d.status === 'busy') {
                flipped = path;
                d.status = 'idle';
                d.statusUpdatedAt = Date.now();
                writeFile(path, JSON.stringify(d));
            }
        }
        await wait(3000);
        const notes = Main.messageTray.getSources().filter(src => src.title === 'Claude Code')
            .flatMap(src => src.notifications);
        this._check('finished session sends a notification', flipped && notes.length === 1 &&
            notes[0].body.startsWith('Done'), notes.map(n => `${n.title}: ${n.body}`).join(' | '));
        if (flipped) {
            // back to working, so later screenshots show a live session
            const [, raw] = GLib.file_get_contents(flipped);
            const d = JSON.parse(new TextDecoder().decode(raw));
            d.status = 'busy';
            d.statusUpdatedAt = Date.now() - 40000;
            writeFile(flipped, JSON.stringify(d));
            await wait(2000);
        }

        // settings rebuild the button live
        const settings = this.ext.settings;
        settings.set_string('panel-position', 'left');
        await wait(600);
        this._check('panel position applies live', this.button.container.get_parent() === Main.panel._leftBox, '');
        settings.reset('panel-position');
        await wait(600);

        // enable/disable cycles
        for (let i = 0; i < 3; i++) {
            Main.extensionManager.disableExtension(UUID);
            await wait(300);
            this._check(`disable ${i + 1} removes the button`, !this.button, '');
            Main.extensionManager.enableExtension(UUID);
            await wait(800);
        }
        this._check('disable removes the notification source',
            !Main.messageTray.getSources().some(src => src.title === 'Claude Code'), '');
        this._check('re-enabled after cycles', Main.extensionManager.lookup(UUID).state === 1,
            Main.extensionManager.lookup(UUID).error);

        // screenshot: light variant
        await this._openMenu();
        this.button._hoverDay(null);
        const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        iface.set_string('color-scheme', 'prefer-light');
        await wait(2000);
        await this._openMenu();
        await shot('menu-light');
        this.button.menu.close();
        iface.set_string('color-scheme', 'prefer-dark');
        await wait(1500);

        this.ext.openPreferences();
        await wait(5000);
        Main.overview.hide();
        await wait(1500);
        await shot('prefs');
    }
}
