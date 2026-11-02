// SPDX-License-Identifier: GPL-2.0-or-later
//
// Finds the terminal window that hosts a Claude Code process by walking up its parent
// processes until one of them owns a window.
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

const decoder = new TextDecoder();

async function parentPid(pid, cancellable) {
    try {
        const [bytes] = await Gio.File.new_for_path(`/proc/${pid}/stat`).load_contents_async(cancellable);
        const s = decoder.decode(bytes);
        // fields after the command name: "state ppid ..."; the name itself may contain spaces
        return parseInt(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]) || 0;
    } catch {
        return 0;
    }
}

export async function findWindow(pid, cancellable = null) {
    const byPid = new Map();
    for (const actor of global.get_window_actors()) {
        const w = actor.meta_window;
        if (w.get_window_type() === Meta.WindowType.NORMAL) byPid.set(w.get_pid(), w);
    }
    for (let p = pid, depth = 0; p > 1 && depth < 12; depth++) {
        if (byPid.has(p)) return byPid.get(p);
        p = await parentPid(p, cancellable);
    }
    return null;
}
