// SPDX-License-Identifier: GPL-2.0-or-later
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {fmtAccel, fmtAgo, fmtDay, fmtNum, fmtReset, level, tildify} from './format.js';

const BAR_PX = 120;
const CHART_PX = 34;
const METRICS = ['messages', 'tools', 'sessions'];
const METRIC_LABEL = {messages: 'MESSAGES', tools: 'TOOL CALLS', sessions: 'SESSIONS'};
const ORANGE = '#d97757';
export const LIMITS_HELP_URL = 'https://github.com/artyomPlokhikh/claude-deck#limits';

function label(text, style, props = {}) {
    return new St.Label({text, style_class: style, y_align: Clutter.ActorAlign.CENTER, ...props});
}

function ellipsized(text, style, mode, props = {}) {
    const l = label(text, style, props);
    l.clutter_text.ellipsize = mode;
    return l;
}

function iconButton(icon, cb, extra = '') {
    const b = new St.Button({
        style_class: `cd-icon-button ${extra}`,
        child: new St.Icon({icon_name: icon, icon_size: 14}),
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    b.connect('clicked', cb);
    return b;
}

// Non-clickable row. Stays reactive: St gives non-reactive actors the :insensitive
// pseudo class, which most shell themes render at half opacity.
const StaticItem = GObject.registerClass(
class StaticItem extends PopupMenu.PopupBaseMenuItem {
    _init(child, styleClass = '') {
        super._init({activate: false, hover: false, can_focus: false, style_class: `cd-static ${styleClass}`});
        child.x_expand = true;
        this.add_child(child);
    }

    getSensitive() {
        return true;
    }

    syncSensitive() {
        this.reactive = true;
        this.can_focus = false;
        return true;
    }
});

// Submenu that opens and closes instantly: the stock height animation overshoots by a few
// pixels and snaps back, which makes the whole menu jitter.
const InstantSubMenuItem = GObject.registerClass(
class InstantSubMenuItem extends PopupMenu.PopupSubMenuMenuItem {
    setSubmenuShown(open) {
        if (open) this.menu.open(false);
        else this.menu.close(false);
    }
});

function sectionTitle(left) {
    const row = new St.BoxLayout({style_class: 'cd-row', x_expand: true});
    const l = left instanceof Clutter.Actor ? left : label(left, 'cd-section-title');
    l.x_expand = true;
    row.add_child(l);
    const right = ellipsized('', 'cd-dim', Pango.EllipsizeMode.END);
    row.add_child(right);
    return {row, right};
}

class LimitRow {
    constructor(name) {
        this.box = new St.BoxLayout({style_class: 'cd-limit', x_expand: true});
        this.box.add_child(label(name, 'cd-limit-name'));
        const track = new St.BoxLayout({style_class: 'cd-bar-track', y_align: Clutter.ActorAlign.CENTER});
        this.fill = new St.Widget({style_class: 'cd-bar-fill'});
        track.add_child(this.fill);
        this.box.add_child(track);
        this.pct = label('-', 'cd-limit-pct');
        this.box.add_child(this.pct);
        this.reset = label('', 'cd-limit-reset', {x_expand: true, x_align: Clutter.ActorAlign.END});
        this.box.add_child(this.reset);
    }

    update(l) {
        const pct = l && l.pct !== null && l.pct !== undefined ? Math.max(0, Math.min(100, l.pct)) : null;
        this.pct.text = pct === null ? '-' : `${Math.round(pct)}%`;
        this.fill.set_style(`width: ${Math.round(BAR_PX * (pct ?? 0) / 100)}px;`);
        this.fill.style_class = `cd-bar-fill ${level(pct ?? 0)}`;
        const r = fmtReset(l?.reset);
        this.reset.text = r ? `↻ ${r}` : '';
    }
}

class Tile {
    constructor(caption) {
        this.box = new St.BoxLayout({style_class: 'cd-tile', orientation: Clutter.Orientation.VERTICAL,
            x_expand: true});
        this.value = new St.Label({text: '-', style_class: 'cd-tile-value'});
        this.box.add_child(this.value);
        this.box.add_child(new St.Label({text: caption, style_class: 'cd-tile-caption'}));
    }
}

const SessionItem = GObject.registerClass(
class SessionItem extends PopupMenu.PopupBaseMenuItem {
    _init(s, onActivate) {
        super._init({style_class: 'cd-session'});
        this._s = s;
        const status = s.status === 'busy' ? 'busy' : s.status === 'idle' ? '' : 'waiting';
        this.add_child(new St.Widget({style_class: `cd-dot ${status}`, y_align: Clutter.ActorAlign.CENTER}));
        this.add_child(ellipsized(s.name || tildify(s.cwd), 'cd-session-name', Pango.EllipsizeMode.END,
            {x_expand: true}));
        this._meta = ellipsized('', 'cd-session-meta', Pango.EllipsizeMode.START);
        this.add_child(this._meta);
        this.tick();
        this.connect('activate', () => onActivate(s));
    }

    tick() {
        this._meta.text = `${tildify(this._s.cwd)} · ${fmtAgo(this._s.updated)}`;
    }
});

const ProjectItem = GObject.registerClass(
class ProjectItem extends PopupMenu.PopupBaseMenuItem {
    _init(path, onNew, onContinue) {
        super._init({style_class: 'cd-project'});
        this.add_child(ellipsized(tildify(path), 'cd-project-name', Pango.EllipsizeMode.START, {x_expand: true}));
        this.add_child(iconButton('document-open-recent-symbolic', () => onContinue(path), 'cd-continue'));
        this.connect('activate', () => onNew(path));
    }
});

export const DeckButton = GObject.registerClass(
class DeckButton extends PanelMenu.Button {
    /**
     * @param {object} ext the extension
     * @param {object} handlers callbacks into the extension
     */
    _init(ext, handlers) {
        super._init(0.5, 'Deck for Claude Code');
        this._ext = ext;
        this._h = handlers;
        const s = ext.settings;
        this._opt = Object.fromEntries(['pulse-when-busy', 'show-prompt', 'show-limits',
            'show-today', 'show-chart', 'show-sessions', 'show-projects', 'show-actions', 'middle-click-new']
            .map(k => [k, s.get_boolean(k)]));
        this._metric = s.get_string('chart-metric');
        this._colorMode = s.get_string('icon-color-mode');
        this._customColor = s.get_string('icon-color') || ORANGE;
        this._projectsCount = s.get_int('projects-count');
        this._sessionItems = [];
        this._busy = false;

        this._icon = new St.Icon({
            gicon: Gio.FileIcon.new(ext.dir.get_child('icons').get_child(`${s.get_string('icon')}-symbolic.svg`)),
            style_class: 'system-status-icon cd-panel-icon',
        });
        // Same layout as AppIndicator icons in compact mode, so the button is a circle like its
        // neighbours: indicators box drops the icon padding, hpadding 10px.
        this.add_style_class_name('cd-panel-button');
        const iconBox = new St.BoxLayout({style_class: 'panel-status-indicators-box'});
        iconBox.add_child(this._icon);
        this.add_child(iconBox);
        this._syncIconColor();

        if (this._opt['middle-click-new']) {
            // the stock click gesture opens the menu on any mouse button; keep it to the left one
            for (const action of this.get_actions()) {
                if (action instanceof Clutter.ClickGesture) action.required_button = Clutter.BUTTON_PRIMARY;
            }
            const middle = new Clutter.ClickGesture({required_button: Clutter.BUTTON_MIDDLE});
            middle.set_recognize_on_press(true);
            middle.connect('recognize', () => this._h.launch(null, []));
            this.add_action(middle);
        }

        this.menu.box.add_style_class_name('cd-menu');
        this._buildMenu();
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._h.refresh();
                this._startTicker();
                if (this._entry) {
                    this._focusId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        this._focusId = null;
                        if (this.menu.isOpen) global.stage.set_key_focus(this._entry);
                        return GLib.SOURCE_REMOVE;
                    });
                }
            } else {
                this._stopTicker();
            }
        });
    }

    _buildMenu() {
        const m = this.menu;
        const o = this._opt;

        // header
        const head = new St.BoxLayout({style_class: 'cd-row', x_expand: true});
        head.add_child(label('Claude Code', 'cd-title', {x_expand: true}));
        this._meta = ellipsized('', 'cd-dim', Pango.EllipsizeMode.END);
        head.add_child(this._meta);
        head.add_child(iconButton('emblem-system-symbolic', () => {
            m.close(true);
            this._h.openPreferences();
        }, 'cd-settings'));
        m.addMenuItem(new StaticItem(head, 'cd-header'));

        // prompt
        if (o['show-prompt']) {
            this._entry = new St.Entry({style_class: 'cd-entry', hint_text: 'Prompt', can_focus: true, x_expand: true});
            this._entry.clutter_text.connect('activate', () => this._submit(null));
            this._entry.clutter_text.connect('key-press-event', (_a, ev) => {
                if (ev.get_key_symbol() === Clutter.KEY_Escape && this._entry.text) {
                    this._entry.text = '';
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            const row = new St.BoxLayout({style_class: 'cd-row', x_expand: true});
            row.add_child(this._entry);
            row.add_child(iconButton('go-up-symbolic', () => this._submit(null), 'cd-send'));
            m.addMenuItem(new StaticItem(row, 'cd-prompt'));
        }

        // limits
        if (o['show-limits']) {
            this._five = new LimitRow('5h');
            this._seven = new LimitRow('7d');
            this._fiveItem = new StaticItem(this._five.box, 'cd-limits');
            this._sevenItem = new StaticItem(this._seven.box, 'cd-limits');
            m.addMenuItem(this._fiveItem);
            m.addMenuItem(this._sevenItem);
            const off = new St.BoxLayout({style_class: 'cd-row', x_expand: true});
            off.add_child(label('Limits not connected', 'cd-dim', {x_expand: true}));
            const setup = new St.Button({style_class: 'cd-link-button', label: 'Set up', can_focus: true});
            setup.connect('clicked', () => {
                m.close(true);
                Gio.AppInfo.launch_default_for_uri(LIMITS_HELP_URL, global.create_app_launch_context(0, -1));
            });
            off.add_child(setup);
            this._limitsOffItem = new StaticItem(off, 'cd-limits-off');
            this._limitsOffItem.visible = false;
            m.addMenuItem(this._limitsOffItem);
        }

        // today
        if (o['show-today']) {
            m.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const today = sectionTitle('TODAY');
            this._todaySummary = today.right;
            m.addMenuItem(new StaticItem(today.row, 'cd-today-title'));
            const tiles = new St.BoxLayout({style_class: 'cd-tiles', x_expand: true});
            tiles.layout_manager.homogeneous = true;
            this._tiles = {
                prompts: new Tile('prompts'),
                messages: new Tile('messages'),
                tools: new Tile('tool calls'),
                out: new Tile('output'),
            };
            for (const t of Object.values(this._tiles)) tiles.add_child(t.box);
            m.addMenuItem(new StaticItem(tiles, 'cd-today'));
        }

        // chart
        if (o['show-chart']) {
            if (!o['show-today']) m.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._metricBtn = new St.Button({style_class: 'cd-metric-button', label: '',
                x_align: Clutter.ActorAlign.START, can_focus: true});
            this._metricBtn.connect('clicked', () => {
                this._metric = METRICS[(METRICS.indexOf(this._metric) + 1) % METRICS.length];
                this._syncMetricLabel();
                if (this._data) this._updateChart(this._data);
                this._h.setQuiet('chart-metric', this._metric);
            });
            this._syncMetricLabel();
            const chartHead = sectionTitle(this._metricBtn);
            this._chartInfo = chartHead.right;
            m.addMenuItem(new StaticItem(chartHead.row, 'cd-chart-title'));
            const chart = new St.BoxLayout({style_class: 'cd-chart', x_expand: true});
            this._bars = [];
            for (let i = 0; i < 14; i++) {
                const bar = new St.Widget({style_class: 'cd-chart-bar empty', x_expand: true,
                    y_align: Clutter.ActorAlign.END});
                bar.set_style('height: 2px;');
                const col = new St.Bin({style_class: 'cd-chart-col', child: bar, x_expand: true, y_expand: true,
                    reactive: true, track_hover: true});
                col.connect('notify::hover', () => this._hoverDay(col.hover ? i : null));
                chart.add_child(col);
                this._bars.push(bar);
            }
            m.addMenuItem(new StaticItem(chart, 'cd-chart-item'));
        }

        // sessions
        if (o['show-sessions']) {
            this._sessSep = new PopupMenu.PopupSeparatorMenuItem();
            m.addMenuItem(this._sessSep);
            this._sessTitle = sectionTitle('SESSIONS');
            this._sessTitleItem = new StaticItem(this._sessTitle.row, 'cd-sessions-title');
            m.addMenuItem(this._sessTitleItem);
            this._sessions = new PopupMenu.PopupMenuSection();
            m.addMenuItem(this._sessions);
            this._sessKey = null;
        }

        m.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // built-in actions
        this._action('New session', () => this._submit(null), fmtAccel(this._ext.settings.get_strv('new-session')[0]));
        this._action('Continue last', () => this._h.launch(null, ['--continue']));
        this._action('Resume…', () => this._h.launch(null, ['--resume']));
        if (o['show-projects']) {
            this._projects = new InstantSubMenuItem('Projects', false);
            m.addMenuItem(this._projects);
            this._projKey = null;
        }

        // user actions from actions.json
        this._userSep = new PopupMenu.PopupSeparatorMenuItem();
        m.addMenuItem(this._userSep);
        this._userActions = new PopupMenu.PopupMenuSection();
        m.addMenuItem(this._userActions);
        this.setUserActions();
    }

    _syncMetricLabel() {
        this._metricBtn.label = `14 DAYS · ${METRIC_LABEL[this._metric] ?? 'MESSAGES'}`;
    }

    _action(text, cb, shortcut) {
        const item = new PopupMenu.PopupMenuItem(text);
        if (shortcut)
            item.add_child(label(shortcut, 'cd-shortcut', {x_expand: true, x_align: Clutter.ActorAlign.END}));
        item.connect('activate', cb);
        this.menu.addMenuItem(item);
        return item;
    }

    get promptText() {
        return this._entry?.text.trim() ?? '';
    }

    // Launch with the typed prompt (if any) in dir (null: default directory).
    _submit(dir) {
        this._h.launch(dir, [], this.promptText);
        if (this._entry) this._entry.text = '';
        this.menu.close(true);
    }

    setUserActions() {
        if (!this._userActions) return;
        const cfg = this._h.userConfig;
        this._userActions.removeAll();
        const errors = [cfg?.actionsError, cfg?.styleError && `style.css: ${cfg.styleError}`].filter(Boolean);
        const actions = this._opt['show-actions'] ? cfg?.actions ?? [] : [];
        for (const a of actions) {
            const item = a.icon
                ? new PopupMenu.PopupImageMenuItem(a.label, a.icon)
                : new PopupMenu.PopupMenuItem(a.label);
            item.add_style_class_name('cd-user-action');
            item.connect('activate', () => {
                this._h.runAction(a, this.promptText);
                if (this._entry && a.command.includes('{prompt}')) this._entry.text = '';
            });
            this._userActions.addMenuItem(item);
        }
        for (const err of errors)
            this._userActions.addMenuItem(new StaticItem(ellipsized(err, 'cd-error', Pango.EllipsizeMode.END)));
        this._userSep.visible = actions.length + errors.length > 0;
    }

    _startTicker() {
        this._stopTicker();
        this._ticker = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 20, () => {
            for (const it of this._sessionItems) it.tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTicker() {
        if (this._ticker) GLib.source_remove(this._ticker);
        this._ticker = null;
    }

    _hoverDay(i) {
        this._hovered = i;
        this._bars.forEach((b, j) => (j === i ? b.add_style_pseudo_class('hover') : b.remove_style_pseudo_class('hover')));
        this._syncChartInfo();
    }

    _syncChartInfo() {
        const d = this._data;
        if (!d || !this._chartInfo) return;
        const key = this._metric;
        const day = this._hovered !== null && this._hovered !== undefined ? d.days[this._hovered] : null;
        if (day) {
            this._chartInfo.text = `${fmtDay(day.date)} · ${fmtNum(day[key] ?? 0)}`;
        } else {
            const sum = d.days.reduce((a, x) => a + (x[key] ?? 0), 0);
            this._chartInfo.text = `avg ${fmtNum(Math.round(sum / Math.max(1, d.days.length)))}/day`;
        }
    }

    _updateChart(d) {
        const key = this._metric;
        const max = Math.max(1, ...d.days.map(x => x[key] ?? 0));
        d.days.forEach((day, i) => {
            const bar = this._bars[i];
            if (!bar) return;
            const v = day[key] ?? 0;
            const h = v ? Math.max(3, Math.round(CHART_PX * v / max)) : 2;
            bar.set_style(`height: ${h}px;`);
            bar.style_class = `cd-chart-bar${i === d.days.length - 1 ? ' today' : ''}${v ? '' : ' empty'}`;
        });
        this._syncChartInfo();
    }

    update(d) {
        this._data = d;
        this._setBusy(d.sessions.some(s => s.status === 'busy'));

        this._meta.text = d.model ?? '';

        if (this._five) {
            const on = Boolean(d.limits);
            this._fiveItem.visible = this._sevenItem.visible = on;
            this._limitsOffItem.visible = !on;
            this._five.update(d.limits?.five);
            this._seven.update(d.limits?.seven);
        }

        if (this._tiles) {
            const t = d.today;
            this._tiles.prompts.value.text = fmtNum(t.prompts);
            this._tiles.messages.value.text = fmtNum(t.messages);
            this._tiles.tools.value.text = fmtNum(t.tools);
            this._tiles.out.value.text = fmtNum(t.out);
            this._todaySummary.text = `${t.sessions} sessions · ${fmtNum(t.tokens)} tokens`;
        }

        if (this._bars) this._updateChart(d);

        if (this._sessions) {
            const key = JSON.stringify(d.sessions.map(s => [s.id, s.status, s.name, s.updated]));
            if (key !== this._sessKey) {
                this._sessKey = key;
                this._sessions.removeAll();
                this._sessionItems = d.sessions.map(s => new SessionItem(s, x => this._h.focusSession(x)));
                for (const it of this._sessionItems) this._sessions.addMenuItem(it);
            }
            this._sessSep.visible = this._sessTitleItem.visible = d.sessions.length > 0;
            const nBusy = d.sessions.filter(s => s.status === 'busy').length;
            this._sessTitle.right.text = nBusy ? `${nBusy} working` : '';
        }

        if (this._projects) {
            const list = d.projects.slice(0, this._projectsCount);
            const pkey = JSON.stringify(list);
            if (pkey !== this._projKey) {
                this._projKey = pkey;
                this._projects.menu.removeAll();
                for (const p of list) {
                    this._projects.menu.addMenuItem(new ProjectItem(p,
                        x => this._submit(x),
                        x => {
                            this.menu.close(true);
                            this._h.launch(x, ['--continue']);
                        }));
                }
                this._projects.visible = list.length > 0;
            }
        }
    }

    _setBusy(busy) {
        if (busy === this._busy) return;
        this._busy = busy;
        this._icon.remove_all_transitions();
        this._icon[busy ? 'add_style_class_name' : 'remove_style_class_name']('busy');
        if (busy && this._opt['pulse-when-busy']) {
            this._icon.ease({
                opacity: 110,
                duration: 1100,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                repeatCount: -1,
                autoReverse: true,
            });
        } else {
            this._icon.ease({opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }

    _syncIconColor() {
        let color = null;
        if (this._colorMode === 'claude') color = ORANGE;
        else if (this._colorMode === 'custom') color = this._customColor;
        // 'panel' mode: no inline color, the stylesheet tints .busy with the accent color
        this._icon.set_style(`padding: 0; margin: 0;${color ? ` color: ${color};` : ''}`);
    }

    _onDestroy() {
        this._stopTicker();
        if (this._focusId) GLib.source_remove(this._focusId);
        this._focusId = null;
        super._onDestroy();
    }
});
