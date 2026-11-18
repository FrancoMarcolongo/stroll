const fs = require('fs');
const os = require('os');
const path = require('path');

// @ references in notes and first messages: completion and previews for the editors, and the
// list of referenced files that goes to Claude with a to-do's notes.

const HOME = os.homedir();
// "@" at the start of a word, then a path that doesn't end in punctuation. Same pattern as the
// editor's highlighter (src/renderer/mdeditor.js).
const REF_RE = /(?:^|(?<=[\s([]))@([^\s"'`()[\]{}<>,;]*[^\s"'`()[\]{}<>,;.:!?])/g;
// Never listed in fuzzy completion: big, generated or private.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'coverage', 'vendor', '__pycache__', 'venv', 'Library', 'Applications']);
const WALK_MAX = 20000;
const WALK_BUDGET_MS = 400;
const WALK_TTL_MS = 30 * 1000;
const LIMIT = 60;
const PEEK_BYTES = 6 * 1024;
const PEEK_LINES = 40;

const validDir = d => { try { return Boolean(d) && fs.statSync(d).isDirectory(); } catch (_) { return false; } };
const baseDir = cwd => (validDir(cwd) ? path.resolve(cwd) : HOME);

function resolveRef(cwd, p) {
  const s = String(p || '');
  if (s === '~' || s.startsWith('~/')) return path.join(HOME, s.slice(1));
  return path.resolve(baseDir(cwd), s);
}

// How a path is written after "@": relative inside the folder, ~/… under home, else absolute.
function displayPath(cwd, abs) {
  const base = baseDir(cwd);
  const rel = path.relative(base, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  if (abs === HOME) return '~';
  if (abs.startsWith(HOME + path.sep)) return `~${abs.slice(HOME.length)}`;
  return abs;
}

const kindOf = abs => {
  try { return fs.statSync(abs).isDirectory() ? 'dir' : 'file'; } catch (_) { return null; }
};

const refsIn = text => [...String(text || '').matchAll(REF_RE)].map(m => m[1]);

// Breadth-first, bounded by count and time, skipping hidden and generated folders. Symlinks
// aren't followed. Cached per folder for a short while; typing "@" again reuses it.
const walks = new Map();
async function walk(root) {
  const hit = walks.get(root);
  if (hit && Date.now() - hit.at < WALK_TTL_MS) return hit.promise;
  const promise = (async () => {
    const list = [];
    const queue = [''];
    const started = Date.now();
    while (queue.length && list.length < WALK_MAX && Date.now() - started < WALK_BUDGET_MS) {
      const rel = queue.shift();
      let entries;
      try { entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true }); } catch (_) { continue; }
      for (const e of entries) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        const dir = e.isDirectory();
        list.push({ rel: r, dir });
        if (dir) queue.push(r);
      }
    }
    return list;
  })();
  walks.set(root, { at: Date.now(), promise });
  return promise;
}

const item = (insert, dir) => {
  const clean = insert.replace(/\/$/, '');
  const slash = clean.lastIndexOf('/');
  return { path: dir ? `${clean}/` : clean, name: clean.slice(slash + 1) || clean, parent: slash >= 0 ? clean.slice(0, slash + 1) : '', dir };
};
const byDirThenName = (a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name);

// Completion for what follows "@". With a slash it lists that folder; otherwise it lists the
// folder's own entries that start with the text, then files anywhere below whose name has it.
async function complete(cwd, query) {
  const base = baseDir(cwd);
  let q = String(query || '');
  if (q === '~') q = '~/';
  if (q.includes('/')) {
    const cut = q.lastIndexOf('/') + 1;
    const dirPart = q.slice(0, cut);
    const prefix = q.slice(cut).toLowerCase();
    let entries;
    try { entries = await fs.promises.readdir(resolveRef(base, dirPart), { withFileTypes: true }); } catch (_) { return []; }
    return entries
      .filter(e => e.name.toLowerCase().startsWith(prefix) && (prefix.startsWith('.') || !e.name.startsWith('.')))
      .map(e => item(dirPart + e.name, e.isDirectory() || (e.isSymbolicLink() && kindOf(resolveRef(base, dirPart + e.name)) === 'dir')))
      .sort(byDirThenName)
      .slice(0, LIMIT);
  }
  const lower = q.toLowerCase();
  let own = [];
  try { own = await fs.promises.readdir(base, { withFileTypes: true }); } catch (_) { /* unreadable folder */ }
  const direct = own
    .filter(e => e.name.toLowerCase().startsWith(lower) && (lower.startsWith('.') || !e.name.startsWith('.')))
    .map(e => item(e.name, e.isDirectory()))
    .sort(byDirThenName);
  if (!lower) return direct.slice(0, LIMIT);
  const seen = new Set(direct.map(i => i.path));
  const nameOf = e => e.rel.slice(e.rel.lastIndexOf('/') + 1).toLowerCase();
  // Best first: the name without extension is the text, starts with it, contains it, then
  // only the path does; then shorter names, then shallower paths.
  const rank = e => {
    const name = nameOf(e);
    if (name.replace(/\.[^.]*$/, '') === lower || name === lower) return 0;
    if (name.startsWith(lower)) return 1;
    if (name.includes(lower)) return 2;
    return 3;
  };
  const deep = (await walk(base))
    .filter(e => e.rel.toLowerCase().includes(lower) && !seen.has(e.dir ? `${e.rel}/` : e.rel))
    .sort((a, b) => rank(a) - rank(b) || nameOf(a).length - nameOf(b).length
      || a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel))
    .map(e => item(e.rel, e.dir));
  return [...direct, ...deep].slice(0, LIMIT);
}

// The start of a file, or a folder's entries, for the completion's preview.
async function peek(cwd, p) {
  const abs = resolveRef(cwd, p);
  let st;
  try { st = await fs.promises.stat(abs); } catch (_) { return { kind: 'missing', path: abs }; }
  if (st.isDirectory()) {
    let entries = [];
    try { entries = await fs.promises.readdir(abs, { withFileTypes: true }); } catch (_) { /* unreadable */ }
    const names = entries.filter(e => !e.name.startsWith('.'))
      .map(e => ({ name: e.name, dir: e.isDirectory() })).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    return { kind: 'dir', path: abs, count: names.length, entries: names.slice(0, PEEK_LINES).map(e => (e.dir ? `${e.name}/` : e.name)) };
  }
  const out = { kind: 'file', path: abs, size: st.size };
  try {
    const fh = await fs.promises.open(abs, 'r');
    const buf = Buffer.alloc(Math.min(st.size, PEEK_BYTES));
    await fh.read(buf, 0, buf.length, 0);
    await fh.close();
    if (buf.includes(0)) return { ...out, binary: true };
    const lines = buf.toString('utf8').split('\n');
    return { ...out, text: lines.slice(0, PEEK_LINES).join('\n'), more: lines.length > PEEK_LINES || st.size > PEEK_BYTES };
  } catch (_) {
    return { ...out, unreadable: true };
  }
}

// Which of these references exist: { ref: 'file' | 'dir' | 'missing' }.
function refKinds(cwd, refs) {
  const out = {};
  for (const r of (refs || []).slice(0, 200)) out[r] = kindOf(resolveRef(cwd, r)) || 'missing';
  return out;
}

// A line for Claude listing the files the text references, by absolute path, so it can read
// them even where Claude Code doesn't expand "@" itself (system prompts, background runs).
function refsNote(text, cwd) {
  const found = [...new Set(refsIn(text).map(r => resolveRef(cwd, r)))].filter(p => kindOf(p));
  return found.length ? `Files and folders referenced with @ (read them for context):\n${found.map(p => `- ${p}`).join('\n')}` : '';
}

module.exports = { complete, peek, refKinds, refsNote, refsIn, displayPath, resolveRef };
