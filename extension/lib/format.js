// SPDX-License-Identifier: GPL-2.0-or-later
import GLib from 'gi://GLib';

const HOME = GLib.get_home_dir();

export function fmtNum(n) {
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
    return `${n}`;
}

export function tildify(path) {
    if (path === HOME) return '~';
    return path.startsWith(`${HOME}/`) ? `~${path.slice(HOME.length)}` : path;
}

export function expandHome(path) {
    if (path === '~') return HOME;
    return path.startsWith('~/') ? `${HOME}${path.slice(1)}` : path;
}

export const level = pct => (pct >= 80 ? 'crit' : pct >= 50 ? 'warn' : '');

export function fmtAgo(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
}

export function fmtReset(ts) {
    if (!ts) return '';
    const s = ts - Date.now() / 1000;
    if (s <= 0) return '';
    if (s < 86400) {
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
        return h ? `${h}h ${m}m` : `${m}m`;
    }
    return GLib.DateTime.new_from_unix_local(ts).format('%a %H:%M');
}

export function fmtDay(isoDay) {
    const [y, m, d] = isoDay.split('-').map(Number);
    return GLib.DateTime.new_local(y, m, d, 12, 0, 0).format('%a %e %b').replace(/\s+/g, ' ');
}

export function fmtAccel(accel) {
    if (!accel) return '';
    return accel.replace(/<Primary>|<Control>/g, 'Ctrl+').replace(/<(\w+)>/g, '$1+')
        .replace(/\+(\w)$/, (_, k) => `+${k.toUpperCase()}`);
}
