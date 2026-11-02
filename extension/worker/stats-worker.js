// SPDX-License-Identifier: GPL-2.0-or-later
//
// Collects Claude Code statistics and prints them as JSON on stdout.
// Runs as a separate `gjs -m` process so parsing transcripts never blocks GNOME Shell.
//
// Sources (all local, read-only):
//   ~/.claude/sessions/*.json     live sessions (pid, cwd, busy/idle)
//   ~/.claude/projects/**/*.jsonl transcripts (messages, tool calls, tokens), scanned incrementally
//   ~/.claude/stats-cache.json    Claude Code's own daily aggregates for older days
//   ~/.claude/history.jsonl       prompts per day and recently used project directories
//   ~/.cache/claude-deck/status.json  last status line payload (model, rate limits), see tools/statusline-tee.sh

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const DAYS = 14;
const COUNTED = new Set(['user', 'assistant', 'attachment', 'system']);
const HOME = GLib.get_home_dir();
const CLAUDE = GLib.getenv('CLAUDE_CONFIG_DIR') || GLib.build_filenamev([HOME, '.claude']);
const CACHE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-deck']);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes) : null;
    } catch {
        return null;
    }
}

function loadJson(path, fallback = null) {
    const text = readText(path);
    if (text === null) return fallback;
    try {
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}

function writeJsonAtomic(path, data) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, encoder.encode(JSON.stringify(data)));
}

function isoDay(date) {
    const p = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function localDate(ts) {
    if (ts === null || ts === undefined || ts === '') return null;
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : isoDay(d);
}

function addDays(day, n) {
    const [y, m, d] = day.split('-').map(Number);
    return isoDay(new Date(y, m - 1, d + n));
}

function fileInfo(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info('standard::size,time::modified',
            Gio.FileQueryInfoFlags.NONE, null);
        return {size: info.get_size(), mtime: info.get_modification_date_time().to_unix_usec() / 1e6};
    } catch {
        return null;
    }
}

function listDir(path) {
    try {
        const en = Gio.File.new_for_path(path).enumerate_children('standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE, null);
        const out = [];
        let info;
        while ((info = en.next_file(null)))
            out.push({name: info.get_name(), dir: info.get_file_type() === Gio.FileType.DIRECTORY});
        en.close(null);
        return out;
    } catch {
        return [];
    }
}

function* walkJsonl(dir) {
    for (const e of listDir(dir)) {
        const p = GLib.build_filenamev([dir, e.name]);
        if (e.dir) yield* walkJsonl(p);
        else if (e.name.endsWith('.jsonl')) yield p;
    }
}

function pidAlive(pid) {
    return pid > 0 && GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS);
}

function encodeProject(cwd) {
    return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}

// Last ai-title in a transcript, reading only its tail.
function tailTitle(path) {
    const info = fileInfo(path);
    if (!info) return null;
    for (const chunk of [262144, 4194304]) {
        let data;
        try {
            const stream = Gio.File.new_for_path(path).read(null);
            stream.seek(Math.max(0, info.size - chunk), GLib.SeekType.SET, null);
            const bytes = stream.read_bytes(chunk, null);
            stream.close(null);
            data = decoder.decode(bytes.toArray());
        } catch {
            return null;
        }
        const lines = data.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i].includes('"ai-title"')) continue;
            try {
                const d = JSON.parse(lines[i]);
                const t = d.aiTitle || d.title;
                if (t) return t;
            } catch {}
        }
        if (chunk >= info.size) break;
    }
    return null;
}

function sessions(status) {
    const dir = GLib.build_filenamev([CLAUDE, 'sessions']);
    const out = [];
    for (const e of listDir(dir)) {
        if (!e.name.endsWith('.json')) continue;
        const d = loadJson(GLib.build_filenamev([dir, e.name]));
        if (!d || !pidAlive(Number(d.pid) || 0)) continue;
        const sid = d.sessionId;
        let title = null;
        if (status && status.session_id === sid) title = status.session_name;
        if (!title && sid) {
            title = tailTitle(GLib.build_filenamev([CLAUDE, 'projects', encodeProject(d.cwd ?? ''),
                `${sid}.jsonl`]));
        }
        out.push({
            pid: d.pid,
            id: sid,
            name: title || d.name || '',
            cwd: d.cwd ?? '',
            status: d.status ?? '',
            kind: d.kind ?? '',
            started: d.startedAt ?? 0,
            updated: d.statusUpdatedAt || d.updatedAt || 0,
        });
    }
    out.sort((a, b) => a.started - b.started);
    return out;
}

const emptyAgg = () => ({messages: 0, tools: 0, out: 0, tokens: 0});

// Incrementally aggregate per-day counts for one transcript, continuing from the cached offset.
function scanFile(path, entry, since) {
    const info = fileInfo(path);
    if (!info) return entry;
    if (entry && entry.size === info.size && entry.mtime === info.mtime) return entry;
    if (!entry || info.size < (entry.offset ?? 0)) entry = {offset: 0, last_id: null, dates: {}};

    let bytes;
    try {
        const stream = Gio.File.new_for_path(path).read(null);
        stream.seek(entry.offset, GLib.SeekType.SET, null);
        bytes = stream.read_bytes(info.size - entry.offset, null).toArray();
        stream.close(null);
    } catch {
        return entry;
    }
    const end = bytes.lastIndexOf(10) + 1; // only complete lines
    const text = decoder.decode(bytes.subarray(0, end));
    let lastId = entry.last_id;

    for (const raw of text.split('\n')) {
        if (!raw) continue;
        let d;
        try {
            d = JSON.parse(raw);
        } catch {
            continue;
        }
        if (!COUNTED.has(d.type)) continue;
        const day = localDate(d.timestamp);
        if (!day || day < since) continue;
        const agg = entry.dates[day] ??= emptyAgg();
        agg.messages++;
        if (d.type !== 'assistant') continue;
        const msg = d.message ?? {};
        if (Array.isArray(msg.content))
            agg.tools += msg.content.filter(c => c && c.type === 'tool_use').length;
        // one API response is split across several transcript lines with the same id
        if (msg.id && msg.id !== lastId) {
            lastId = msg.id;
            const u = msg.usage ?? {};
            agg.out += u.output_tokens || 0;
            agg.tokens += (u.input_tokens || 0) + (u.output_tokens || 0) +
                (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        }
    }
    Object.assign(entry, {offset: entry.offset + end, last_id: lastId, size: info.size, mtime: info.mtime});
    return entry;
}

function liveDays(since) {
    const cachePath = GLib.build_filenamev([CACHE, 'scan.json']);
    let cache = loadJson(cachePath, {});
    if (cache.since !== since) cache = {since, files: {}};
    const [y, m, d] = since.split('-').map(Number);
    const cutoff = new Date(y, m - 1, d).getTime() / 1000;
    const seen = new Set();

    for (const p of walkJsonl(GLib.build_filenamev([CLAUDE, 'projects']))) {
        const info = fileInfo(p);
        if (!info || info.mtime < cutoff) continue;
        seen.add(p);
        cache.files[p] = scanFile(p, cache.files[p], since);
    }
    for (const k of Object.keys(cache.files))
        if (!seen.has(k)) delete cache.files[k];
    writeJsonAtomic(cachePath, cache);

    const days = {};
    for (const e of Object.values(cache.files)) {
        for (const [day, a] of Object.entries(e.dates)) {
            const t = days[day] ??= emptyAgg();
            for (const k of Object.keys(t)) t[k] += a[k];
        }
    }
    return days;
}

function history(since) {
    const prompts = {}, sess = {}, projects = new Map();
    const text = readText(GLib.build_filenamev([CLAUDE, 'history.jsonl'])) ?? '';
    for (const line of text.split('\n')) {
        if (!line) continue;
        let d;
        try {
            d = JSON.parse(line);
        } catch {
            continue;
        }
        const ts = d.timestamp ?? 0;
        if (d.project) projects.set(d.project, Math.max(projects.get(d.project) ?? 0, ts));
        const day = localDate(ts);
        if (day && day >= since) {
            prompts[day] = (prompts[day] ?? 0) + 1;
            (sess[day] ??= new Set()).add(d.sessionId);
        }
    }
    const recent = [...projects.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0])
        .filter(p => p !== HOME && GLib.file_test(p, GLib.FileTest.IS_DIR)).slice(0, 20);
    const sessCount = Object.fromEntries(Object.entries(sess).map(([k, v]) => [k, v.size]));
    return {prompts, sessions: sessCount, recent};
}

// Rate limits from the status line payload. Sessions that have not talked to the API yet send
// no limits, so the last known values are kept in limits.json.
function limits(status, now) {
    const statusPath = GLib.build_filenamev([CACHE, 'status.json']);
    const limitsPath = GLib.build_filenamev([CACHE, 'limits.json']);
    let rl = status?.rate_limits;
    if (rl?.five_hour) {
        const saved = loadJson(limitsPath);
        if (JSON.stringify(saved?.rate_limits) !== JSON.stringify(rl))
            writeJsonAtomic(limitsPath, {rate_limits: rl});
    } else {
        rl = loadJson(limitsPath)?.rate_limits;
    }
    if (!rl) return null;
    const out = {};
    for (const [key, name] of [['five_hour', 'five'], ['seven_day', 'seven']]) {
        const r = rl[key] ?? {};
        let pct = r.used_percentage ?? null;
        let reset = r.resets_at || 0;
        if (pct !== null && reset && reset < now) {
            pct = 0;
            reset = 0;
        }
        out[name] = {pct, reset};
    }
    out.updated = fileInfo(statusPath)?.mtime ?? 0;
    return out;
}

function main() {
    const now = Date.now() / 1000;
    const today = isoDay(new Date());
    const status = loadJson(GLib.build_filenamev([CACHE, 'status.json']));
    const stats = loadJson(GLib.build_filenamev([CLAUDE, 'stats-cache.json']), {}) ?? {};

    const firstDay = addDays(today, -(DAYS - 1));
    const computed = stats.lastComputedDate;
    let liveSince = computed ? addDays(computed, 1) : firstDay;
    if (liveSince < firstDay) liveSince = firstDay;
    if (liveSince > today) liveSince = today;

    const live = liveDays(liveSince);
    const hist = history(firstDay);
    const activity = Object.fromEntries((stats.dailyActivity ?? []).map(a => [a.date, a]));

    const days = [];
    for (let i = DAYS - 1; i >= 0; i--) {
        const day = addDays(today, -i);
        if (day >= liveSince) {
            const l = live[day] ?? {};
            days.push({date: day, messages: l.messages ?? 0, tools: l.tools ?? 0,
                sessions: hist.sessions[day] ?? 0});
        } else {
            const a = activity[day] ?? {};
            days.push({date: day, messages: a.messageCount ?? 0, tools: a.toolCallCount ?? 0,
                sessions: a.sessionCount ?? 0});
        }
    }

    const t = live[today] ?? {};
    const liveTail = days.filter(x => x.date >= liveSince);
    const out = {
        now,
        model: status?.model?.display_name ?? null,
        version: status?.version ?? null,
        limits: limits(status, now),
        sessions: sessions(status),
        today: {
            prompts: hist.prompts[today] ?? 0,
            sessions: hist.sessions[today] ?? 0,
            messages: t.messages ?? 0,
            tools: t.tools ?? 0,
            out: t.out ?? 0,
            tokens: t.tokens ?? 0,
        },
        days,
        totals: {
            sessions: (stats.totalSessions ?? 0) + liveTail.reduce((a, x) => a + x.sessions, 0),
            messages: (stats.totalMessages ?? 0) + liveTail.reduce((a, x) => a + x.messages, 0),
            since: stats.dailyActivity?.[0]?.date ?? null,
        },
        projects: hist.recent,
    };
    print(JSON.stringify(out));
}

try {
    main();
} catch (e) {
    printerr(`claude-deck worker: ${e.message}\n${e.stack}`);
    System.exit(1);
}
