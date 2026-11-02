// SPDX-License-Identifier: GPL-2.0-or-later
//
// Runs claude (or a custom action) in a terminal window.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {expandHome} from './format.js';

// How each terminal runs a command given as trailing arguments.
const TERMINALS = {
    'xdg-terminal-exec': ['xdg-terminal-exec'],
    'ptyxis': ['ptyxis', '--new-window', '--'],
    'kgx': ['kgx', '--'],
    'gnome-terminal': ['gnome-terminal', '--'],
    'kitty': ['kitty'],
    'alacritty': ['alacritty', '-e'],
    'foot': ['foot'],
    'wezterm': ['wezterm', 'start', '--'],
    'konsole': ['konsole', '-e'],
    'xterm': ['xterm', '-e'],
};

export const KNOWN_TERMINALS = Object.keys(TERMINALS);

export function detectTerminal() {
    return KNOWN_TERMINALS.find(t => GLib.find_program_in_path(t)) ?? null;
}

function terminalPrefix(setting) {
    const value = (setting || 'auto').trim();
    if (value === 'auto') {
        const found = detectTerminal();
        if (!found) throw new Error('No terminal found. Set one in the extension preferences.');
        return TERMINALS[found];
    }
    if (TERMINALS[value]) return TERMINALS[value];
    // anything else is a command prefix, e.g. "wezterm start --"
    return GLib.shell_parse_argv(value)[1];
}

export function userShell(setting) {
    return setting?.trim() || GLib.getenv('SHELL') || '/bin/sh';
}

const quote = argv => argv.map(a => GLib.shell_quote(a)).join(' ');

/**
 * Open a terminal in `cwd` running `script` in an interactive shell, then keep the shell open.
 *
 * @param {object} opts
 * @param {string} opts.cwd working directory
 * @param {string} opts.script shell command line
 * @param {string} opts.terminal terminal setting
 * @param {string} opts.shell shell setting
 */
export function runInTerminal({cwd, script, terminal, shell}) {
    const sh = userShell(shell);
    const dir = expandHome(cwd || GLib.get_home_dir());
    const line = `cd ${GLib.shell_quote(dir)} && ${script}; exec ${GLib.shell_quote(sh)}`;
    const argv = [...terminalPrefix(terminal), sh, '-ic', line];
    // Gio.AppInfo keeps startup notification and focus handling; '%' must be doubled because
    // AppInfo treats %x as desktop-entry field codes.
    const app = Gio.AppInfo.create_from_commandline(
        argv.map(a => GLib.shell_quote(a).replace(/%/g, '%%')).join(' '),
        'Claude Code', Gio.AppInfoCreateFlags.NONE);
    app.launch([], global.create_app_launch_context(0, -1));
}

/**
 * Build the claude command line.
 *
 * @param {string} extraArgs user setting with extra arguments
 * @param {string[]} args arguments such as --continue
 * @returns {string}
 */
export function claudeCommand(extraArgs, args = []) {
    const extra = extraArgs?.trim() ? GLib.shell_parse_argv(extraArgs)[1] : [];
    const argv = ['claude', ...extra, ...args];
    return quote(argv);
}

/**
 * Run a command in the background (no terminal).
 *
 * @param {string} cwd working directory
 * @param {string} command shell command line
 */
export function runDetached(cwd, command) {
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
    launcher.set_cwd(expandHome(cwd || GLib.get_home_dir()));
    launcher.spawnv(['/bin/sh', '-c', command]);
}
