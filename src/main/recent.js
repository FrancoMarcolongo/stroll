const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const HEAD_BYTES = 256 * 1024;

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function promptText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.find(c => c.type === 'text' && c.text);
    return t ? t.text : null;
  }
  return null;
}

// Title, cwd and first prompt of a transcript, from its first lines only.
function describe(file) {
  let cwd = null; let title = null; let prompt = null;
  for (const line of readHead(file).split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch (_) { continue; }
    if (!cwd && d.cwd) cwd = d.cwd;
    if (!title && (d.type === 'custom-title' || d.type === 'ai-title')) title = d.customTitle || d.aiTitle || d.title || null;
    if (!title && d.type === 'summary' && d.summary) title = d.summary;
    if (!prompt && d.type === 'user' && !d.isSidechain && !d.isMeta) {
      const text = promptText(d.message?.content);
      if (text && !text.startsWith('<') && !text.startsWith('Caveat:')) prompt = text;
    }
    if (cwd && prompt && title) break;
  }
  return { cwd, title, prompt };
}

// Recent Claude Code sessions on this machine, wherever they were started.
function recentSessions(excludeIds = new Set(), limit = 25) {
  if (!fs.existsSync(PROJECTS)) return [];
  const files = [];
  for (const dir of fs.readdirSync(PROJECTS)) {
    const full = path.join(PROJECTS, dir);
    let entries;
    try { entries = fs.readdirSync(full); } catch (_) { continue; }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      if (excludeIds.has(id)) continue;
      try { files.push({ id, file: path.join(full, f), mtime: fs.statSync(path.join(full, f)).mtimeMs }); } catch (_) { /* vanished */ }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const f of files) {
    if (out.length >= limit) break;
    const d = describe(f.file);
    if (!d.prompt && !d.title) continue; // empty or tool-only transcripts
    out.push({
      id: f.id,
      title: (d.title || d.prompt).replace(/\s+/g, ' ').slice(0, 90),
      cwd: d.cwd,
      lastActivityAt: new Date(f.mtime).toISOString(),
    });
  }
  return out;
}

// Path of a session's transcript, or null when Claude never wrote one (no message was sent).
function transcriptFor(id) {
  if (!id || !fs.existsSync(PROJECTS)) return null;
  for (const dir of fs.readdirSync(PROJECTS)) {
    const file = path.join(PROJECTS, dir, `${id}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// The first thing the user typed in a session, from its transcript.
function firstPrompt(id) {
  const file = transcriptFor(id);
  return file ? describe(file).prompt : null;
}

// Claude Code sessions running right now that Stroll didn't start (`knownIds`), from Claude
// Code's own list of its live processes: ~/.claude/sessions/<pid>.json, with the session id,
// folder, name and busy/idle. It isn't a documented format, so anything unexpected is skipped.
const RUNNING = path.join(os.homedir(), '.claude', 'sessions');
const described = new Map(); // session id → { title, cwd } from its transcript
const isoOf = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? new Date(Number(v)).toISOString() : null);

function runningElsewhere(knownIds = new Set()) {
  let files;
  try { files = fs.readdirSync(RUNNING).filter(f => /^\d+\.json$/.test(f)); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(RUNNING, f), 'utf8')); } catch (_) { continue; }
    const pid = Number(d.pid || f.split('.')[0]);
    if (!d.sessionId || knownIds.has(d.sessionId) || (d.kind && d.kind !== 'interactive')) continue;
    // A file left behind by a process that's gone.
    try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') continue; }
    let info = described.get(d.sessionId);
    if (!info) {
      const file = transcriptFor(d.sessionId);
      const desc = file ? describe(file) : {};
      info = { title: desc.title || desc.prompt || null, cwd: desc.cwd || null };
      if (info.title) described.set(d.sessionId, info); // until it has one, look again next time
    }
    const title = (d.nameSource === 'user' && d.name) || info.title || d.name || 'Untitled session';
    out.push({
      id: d.sessionId,
      pid,
      title: String(title).replace(/\s+/g, ' ').slice(0, 90),
      cwd: d.cwd || info.cwd,
      busy: d.status === 'busy',
      startedAt: isoOf(d.startedAt),
      updatedAt: isoOf(d.statusUpdatedAt || d.updatedAt) || isoOf(d.startedAt),
    });
  }
  return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

module.exports = { recentSessions, transcriptFor, firstPrompt, runningElsewhere };
