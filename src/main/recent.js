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

module.exports = { recentSessions, transcriptFor };
