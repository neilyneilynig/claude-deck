#!/usr/bin/env node
// Claude Deck — a cute stream deck for your Claude Code sessions.
// Zero dependencies. Reads ~/.claude locally, serves a PWA to your phone/iPad on the LAN.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, exec, spawn } = require('child_process');

const HOME = os.homedir();
const CLAUDE = path.join(HOME, '.claude');
const PROJECTS = path.join(CLAUDE, 'projects');
const SESSIONS = path.join(CLAUDE, 'sessions');
const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');

// ---------- config ----------
function defaultConfig() {
  return {
    port: 4747,
    token: crypto.randomBytes(12).toString('hex'),
    claudeCommand: 'claude',
    // Rough budget for the rolling 5h window, in API-equivalent dollars.
    // Anthropic doesn't publish exact plan limits; tune this until the ring matches how fast you hit your limit.
    blockBudgetUsd: 40,
    // $ per million tokens, used for the API-equivalent estimate. Edit as needed.
    pricing: {
      opus: { in: 5, out: 25 },
      sonnet: { in: 3, out: 15 },
      haiku: { in: 1, out: 5 },
      fable: { in: 5, out: 25 },
    },
    projectRoots: [path.join(HOME, 'Projects')],
    // Push notifications through ntfy.sh. Off until you switch it on from the app's settings.
    ntfy: { enabled: false, topic: '', server: 'https://ntfy.sh' },
    pet: { name: 'Sparky', color: 'clay' },
    highScore: 0,
    macros: [
      { emoji: '🧪', label: 'Run tests', text: 'run the tests and fix anything that fails' },
      { emoji: '📦', label: 'Commit', text: 'commit what you have with a good message' },
      { emoji: '🔍', label: 'Review', text: 'review your changes so far for bugs before we move on' },
      { emoji: '🧭', label: 'Status?', text: 'quick status: what is done, what is left, anything blocking?' },
      { emoji: '🧹', label: 'Tidy', text: 'clean up: remove debug code and dead code you added' },
      { emoji: '💡', label: 'Explain', text: 'explain what you just changed in 3 short bullets' },
    ],
    deck: [
      { id: 'new', label: 'New Claude', emoji: '✨', type: 'new-session' },
      { id: 'shot', label: 'Screenshot', emoji: '📸', cmd: 'omarchy-capture-screenshot' },
      { id: 'mute', label: 'Mute', emoji: '🔇', cmd: 'wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle' },
      { id: 'night', label: 'Night light', emoji: '🌙', cmd: 'omarchy-toggle-nightlight' },
      { id: 'dnd', label: 'Do not disturb', emoji: '🤫', cmd: 'omarchy-toggle-notification-silencing' },
      { id: 'idle', label: 'Stay awake', emoji: '☕', cmd: 'omarchy-toggle-idle' },
      { id: 'browser', label: 'Browser', emoji: '🌐', cmd: 'omarchy-launch-browser' },
      { id: 'lock', label: 'Lock', emoji: '🔒', cmd: 'omarchy-system-lock' },
    ],
  };
}
function loadConfig() {
  let cfg = defaultConfig();
  if (fs.existsSync(CONFIG_PATH)) {
    try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; }
    catch (e) { console.error('config.json is invalid, using defaults:', e.message); return cfg; }
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}
const config = loadConfig();
const saveConfig = () => fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

// ---------- transcript scanning (incremental) ----------
const WINDOW_MS = 8 * 24 * 3600 * 1000;
const files = new Map();   // path -> { offset, rest, info }
const usage = new Map();   // dedupe key -> { ts, model, in, out, cw, cr, proj } (last 8 days)
const seenKeys = new Set(); // every message ever, for the all-time daily totals
const daily = new Map();   // 'YYYY-MM-DD' -> { out, cost, msgs }

function family(model = '') {
  const m = model.toLowerCase();
  for (const f of ['opus', 'sonnet', 'haiku', 'fable']) if (m.includes(f)) return f;
  return 'opus';
}
function costOf(u) {
  const p = config.pricing[family(u.model)] || config.pricing.opus;
  return (u.in * p.in + u.out * p.out + u.cw * p.in * 1.25 + u.cr * p.in * 0.1) / 1e6;
}
const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function describeTool(c) {
  const i = c.input || {};
  const short = s => String(s || '').split('\n')[0].slice(0, 70);
  switch (c.name) {
    case 'Bash': return { icon: '⌨️', text: short(i.description || i.command) };
    case 'Edit': case 'Write': case 'MultiEdit': return { icon: '✏️', text: `${c.name} ${path.basename(i.file_path || '')}` };
    case 'Read': return { icon: '👓', text: `Read ${path.basename(i.file_path || '')}` };
    case 'Grep': case 'Glob': return { icon: '🔎', text: `${c.name} ${short(i.pattern)}` };
    case 'WebSearch': case 'WebFetch': return { icon: '🌐', text: short(i.query || i.url) };
    case 'Agent': case 'Task': return { icon: '🤖', text: short(i.description || 'subagent') };
    case 'TodoWrite': return { icon: '📝', text: 'Updating todos' };
    case 'AskUserQuestion': return { icon: '🙋', text: short((i.questions || [])[0]?.question || 'Has a question') };
    case 'ExitPlanMode': return { icon: '🗺️', text: 'Plan ready for review' };
    default: return { icon: '🔧', text: c.name.replace(/^mcp__[^_]+__/, '') };
  }
}
const TOOL_KINDS = {
  Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Bash: 'bash', Read: 'read',
  Grep: 'search', Glob: 'search', WebSearch: 'web', WebFetch: 'web', Agent: 'agent', Task: 'agent',
};
function pendingOf(c, ts) {
  const p = { id: c.id, name: c.name, at: ts, ...describeTool(c) };
  if (c.name === 'AskUserQuestion') {
    p.questions = (c.input.questions || []).map(q => ({
      question: q.question, header: q.header, multi: !!q.multiSelect,
      options: (q.options || []).map(o => o.label),
    }));
  } else if (c.name === 'ExitPlanMode') {
    p.detail = String(c.input.plan || '').slice(0, 1200);
  } else if (c.name === 'Bash') {
    p.detail = String(c.input.command || '').slice(0, 600);
  } else if (c.input && c.input.file_path) {
    p.detail = c.input.file_path;
  }
  return p;
}

function ingestLine(line, info) {
  if (!line) return;
  // cheap prefilter before JSON.parse
  if (!(line.includes('"usage"') || line.includes('"ai-title"') || line.includes('"custom-title"') || line.includes('"type":"user"'))) return;
  let o; try { o = JSON.parse(line); } catch { return; }
  if (o.type === 'ai-title') { info.aiTitle = o.aiTitle; return; }
  if (o.type === 'custom-title') { info.customTitle = o.customTitle; return; }
  const ts = o.timestamp ? Date.parse(o.timestamp) : 0;
  if (o.entrypoint) info.entrypoint = o.entrypoint;
  if (o.type === 'user' && !o.isSidechain && !o.isMeta && o.message) {
    const c = o.message.content;
    if (Array.isArray(c)) {
      for (const x of c) if (x.type === 'tool_result' && info.pending && x.tool_use_id === info.pending.id) info.pending = null;
    }
    const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find(x => x.type === 'text') || {}).text : null;
    if (text && !text.startsWith('<') && !text.startsWith('[Request interrupted')) {
      info.lastPrompt = text.slice(0, 200); info.lastPromptAt = ts; info.pending = null;
      info.turns = (info.turns || 0) + 1; if (!info.firstPrompt) info.firstPrompt = text.slice(0, 200);
      if (o.cwd) info.cwd = o.cwd;
    }
    return;
  }
  if (o.type === 'assistant' && o.message && o.message.usage) {
    const m = o.message, u = m.usage;
    if (m.model === '<synthetic>') return;
    const key = `${m.id}:${o.requestId || ''}`;
    const rec = {
      ts, model: m.model || '', proj: path.basename(o.cwd || '') || '~',
      in: u.input_tokens || 0, out: u.output_tokens || 0,
      cw: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0,
    };
    if (ts && !seenKeys.has(key)) {
      seenKeys.add(key);
      info.cost = (info.cost || 0) + costOf(rec);
      const d = daily.get(dayKey(ts)) || { out: 0, cost: 0, msgs: 0 };
      d.out += rec.out; d.cost += costOf(rec); d.msgs++;
      daily.set(dayKey(ts), d);
    }
    if (ts && Date.now() - ts < WINDOW_MS) usage.set(key, rec);
    if (o.cwd && !info.cwd) info.cwd = o.cwd;
    if (!o.isSidechain) {
      info.model = m.model;
      info.lastAt = ts;
      info.context = rec.in + rec.cw + rec.cr;
      for (const c of m.content || []) {
        if (c.type === 'tool_use') {
          info.activity = describeTool(c); info.activityAt = ts; info.pending = pendingOf(c, ts);
          const kind = TOOL_KINDS[c.name] || 'other';
          const st = info.stats || (info.stats = { edit: 0, bash: 0, read: 0, search: 0, web: 0, agent: 0, other: 0 });
          if (!info.seenTools) info.seenTools = new Set();
          if (!info.seenTools.has(c.id)) {
            info.seenTools.add(c.id); st[kind]++;
            const fp = c.input && c.input.file_path;
            if (kind === 'edit' && fp) { info.files = (info.files || []).filter(f => f !== fp); info.files.push(fp); if (info.files.length > 30) info.files.shift(); }
          }
        }
        else if (c.type === 'text' && c.text.trim()) { info.lastReply = c.text.trim().slice(0, 240); info.activity = { icon: '💬', text: 'Replied' }; info.activityAt = ts; }
      }
    }
  }
}

function scanFile(file, st) {
  let f = files.get(file);
  if (!f) { f = { offset: 0, rest: '', info: {} }; files.set(file, f); }
  if (st.size < f.offset) { f.offset = 0; f.rest = ''; f.info = {}; }
  if (st.size === f.offset) return f;
  const fd = fs.openSync(file, 'r');
  try {
    const CHUNK = 4 << 20;
    const buf = Buffer.alloc(CHUNK);
    while (f.offset < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - f.offset), f.offset);
      if (n <= 0) break;
      f.offset += n;
      const lines = (f.rest + buf.toString('utf8', 0, n)).split('\n');
      f.rest = lines.pop();
      for (const l of lines) ingestLine(l, f.info);
    }
  } finally { fs.closeSync(fd); }
  return f;
}

const sessionFile = new Map(); // sessionId -> path
const fileMtime = new Map();
function scanAll() {
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch { return; }
  for (const d of dirs) {
    const dir = path.join(PROJECTS, d);
    let names; try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const p = path.join(dir, n);
      let st; try { st = fs.statSync(p); } catch { continue; }
      sessionFile.set(n.slice(0, -6), p);
      if (fileMtime.get(p) === st.mtimeMs) continue;
      fileMtime.set(p, st.mtimeMs);
      scanFile(p, st);
    }
  }
  const cutoff = Date.now() - WINDOW_MS;
  for (const [k, u] of usage) if (u.ts < cutoff) usage.delete(k);
}

// recent conversation for a session's live feed
function feed(sessionId, limit = 40) {
  const file = sessionFile.get(sessionId);
  if (!file) return [];
  const st = fs.statSync(file);
  const len = Math.min(st.size, 600_000);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(len);
  try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
  const out = [];
  const seen = new Set();
  for (const l of buf.toString('utf8').split('\n').slice(1)) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.isSidechain || o.isMeta || !o.message) continue;
    const ts = Date.parse(o.timestamp || 0);
    const c = o.message.content;
    if (o.type === 'user') {
      const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find(x => x.type === 'text') || {}).text : null;
      if (text && !text.startsWith('<')) out.push({ kind: 'you', text: text.slice(0, 600), ts });
      if (Array.isArray(c)) for (const x of c) if (x.type === 'tool_result' && x.is_error) out.push({ kind: 'err', text: String(typeof x.content === 'string' ? x.content : 'tool error').slice(0, 200), ts });
    } else if (o.type === 'assistant' && Array.isArray(c)) {
      for (const x of c) {
        const id = x.id || (o.message.id + x.type + (x.text || '').slice(0, 20));
        if (seen.has(id)) continue; seen.add(id);
        if (x.type === 'text' && x.text.trim()) out.push({ kind: 'claude', text: x.text.trim().slice(0, 900), ts });
        else if (x.type === 'tool_use') out.push({ kind: 'tool', ...describeTool(x), ts });
      }
    }
  }
  return out.slice(-limit);
}

// ---------- recent sessions you can resume ----------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function recentSessions(liveIds, limit = 12) {
  const out = [];
  for (const [sid, file] of sessionFile) {
    if (liveIds.has(sid) || !UUID.test(sid)) continue;
    const f = files.get(file);
    if (!f || !f.info.turns || !f.info.cwd || (f.info.entrypoint && f.info.entrypoint !== 'cli')) continue; // skip SDK/bot runs
    out.push({
      sessionId: sid, title: f.info.customTitle || f.info.aiTitle || f.info.firstPrompt.slice(0, 60), project: path.basename(f.info.cwd) || '~',
      lastAt: f.info.lastAt || fileMtime.get(file) || 0, cost: f.info.cost || 0, turns: f.info.turns, lastPrompt: f.info.lastPrompt,
    });
  }
  return out.sort((a, b) => b.lastAt - a.lastAt).slice(0, limit);
}

// ---------- search past conversations ----------
function textOf(o) {
  const c = o.message && o.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(x => x.type === 'text').map(x => x.text).join('\n');
  return '';
}
async function searchSessions(q) {
  q = q.trim();
  if (q.length < 2 || q.length > 100) throw new Error('search for 2–100 characters');
  // grep finds candidate files fast (q is an argument, never a shell string); then we pull readable snippets out
  const hits = await new Promise(res => execFile('grep', ['-r', '-l', '-i', '-F', '--include=*.jsonl', '--', q, PROJECTS],
    { timeout: 15000, maxBuffer: 4 << 20 }, (e, out) => res((out || '').split('\n').filter(Boolean))));
  const ql = q.toLowerCase();
  const results = [];
  for (const file of hits.sort((a, b) => (fileMtime.get(b) || 0) - (fileMtime.get(a) || 0)).slice(0, 40)) {
    const f = files.get(file);
    if (f && f.info.entrypoint && f.info.entrypoint !== 'cli') continue;
    const snippets = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.toLowerCase().includes(ql)) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if ((o.type !== 'user' && o.type !== 'assistant') || o.isMeta || o.isSidechain) continue;
      const text = textOf(o);
      const i = text.toLowerCase().indexOf(ql);
      if (i < 0 || text.startsWith('<')) continue;
      snippets.push({ who: o.type === 'user' ? 'you' : 'claude', text: (i > 60 ? '…' : '') + text.slice(Math.max(0, i - 60), i + q.length + 100) + '…', ts: Date.parse(o.timestamp || 0) });
      if (snippets.length >= 3) break;
    }
    if (!snippets.length) continue;
    const sid = path.basename(file, '.jsonl');
    results.push({
      sessionId: sid, title: (f && (f.info.customTitle || f.info.aiTitle)) || 'Untitled session',
      project: path.basename((f && f.info.cwd) || '') || '~', lastAt: (f && f.info.lastAt) || fileMtime.get(file) || 0, snippets,
    });
    if (results.length >= 15) break;
  }
  return results;
}

// ---------- activity log ----------
const events = []; // newest last
function logEvent(icon, text) {
  events.push({ t: Date.now(), icon, text });
  if (events.length > 60) events.shift();
}

// ---------- media ----------
let media = { volume: null, muted: false, player: null };
function refreshMedia() {
  execFile('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'], { timeout: 1500 }, (e, out) => {
    if (e) return;
    const m = out.match(/([\d.]+)/); media.volume = m ? Math.round(parseFloat(m[1]) * 100) : null; media.muted = /MUTED/.test(out);
  });
  execFile('playerctl', ['metadata', '--format', '{{playerName}}\t{{status}}\t{{artist}}\t{{title}}'], { timeout: 1500 }, (e, out) => {
    if (e || !out.trim()) { media.player = null; return; }
    const [name, status, artist, title] = out.trim().split('\t');
    media.player = { name, status, artist, title };
  });
}

// ---------- live sessions ----------
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function hyprClients() {
  return new Promise(res => execFile('hyprctl', ['clients', '-j'], { timeout: 1500 }, (err, out) => {
    if (err) return res([]);
    try { res(JSON.parse(out)); } catch { res([]); }
  }));
}
const cleanTitle = t => (t || '').replace(/^[^\p{L}\p{N}~/]+/u, '').trim();
// Claude Code prefixes its terminal title with a spinner/✳ glyph; plain shells don't
const looksLikeClaude = t => /^[^\p{L}\p{N}\s~/]\s/u.test(t || '');
const INTERACTIVE = ['AskUserQuestion', 'ExitPlanMode'];
const winFirstSeen = new Map(); // window address -> first time we saw it
const pidWin = new Map();       // pid -> window address, once matched

// Titles are the only link between a session and its terminal window (Ghostty runs every window in one process).
// Exact title match wins; then a remembered match; then leftover Claude-looking windows are paired with
// leftover sessions in the order they appeared (covers brand-new sessions that have no AI title yet).
function assignWindows(sessions, clients) {
  const now = Date.now();
  for (const c of clients) if (!winFirstSeen.has(c.address)) winFirstSeen.set(c.address, now);
  for (const a of winFirstSeen.keys()) if (!clients.some(c => c.address === a)) winFirstSeen.delete(a);
  const byAddr = new Map(clients.map(c => [c.address, c]));
  const taken = new Set();
  const give = (s, c) => { s.window = { address: c.address, workspace: c.workspace && c.workspace.name }; taken.add(c.address); pidWin.set(s.pid, c.address); };
  for (const s of sessions) {
    const c = s.hasTitle && clients.find(c => !taken.has(c.address) && cleanTitle(c.title) === s.title);
    if (c) give(s, c);
  }
  for (const s of sessions) {
    if (s.window) continue;
    const c = byAddr.get(pidWin.get(s.pid));
    if (c && !taken.has(c.address) && looksLikeClaude(c.title)) give(s, c);
  }
  const leftS = sessions.filter(s => !s.window).sort((a, b) => a.startedAt - b.startedAt);
  const leftW = clients.filter(c => !taken.has(c.address) && looksLikeClaude(c.title))
    .sort((a, b) => winFirstSeen.get(a.address) - winFirstSeen.get(b.address));
  leftS.forEach((s, i) => { if (leftW[i]) give(s, leftW[i]); });
  for (const pid of pidWin.keys()) if (!sessions.some(s => s.pid === pid)) pidWin.delete(pid);
}

async function liveSessions() {
  let names = [];
  try { names = fs.readdirSync(SESSIONS).filter(n => /^\d+\.json$/.test(n)); } catch {}
  const clients = await hyprClients();
  const out = [];
  for (const n of names) {
    let s; try { s = JSON.parse(fs.readFileSync(path.join(SESSIONS, n), 'utf8')); } catch { continue; }
    if (!s.pid || !alive(s.pid) || s.kind === 'background') continue;
    const file = sessionFile.get(s.sessionId);
    let info = {};
    if (file) { try { info = scanFile(file, fs.statSync(file)).info; } catch {} }
    const title = info.customTitle || info.aiTitle || null;
    const p = info.pending;
    // a pending tool is waiting on you if it's a question/plan, or a normal tool that stalled while the session went idle (permission prompt)
    const needsYou = !!p && (INTERACTIVE.includes(p.name) || (s.status !== 'busy' && Date.now() - p.at > 2000 && Date.now() - p.at < 3600e3));
    out.push({
      pid: s.pid, sessionId: s.sessionId, cwd: s.cwd, project: path.basename(s.cwd) || '~',
      title: title || 'New session ✨', hasTitle: !!title,
      status: needsYou ? 'waiting' : (s.status || 'idle'), statusSince: s.statusUpdatedAt || s.updatedAt || s.startedAt,
      startedAt: s.startedAt, version: s.version,
      model: info.model || null, context: info.context || 0,
      activity: info.activity || null, activityAt: info.activityAt || null,
      lastPrompt: info.lastPrompt || null, lastReply: info.lastReply || null,
      cost: info.cost || 0, stats: info.stats || null, turns: info.turns || 0, absFiles: info.files || [],
      files: (info.files || []).slice(-8).reverse().map(f => path.relative(s.cwd, f).startsWith('..') ? f.replace(HOME, '~') : path.relative(s.cwd, f)),
      pending: needsYou ? p : null,
      window: null,
    });
  }
  out.sort((a, b) => a.startedAt - b.startedAt);
  assignWindows(out, clients);
  return out;
}

// ---------- usage stats ----------
const LEVEL_STEP = 250_000; // output tokens for level 2; each level needs 1.5x the last
function levelOf(totalOut) {
  let lvl = 1, need = LEVEL_STEP, floor = 0;
  while (totalOut >= floor + need) { floor += need; need = Math.round(need * 1.5); lvl++; }
  return { level: lvl, into: totalOut - floor, need };
}
function todaySessions() {
  const sod = new Date(); sod.setHours(0, 0, 0, 0);
  let n = 0;
  for (const f of files.values()) if ((f.info.lastAt || 0) >= sod.getTime() && f.info.turns && (!f.info.entrypoint || f.info.entrypoint === 'cli')) n++;
  return n;
}
function usageStats() {
  const now = Date.now();
  const all = [...usage.values()].sort((a, b) => a.ts - b.ts);
  // ccusage-style 5h blocks: a block starts at the hour of the first message after the previous block ended
  let blockStart = null;
  for (const u of all) {
    if (blockStart === null || u.ts >= blockStart + 5 * 3600e3) {
      const d = new Date(u.ts); d.setMinutes(0, 0, 0); blockStart = d.getTime();
    }
  }
  const blockActive = blockStart !== null && now < blockStart + 5 * 3600e3;
  const sod = new Date(); sod.setHours(0, 0, 0, 0);
  const sum = list => list.reduce((a, u) => {
    a.in += u.in; a.out += u.out; a.cw += u.cw; a.cr += u.cr; a.cost += costOf(u); a.msgs++;
    return a;
  }, { in: 0, out: 0, cw: 0, cr: 0, cost: 0, msgs: 0 });
  const block = blockActive ? sum(all.filter(u => u.ts >= blockStart)) : sum([]);
  const todayList = all.filter(u => u.ts >= sod.getTime());
  const hours = Array.from({ length: 24 }, () => 0);
  for (const u of todayList) hours[new Date(u.ts).getHours()] += u.out;
  const busiestHour = hours.some(Boolean) ? hours.indexOf(Math.max(...hours)) : null;
  const today = sum(todayList);
  const week = sum(all.filter(u => u.ts >= now - 7 * 864e5));
  const hourly = Array.from({ length: 24 }, () => 0);
  for (const u of all) {
    const h = Math.floor((now - u.ts) / 3600e3);
    if (h >= 0 && h < 24) hourly[23 - h] += u.out;
  }
  const lastMin = all.filter(u => u.ts >= now - 60e3).reduce((a, u) => a + u.out, 0);
  const models = {};
  for (const u of todayList) models[family(u.model)] = (models[family(u.model)] || 0) + costOf(u);
  const projects = {};
  for (const u of all.filter(u => u.ts >= now - 7 * 864e5)) {
    const p = projects[u.proj] || (projects[u.proj] = { today: 0, week: 0 });
    p.week += costOf(u); if (u.ts >= sod.getTime()) p.today += costOf(u);
  }
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const s = sod.getTime() - i * 864e5;
    days.push({ day: new Date(s).toLocaleDateString('en', { weekday: 'short' }), cost: (daily.get(dayKey(s)) || { cost: 0 }).cost });
  }
  // streak: consecutive days with activity, counting back from today (or yesterday if today is still empty)
  let streak = 0;
  for (let i = daily.has(dayKey(now)) ? 0 : 1; daily.has(dayKey(sod.getTime() - i * 864e5)); i++) streak++;
  let totalOut = 0, totalCost = 0, best = { day: null, cost: 0 };
  for (const [k, d] of daily) { totalOut += d.out; totalCost += d.cost; if (d.cost > best.cost) best = { day: k, cost: d.cost }; }
  return {
    block: { ...block, start: blockActive ? blockStart : null, end: blockActive ? blockStart + 5 * 3600e3 : null, budget: config.blockBudgetUsd },
    today, week, hourly, outPerMin: lastMin, models, daily: days,
    projects: Object.entries(projects).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.week - a.week).slice(0, 6),
    pet: { ...levelOf(totalOut), streak, totalOut, totalCost, best, daysActive: daily.size },
    todayExtra: { busiestHour, sessions: todaySessions() },
  };
}

// ---------- laptop vitals & dev servers ----------
let lastCpu = null;
function cpuPct() {
  const f = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = f[3] + f[4], total = f.reduce((a, b) => a + b, 0);
  const prev = lastCpu; lastCpu = { idle, total };
  if (!prev || total === prev.total) return 0;
  return Math.round(100 * (1 - (idle - prev.idle) / (total - prev.total)));
}
function readNum(p) { try { return Number(fs.readFileSync(p, 'utf8').trim()); } catch { return null; } }
function vitals() {
  const v = { cpu: 0, mem: 0, temp: null, battery: null, charging: null, load: os.loadavg()[0], uptime: os.uptime() };
  try { v.cpu = cpuPct(); } catch {}
  try {
    const m = Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n').map(l => l.split(/:\s+/)).filter(x => x[1]).map(([k, val]) => [k, parseInt(val)]));
    v.mem = Math.round(100 * (1 - m.MemAvailable / m.MemTotal));
  } catch {}
  try {
    const temps = fs.readdirSync('/sys/class/thermal').filter(z => z.startsWith('thermal_zone')).map(z => readNum(`/sys/class/thermal/${z}/temp`)).filter(t => t > 0 && t < 130000);
    if (temps.length) v.temp = Math.round(Math.max(...temps) / 1000);
  } catch {}
  try {
    const bat = fs.readdirSync('/sys/class/power_supply').find(b => b.startsWith('BAT'));
    if (bat) {
      v.battery = readNum(`/sys/class/power_supply/${bat}/capacity`);
      v.charging = fs.readFileSync(`/sys/class/power_supply/${bat}/status`, 'utf8').trim() !== 'Discharging';
    }
  } catch {}
  return v;
}
let servers = [];
function refreshServers() {
  execFile('ss', ['-ltnpH'], { timeout: 2000 }, (err, out) => {
    if (err) return;
    const list = [];
    for (const line of out.split('\n')) {
      const m = line.match(/\s(\S+):(\d+)\s+\S+\s+users:\(\("([^"]+)",pid=(\d+)/);
      if (!m) continue;
      const [, addr, port, name, pid] = m;
      if (list.some(s => s.port === +port)) continue;
      list.push({ port: +port, name, pid: +pid, lan: !/^(127\.|\[::1\])/.test(addr), self: +pid === process.pid });
    }
    servers = list.sort((a, b) => a.port - b.port);
  });
}

// ---------- real plan limits ----------
// The same endpoint Claude Code's /usage reads, called with your own Claude login from ~/.claude/.credentials.json.
// Claude Code refreshes that token itself; if it's expired we just fall back to the transcript estimate.
let plan = null; // { session: {pct, resetsAt, severity}, weekly: {...}, fetchedAt } or { error }
let planNextAt = 0; // backoff after 429s
async function refreshPlan() {
  if (Date.now() < planNextAt) return;
  let tok;
  try { tok = JSON.parse(fs.readFileSync(path.join(CLAUDE, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken; }
  catch { plan = { error: 'not logged in with a Claude plan' }; return; }
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${tok}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      if (r.status === 429) planNextAt = Date.now() + Math.max(60, Number(r.headers.get('retry-after')) || 300) * 1000;
      plan = { ...(plan || {}), error: `usage API said ${r.status}` };
      return;
    }
    planNextAt = 0;
    const d = await r.json();
    const pick = (lim, fallback) => {
      const l = (d.limits || []).find(x => x.kind === lim) || null;
      const f = fallback && d[fallback];
      if (l) return { pct: l.percent, resetsAt: Date.parse(l.resets_at), severity: l.severity };
      if (f) return { pct: Math.round(f.utilization), resetsAt: Date.parse(f.resets_at), severity: null };
      return null;
    };
    plan = { session: pick('session', 'five_hour'), weekly: pick('weekly_all', 'seven_day'), fetchedAt: Date.now() };
  } catch (e) { plan = { ...(plan || {}), error: e.message }; }
}

// ---------- notifications ----------
function notify(title, body, tags = 'orange_heart') {
  execFile('notify-send', ['-a', 'Claude Deck', title, body], () => {});
  if (!config.ntfy.enabled || !config.ntfy.topic) return;
  // titles are RFC 2047-encoded so emoji survive the HTTP header
  fetch(`${config.ntfy.server}/${config.ntfy.topic}`, {
    method: 'POST', body,
    headers: { Title: `=?UTF-8?B?${Buffer.from(title).toString('base64')}?=`, Tags: tags, Click: (lanUrls()[0] || '').replace(/\?t=.*/, '') },
  }).catch(e => console.error('ntfy failed:', e.message));
}
const lastStatus = new Map();
let watchedOnce = false;
let lastPlanPct = null;
function watchPlan() {
  const p = plan && plan.session && plan.session.pct;
  if (p == null) return;
  if (lastPlanPct === null || p < lastPlanPct) { lastPlanPct = p; return; } // no alert on startup or after a reset
  for (const mark of [80, 95]) if (lastPlanPct < mark && p >= mark) logEvent('🌶️', `Session limit hit ${mark}%`);
  for (const mark of [80, 95]) if (lastPlanPct < mark && p >= mark) notify(`🌶️ Session limit at ${p}%`, `Resets ${new Date(plan.session.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, 'hot_pepper');
  lastPlanPct = p;
}
function watchTransitions(sessions) {
  for (const s of sessions) {
    const was = lastStatus.get(s.pid);
    if (!was && watchedOnce) logEvent('🌱', `Opened “${s.title}”`);
    if (was === 'busy' && s.status === 'idle') { notify(`✨ ${s.title}`, s.lastReply ? s.lastReply.slice(0, 180) : 'Claude is done', 'sparkles'); logEvent('✨', `“${s.title}” finished`); }
    if (was && was !== 'waiting' && s.status === 'waiting') {
      notify('🙋 Claude needs you', s.pending ? `${s.title}: ${s.pending.text}` : s.title, 'raising_hand');
      logEvent('🙋', `“${s.title}” needs you`);
    }
    lastStatus.set(s.pid, s.status);
  }
  for (const [pid] of lastStatus) if (!sessions.some(s => s.pid === pid)) { lastStatus.delete(pid); logEvent('👋', 'A session closed'); }
  watchedOnce = true;
}

// ---------- focus timer ----------
let timer = null; // { end, minutes, label }

// The git repo a session is working in: its own folder, else the repo of the file it edited most recently
// (sessions started in ~ usually work inside ~/Projects/<something>).
function gitRoot(dir) {
  return new Promise(res => execFile('git', ['rev-parse', '--show-toplevel'], { cwd: dir, timeout: 3000 }, (e, o) => res(e ? null : o.trim())));
}
async function sessionRepo(s) {
  const tried = new Set();
  for (const dir of [s.cwd, ...s.absFiles.slice().reverse().map(f => path.dirname(f))]) {
    if (tried.has(dir) || !fs.existsSync(dir)) continue;
    tried.add(dir);
    const root = await gitRoot(dir);
    if (root && root !== HOME) return root;
  }
  return null;
}

// ---------- actions ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { timeout: 5000 }, (e, out, err) => e ? rej(new Error(err || e.message)) : res(out)));
const locked = () => new Promise(res => execFile('pgrep', ['-x', 'hyprlock'], e => res(!e)));

const activeWindow = async () => JSON.parse(await run('hyprctl', ['activewindow', '-j']) || '{}').address;

// strict: refuse unless the session's window really has keyboard focus, so keys never land somewhere else
async function focus(pid, strict = false) {
  const s = (await liveSessions()).find(x => x.pid === pid);
  if (!s) throw new Error('session is gone');
  if (!s.window) throw new Error(`can't find a window for “${s.title}”`);
  if (strict && await locked()) throw new Error('laptop is locked 🔒 — unlock it first');
  await run('hyprctl', ['dispatch', 'focuswindow', `address:${s.window.address}`]);
  await sleep(80);
  if (strict && await activeWindow() !== s.window.address) throw new Error("couldn't grab focus, didn't type anything");
  return s;
}

// Keys go through Hyprland's sendshortcut: the real keymap, no virtual keyboard (wtype) to install per keypress.
// Ghostty ignores input to unfocused windows, so we focus the session, act fast, then hand focus straight back:
// anything you type on the laptop during that window would land in the session.
const sendKey = (addr, mods, key) => run('hyprctl', ['dispatch', 'sendshortcut', `${mods}, ${key}, address:${addr}`]);
// A second hypridle with a 1s timeout tells us when you've stopped typing on the laptop, so a send from the
// phone never steals focus mid-keystroke (your keys would land in the session).
const IDLE_FLAG = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `claude-deck-idle-${process.pid}`);
let idleDetector = null;
function startIdleDetector() {
  const conf = IDLE_FLAG + '.conf';
  fs.writeFileSync(conf, `general {\n  ignore_dbus_inhibit = true\n  ignore_systemd_inhibit = true\n}\nlistener {\n  timeout = 1\n  on-timeout = touch ${IDLE_FLAG}\n  on-resume = rm -f ${IDLE_FLAG}\n}\n`);
  idleDetector = spawn('hypridle', ['-c', conf], { stdio: 'ignore' });
  idleDetector.on('error', () => { idleDetector = null; console.log('   (hypridle not found: sends won\'t wait for you to stop typing)'); });
  idleDetector.on('exit', () => { idleDetector = null; });
  const cleanup = () => { try { idleDetector && idleDetector.kill(); fs.rmSync(IDLE_FLAG, { force: true }); fs.rmSync(conf, { force: true }); } catch {} };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(0); });
}
async function waitForPause(maxMs = 6000) {
  if (!idleDetector) return;
  for (const end = Date.now() + maxMs; Date.now() < end; await sleep(100)) if (fs.existsSync(IDLE_FLAG)) return;
  throw new Error("someone's typing on the laptop ⌨️ — try again in a sec");
}
async function withSession(pid, fn) {
  await waitForPause();
  const prev = await activeWindow().catch(() => null);
  const s = await focus(pid, true);
  try { await fn(s.window.address); }
  finally { if (prev && prev !== s.window.address) await run('hyprctl', ['dispatch', 'focuswindow', `address:${prev}`]).catch(() => {}); }
}

// Long text is pasted, not typed: save the clipboard, paste with shift+insert, press Enter, restore the clipboard.
function readClipboard() {
  return new Promise(res => execFile('wl-paste', ['--list-types'], { timeout: 1000 }, (e, types) => {
    const type = !e && types.split('\n').find(Boolean);
    if (!type) return res(null);
    execFile('wl-paste', ['--no-newline', '--type', type], { encoding: 'buffer', timeout: 2000, maxBuffer: 64 << 20 }, (e2, data) => res(e2 ? null : { type, data }));
  }));
}
function writeClipboard(data, type) {
  return new Promise(res => {
    const p = spawn('wl-copy', type ? ['--type', type] : [], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', () => res(false));
    p.stdin.end(data, () => setTimeout(() => res(true), 80));
  });
}
async function sendText(pid, text) {
  const saved = await readClipboard();
  await writeClipboard(text, 'text/plain;charset=utf-8');
  try {
    await withSession(pid, async addr => {
      await sendKey(addr, 'SHIFT', 'Insert');
      await sleep(250); // Ghostty reads the clipboard asynchronously; Enter must come after the paste lands
      await sendKey(addr, '', 'Return');
    });
  } finally { if (saved) await writeClipboard(saved.data, saved.type); }
}
const KEYS = {
  escape: ['', 'Escape'], backspace: ['', 'BackSpace'], enter: ['', 'Return'], up: ['', 'Up'], down: ['', 'Down'], tab: ['', 'Tab'], space: ['', 'space'],
  'shift-tab': ['SHIFT', 'Tab'], 'ctrl-c': ['CTRL', 'C'],
};
for (let i = 1; i <= 9; i++) KEYS[i] = ['', String(i)];

async function doAction(a) {
  switch (a.type) {
    case 'focus': await focus(a.pid); return { ok: true, msg: 'Focused 👀' };
    case 'send': {
      const text = String(a.text || '').slice(0, 4000);
      if (!text) throw new Error('nothing to send');
      await sendText(a.pid, text);
      return { ok: true, msg: 'Sent 💌' };
    }
    case 'key': {
      const k = KEYS[a.key]; if (!k) throw new Error('unknown key');
      await withSession(a.pid, addr => sendKey(addr, ...k));
      return { ok: true, msg: 'Pressed ' + a.key };
    }
    case 'peek': {
      // screenshot the session's window so you can read a prompt from the phone, then hand focus back
      if (await locked()) throw new Error('laptop is locked 🔒 — unlock it first');
      const prev = JSON.parse(await run('hyprctl', ['activewindow', '-j']) || '{}').address;
      const s = await focus(a.pid);
      await sleep(350); // let the workspace switch animation finish
      const c = (await hyprClients()).find(c => c.address === s.window.address);
      if (!c) throw new Error('window disappeared');
      const geom = `${c.at[0]},${c.at[1]} ${c.size[0]}x${c.size[1]}`;
      const img = await new Promise((res, rej) => execFile('grim', ['-g', geom, '-s', '0.75', '-t', 'jpeg', '-q', '75', '-'],
        { encoding: 'buffer', timeout: 5000, maxBuffer: 32 << 20 }, (e, out) => e ? rej(new Error('screenshot failed')) : res(out)));
      if (prev && prev !== s.window.address) await run('hyprctl', ['dispatch', 'focuswindow', `address:${prev}`]).catch(() => {});
      return { ok: true, msg: '👀 ' + s.title, image: 'data:image/jpeg;base64,' + img.toString('base64') };
    }
    case 'screen': {
      // the whole laptop screen, small enough to stream to a phone every couple of seconds
      const img = await new Promise((res, rej) => execFile('grim', ['-s', '0.5', '-t', 'jpeg', '-q', '60', '-'],
        { encoding: 'buffer', timeout: 5000, maxBuffer: 32 << 20 }, (e, out) => e ? rej(new Error('screenshot failed')) : res(out)));
      return { ok: true, msg: '', image: 'data:image/jpeg;base64,' + img.toString('base64') };
    }
    case 'search': return { ok: true, msg: '', results: await searchSessions(String(a.q || '')) };
    case 'diff': {
      const s = (await liveSessions()).find(x => x.pid === a.pid);
      if (!s) throw new Error('session is gone');
      const repo = await sessionRepo(s);
      if (!repo) throw new Error(`no git repo found for “${s.title}”`);
      const git = args => new Promise(res => execFile('git', args, { cwd: repo, timeout: 8000, maxBuffer: 8 << 20 }, (e, o, er) => res({ ok: !e, out: o || er || '' })));
      const [stat, diff, untracked] = await Promise.all([git(['diff', 'HEAD', '--stat', '--color=never']), git(['diff', 'HEAD', '--color=never', '--no-ext-diff']), git(['ls-files', '--others', '--exclude-standard'])]);
      const MAX = 120_000;
      return { ok: true, msg: '🔀 ' + path.basename(repo), diff: { project: path.basename(repo), stat: stat.out.trim(), patch: diff.out.slice(0, MAX), truncated: diff.out.length > MAX, untracked: untracked.out.trim().split('\n').filter(Boolean).slice(0, 50) } };
    }
    case 'resume': {
      if (!UUID.test(String(a.sessionId))) throw new Error('bad session id');
      const file = sessionFile.get(a.sessionId), f = file && files.get(file);
      if (!f || !f.info.cwd || !fs.existsSync(f.info.cwd)) throw new Error("can't find that session's folder");
      const sq = v => `'${v.replace(/'/g, `'\\''`)}'`;
      await run('hyprctl', ['dispatch', 'exec', `ghostty --working-directory=${sq(f.info.cwd)} -e ${config.claudeCommand} --resume ${a.sessionId}`]);
      logEvent('🔁', `Resumed “${f.info.customTitle || f.info.aiTitle || 'a session'}”`);
      return { ok: true, msg: '🔁 Resuming in ' + path.basename(f.info.cwd) };
    }
    case 'clip-set': {
      const text = String(a.text || '').slice(0, 100_000);
      if (!text) throw new Error('nothing to copy');
      await writeClipboard(text, 'text/plain;charset=utf-8');
      return { ok: true, msg: '📋 On the laptop clipboard' };
    }
    case 'clip-get': {
      const out = await new Promise(res => execFile('wl-paste', ['--no-newline', '--type', 'text'], { timeout: 2000, maxBuffer: 4 << 20 }, (e, o) => res(e ? null : o)));
      if (out == null) throw new Error('laptop clipboard is empty (or not text)');
      return { ok: true, msg: '📋 Laptop clipboard', clip: out.slice(0, 50_000) };
    }
    case 'open-url': {
      let u; try { u = new URL(String(a.url)); } catch { throw new Error("that's not a link"); }
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http(s) links');
      spawn('xdg-open', [u.href], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true, msg: '🔗 Opened on the laptop' };
    }
    case 'media': {
      const cmds = {
        'play-pause': ['playerctl', ['play-pause']], next: ['playerctl', ['next']], prev: ['playerctl', ['previous']],
        'vol-up': ['wpctl', ['set-volume', '-l', '1.0', '@DEFAULT_AUDIO_SINK@', '5%+']], 'vol-down': ['wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', '5%-']],
        mute: ['wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle']],
      };
      const c = cmds[a.cmd]; if (!c) throw new Error('unknown media key');
      await run(...c); refreshMedia();
      return { ok: true, msg: { 'play-pause': '⏯', next: '⏭', prev: '⏮', 'vol-up': '🔊 +5%', 'vol-down': '🔉 −5%', mute: '🔇' }[a.cmd] };
    }
    case 'git': {
      const s = (await liveSessions()).find(x => x.pid === a.pid);
      if (!s) throw new Error('session is gone');
      const repo = await sessionRepo(s);
      if (!repo) throw new Error(`no git repo found for “${s.title}”`);
      const out = await new Promise(res => exec('git status -sb && git log --oneline -3', { cwd: repo, timeout: 5000 }, (e, o, er) => res(o || er || '')));
      return { ok: true, msg: '🌿 ' + path.basename(repo), output: out.trim().slice(0, 2000) };
    }
    case 'new-session': {
      // only known project dirs: the path ends up in a shell command line
      const dir = (projects().find(p => p.path === a.cwd) || { path: HOME }).path;
      const sq = v => `'${v.replace(/'/g, `'\\''`)}'`; // single-quote for the shell hyprctl exec runs
      const prompt = String(a.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
      await run('hyprctl', ['dispatch', 'exec', `ghostty --working-directory=${sq(dir)} -e ${config.claudeCommand}${prompt ? ' ' + sq(prompt) : ''}`]);
      if (prompt) logEvent('🚀', `Started a task in ${path.basename(dir)}: ${prompt.slice(0, 60)}`);
      return { ok: true, msg: (prompt ? '🚀 Task started in ' : '✨ New Claude in ') + path.basename(dir) };
    }
    case 'deck': {
      const b = config.deck.find(x => x.id === a.id);
      if (!b || !b.cmd) throw new Error('unknown button');
      await run('hyprctl', ['dispatch', 'exec', b.cmd]);
      return { ok: true, msg: `${b.emoji} ${b.label}` };
    }
    case 'timer': {
      const min = Number(a.minutes);
      if (!min) { timer = null; return { ok: true, msg: '⏹ Timer stopped' }; }
      if (!(min > 0 && min <= 180)) throw new Error('pick 1–180 minutes');
      timer = { end: Date.now() + min * 60e3, minutes: min, label: String(a.label || 'Focus').slice(0, 40) };
      return { ok: true, msg: `🍅 ${min} min — go!` };
    }
    default: throw new Error('unknown action');
  }
}

function projects() {
  const list = [{ name: '~ home', path: HOME }];
  for (const r of config.projectRoots) {
    try {
      for (const d of fs.readdirSync(r, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith('.')) list.push({ name: d.name, path: path.join(r, d.name) });
    } catch {}
  }
  return list;
}

const PET_COLORS = ['clay', 'pink', 'sky', 'mint', 'grape', 'gold', 'rainbow'];
function publicConfig() {
  return {
    deck: config.deck.map(({ cmd, ...b }) => b), projects: projects(), macros: config.macros,
    pet: config.pet, highScore: config.highScore || 0,
    budget: config.blockBudgetUsd, ntfy: { enabled: config.ntfy.enabled, topic: config.ntfy.enabled ? config.ntfy.topic : '', server: config.ntfy.server },
  };
}
function updateSettings(b) {
  if (Array.isArray(b.macros)) {
    config.macros = b.macros.slice(0, 24).map(m => ({ emoji: String(m.emoji || '💬').slice(0, 8), label: String(m.label || '').slice(0, 24), text: String(m.text || '').slice(0, 2000) })).filter(m => m.label && m.text);
  }
  if (typeof b.budget === 'number' && b.budget > 0 && b.budget < 10000) config.blockBudgetUsd = b.budget;
  if (b.pet && typeof b.pet === 'object') {
    config.pet = {
      name: String(b.pet.name ?? config.pet.name).trim().slice(0, 20) || 'Sparky',
      color: PET_COLORS.includes(b.pet.color) ? b.pet.color : config.pet.color,
    };
  }
  if (Number.isInteger(b.highScore) && b.highScore > (config.highScore || 0) && b.highScore < 1e6) config.highScore = b.highScore;
  if (typeof b.ntfy === 'boolean') {
    config.ntfy.enabled = b.ntfy;
    if (b.ntfy && !config.ntfy.topic) config.ntfy.topic = 'claude-deck-' + crypto.randomBytes(9).toString('hex');
  }
  saveConfig();
  return publicConfig();
}

// ---------- state broadcast ----------
let state = null;
const clients = new Set();
async function tick() {
  try {
    scanAll();
    const sessions = await liveSessions();
    watchTransitions(sessions); watchPlan();
    if (plan && plan.session && plan.session.resetsAt && plan.session.resetsAt < Date.now()) {
      plan.session = { pct: 0, resetsAt: null, severity: 'normal', expired: true }; // the window reset; don't show the old %
      planNextAt = Math.min(planNextAt, Date.now() + 20_000);
      setTimeout(refreshPlan, 25_000);
    }
    if (timer && Date.now() >= timer.end) { logEvent('🍅', `${timer.label} timer done`); notify('🍅 Timer done!', `${timer.label} (${timer.minutes} min) — take a break`, 'tomato'); timer = null; }
    const liveIds = new Set(sessions.map(s => s.sessionId));
    state = { t: Date.now(), host: os.hostname(), sessions, recent: recentSessions(liveIds), usage: usageStats(), plan, vitals: vitals(), servers, timer, media, events: events.slice(-25) };
    const data = `data: ${JSON.stringify(state)}\n\n`;
    for (const res of clients) res.write(data);
  } catch (e) { console.error('tick failed:', e); }
  setTimeout(tick, 1500);
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const authed = (req, url) => {
  const a = Buffer.from(String(req.headers['x-deck-token'] || url.searchParams.get('t') || ''));
  const b = Buffer.from(config.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
// /api/pair hands out the token, so only answer the laptop itself under a localhost Host header (blocks DNS rebinding)
const isLocalHost = req => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '') && !req.headers.origin;
function lanUrls() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal && !/^172\.(1[6-9]|2\d|3[01])\./.test(i.address))
    .map(i => `http://${i.address}:${config.port}/?t=${config.token}`);
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
function readBody(req) {
  return new Promise((res, rej) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) { req.destroy(); rej(new Error('too big')); } });
    req.on('end', () => { try { res(JSON.parse(body || '{}')); } catch (e) { rej(e); } });
  });
}

const server = http.createServer((req, res) => handle(req, res).catch(e => {
  console.error('request failed:', e);
  if (!res.headersSent) json(res, 500, { error: 'server error' }); else res.end();
}));
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/pair') {
    if (!isLocal(req) || !isLocalHost(req)) return json(res, 403, { error: 'open http://localhost:' + config.port + '/pair on the laptop itself' });
    return json(res, 200, { urls: lanUrls() });
  }
  if (url.pathname.startsWith('/api/')) {
    if (!authed(req, url)) return json(res, 401, { error: 'bad token — re-pair from the laptop' });
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      if (state) res.write(`data: ${JSON.stringify(state)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/config') return json(res, 200, publicConfig());
    if (url.pathname === '/api/feed') {
      try { return json(res, 200, { items: feed(url.searchParams.get('sid')) }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && (url.pathname === '/api/action' || url.pathname === '/api/settings')) {
      try {
        const body = await readBody(req);
        return json(res, 200, url.pathname === '/api/action' ? await doAction(body) : updateSettings(body));
      } catch (e) { return json(res, 400, { ok: false, msg: e.message }); }
    }
    return json(res, 404, { error: 'not found' });
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname === '/pair' ? '/pair.html' : url.pathname;
  const file = path.join(ROOT, 'public', path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(ROOT, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

console.log('🧡 Claude Deck: scanning transcripts…');
const t0 = Date.now();
scanAll();
console.log(`   ${files.size} transcripts, ${seenKeys.size} messages over ${daily.size} days in ${Date.now() - t0}ms`);
refreshServers(); setInterval(refreshServers, 5000);
refreshPlan(); setInterval(refreshPlan, 90_000);
startIdleDetector();
refreshMedia(); setInterval(refreshMedia, 3000);
tick();
server.listen(config.port, '0.0.0.0', () => {
  console.log(`\n   Pair your phone: open http://localhost:${config.port}/pair on this laptop and scan the QR`);
  for (const u of lanUrls()) console.log('   or visit ' + u);
  console.log('');
});
