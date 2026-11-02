// SPDX-License-Identifier: GPL-2.0-or-later
//
// Builds a fake home with a Claude Code data directory for tests and screenshots.
// Usage: gjs -m make-fixture.js <home> <busy-pid> <idle-pid>
import GLib from 'gi://GLib';
import System from 'system';

const [home, busyPid, idlePid] = ARGV;
if (!home || !busyPid || !idlePid) {
    printerr('usage: make-fixture.js <home> <busy-pid> <idle-pid>');
    System.exit(2);
}

const claude = `${home}/.claude`;
const enc = new TextEncoder();
const write = (path, text) => {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, enc.encode(text));
};
const jsonl = rows => `${rows.map(r => JSON.stringify(r)).join('\n')}\n`;
const encodeProject = cwd => cwd.replace(/[^A-Za-z0-9-]/g, '-');

const DAY = 86400000;
const now = Date.now();
const isoDay = t => {
    const d = new Date(t);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const projects = ['code/shop-api', 'code/blog', 'code/mobile-app', 'dotfiles', 'code/infra'];
for (const p of projects) GLib.mkdir_with_parents(`${home}/${p}`, 0o755);

// Older days come from Claude Code's own stats cache.
const activity = [];
const shape = [52, 31, 0, 0, 64, 88, 47, 70, 95, 0];
for (let i = 13; i >= 4; i--) {
    const n = shape[13 - i] * 45;
    activity.push({date: isoDay(now - i * DAY), messageCount: n, sessionCount: Math.round(n / 260),
        toolCallCount: Math.round(n * 0.24)});
}
write(`${claude}/stats-cache.json`, JSON.stringify({
    version: 5, lastComputedDate: isoDay(now - 4 * DAY), dailyActivity: activity,
    totalSessions: 412, totalMessages: 98314,
}));

// The last four days are scanned from transcripts.
function transcript(sessionId, cwd, title, days, perDay) {
    const rows = [{type: 'ai-title', aiTitle: title, sessionId}];
    let n = 0;
    for (const d of days) {
        const base = now - d * DAY - 3 * 3600000;
        for (let i = 0; i < perDay; i++) {
            const t = new Date(base + i * 20000).toISOString();
            rows.push({type: 'user', timestamp: t, sessionId, cwd, message: {role: 'user', content: 'x'}});
            const id = `msg_${sessionId}_${n++}`;
            const usage = {input_tokens: 3, output_tokens: 410, cache_creation_input_tokens: 1800,
                cache_read_input_tokens: 42000};
            rows.push({type: 'assistant', timestamp: t, sessionId, cwd,
                message: {id, usage, content: [{type: 'text', text: 'ok'}, {type: 'tool_use', name: 'Read'}]}});
            rows.push({type: 'assistant', timestamp: t, sessionId, cwd,
                message: {id, usage, content: [{type: 'tool_use', name: 'Edit'}]}});
        }
    }
    write(`${claude}/projects/${encodeProject(cwd)}/${sessionId}.jsonl`, jsonl(rows));
}

const sessions = [
    {id: '7f1c2a90-0000-4000-8000-000000000001', pid: busyPid, cwd: `${home}/code/shop-api`,
        title: 'Add webhook retries to checkout', status: 'busy', days: [0, 1], perDay: 650},
    {id: '7f1c2a90-0000-4000-8000-000000000002', pid: idlePid, cwd: `${home}/code/blog`,
        title: 'Fix RSS feed dates', status: 'idle', days: [0, 2, 3], perDay: 420},
];
for (const s of sessions) {
    transcript(s.id, s.cwd, s.title, s.days, s.perDay);
    write(`${claude}/sessions/${s.pid}.json`, JSON.stringify({
        pid: Number(s.pid), sessionId: s.id, cwd: s.cwd, startedAt: now - 3600000, kind: 'interactive',
        status: s.status, statusUpdatedAt: now - (s.status === 'busy' ? 40000 : 720000),
    }));
}
transcript('7f1c2a90-0000-4000-8000-000000000003', `${home}/code/mobile-app`, 'Dark mode', [1, 3], 380);

const history = [];
projects.forEach((p, i) => {
    for (let k = 0; k < 6; k++) {
        history.push({display: 'prompt', timestamp: now - i * 3600000 - k * DAY / 3, project: `${home}/${p}`,
            sessionId: `h-${i}-${k % 3}`});
    }
});
history.sort((a, b) => a.timestamp - b.timestamp);
write(`${claude}/history.jsonl`, jsonl(history));

// Status line payload with rate limits, as written by tools/statusline-tee.sh.
const cache = GLib.getenv('XDG_CACHE_HOME') || `${home}/.cache`;
write(`${cache}/claude-deck/status.json`, JSON.stringify({
    session_id: sessions[0].id, session_name: sessions[0].title,
    model: {id: 'claude-opus', display_name: 'Opus'}, version: '2.1.0',
    rate_limits: {
        five_hour: {used_percentage: 34, resets_at: Math.floor(now / 1000) + 2 * 3600 + 900},
        seven_day: {used_percentage: 41, resets_at: Math.floor(now / 1000) + 4 * 86400},
    },
}));
