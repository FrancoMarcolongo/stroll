const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { writePrivate } = require('./config');

const now = () => new Date().toISOString();
const pad = n => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DAY = 24 * 60 * 60 * 1000;
const KEEP_CLOSED_SESSIONS = 100;
const KEEP_FINISHED_RUNS_DAYS = 30;
// Once a condensed version of a trail's notes is answered (taken, dismissed or undone), the
// next one isn't drafted on its own until the notes have grown by this much.
const REOFFER_GROWTH = 1.25;

const words = s => (String(s || '').match(/\S+/g) || []).length;
const rtrim = s => String(s || '').replace(/\s+$/, '');

// The whole lines of the notes that `quote` falls on, or null when it isn't there. A session
// quotes the notes as it read them (indented, maybe without the date), so spacing is ignored.
function quotedLines(notes, quote) {
  const parts = String(quote || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const m = new RegExp(parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')).exec(notes);
  if (!m) return null;
  const start = notes.lastIndexOf('\n', m.index) + 1;
  const nl = notes.indexOf('\n', m.index + m[0].length);
  let end = nl < 0 ? notes.length : nl;
  // A dated line's continuation lines are indented under it and go with it.
  if (notes.startsWith('- ', start)) {
    for (let next; (next = /^\n[ \t]+\S[^\n]*/.exec(notes.slice(end)));) end += next[0].length;
  }
  return notes.slice(start, end);
}

function emptyState() {
  return { version: 1, todos: [], sessions: [], runs: [], workflows: [], trails: [], recentDirs: [] };
}

// Single writer: the app owns state.json. The MCP server goes through the app's HTTP API.
class Store extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    // A first launch (no state yet) has nothing to catch up on in "What's new".
    this.fresh = !fs.existsSync(file);
    this.state = this.load();
    this.saveTimer = null;
  }

  load() {
    if (!fs.existsSync(this.file)) return emptyState();
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // Anything that was live when the app last quit is gone now; remember which sessions
      // were open so they can be resumed in one go.
      for (const sess of s.sessions || []) if (sess.live) { sess.live = false; sess.status = 'closed'; sess.restorable = true; }
      for (const run of s.runs || []) if (run.status === 'running') { run.status = 'interrupted'; run.finishedAt = run.finishedAt || now(); }
      for (const t of s.trails || []) if (t.condense?.status === 'running') t.condense = null;
      return { ...emptyState(), ...s };
    } catch (e) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      fs.copyFileSync(this.file, backup);
      console.error(`[stroll] state.json unreadable, backed up to ${backup}:`, e.message);
      return emptyState();
    }
  }

  changed() {
    this.emit('change');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    clearTimeout(this.saveTimer);
    writePrivate(this.file, JSON.stringify(this.state, null, 2));
  }

  snapshot() { return JSON.parse(JSON.stringify(this.state)); }

  // Keeps state.json from growing forever: the newest closed sessions stay (older ones are
  // still reachable from "Elsewhere"), finished runs go after a month. Returns the removed
  // run ids so their event files can be deleted.
  prune() {
    const closed = this.state.sessions.filter(s => !s.live && !s.restorable)
      .sort((a, b) => (b.lastActivityAt || '').localeCompare(a.lastActivityAt || ''));
    const dropSessions = new Set(closed.slice(KEEP_CLOSED_SESSIONS).map(s => s.id));
    const cutoff = Date.now() - KEEP_FINISHED_RUNS_DAYS * DAY;
    const dropRuns = new Set(this.state.runs
      .filter(r => r.status !== 'running' && new Date(r.finishedAt || r.startedAt || 0).getTime() < cutoff)
      .map(r => r.id));
    if (!dropSessions.size && !dropRuns.size) return [];
    this.state.sessions = this.state.sessions.filter(s => !dropSessions.has(s.id));
    this.state.runs = this.state.runs.filter(r => !dropRuns.has(r.id));
    for (const t of this.state.todos) {
      t.sessionIds = t.sessionIds.filter(x => !dropSessions.has(x));
      t.runIds = t.runIds.filter(x => !dropRuns.has(x));
    }
    this.changed();
    return [...dropRuns];
  }

  // --- to-dos ---
  todo(id) { return this.state.todos.find(t => t.id === id); }

  // A to-do added from a session on a trail lands in that trail unless told otherwise.
  addTodo({ title, notes = '', remindAt = null, cwd = null, sessionId = null, trailId }) {
    const trail = trailId === undefined ? this.session(sessionId)?.trailId : trailId;
    const t = {
      id: crypto.randomUUID(), title: String(title).trim(), notes, status: 'open',
      order: Math.max(-1, ...this.state.todos.map(x => x.order ?? 0)) + 1,
      createdAt: now(), doneAt: null, remindAt, remindedAt: null, remindAck: false, cwd,
      trailId: this.trail(trail) ? trail : null,
      sessionIds: [], runIds: [],
    };
    this.state.todos.push(t);
    if (sessionId) this.linkSession(sessionId, t.id, false);
    this.changed();
    return t;
  }

  updateTodo(id, patch) {
    const t = this.todo(id);
    if (!t) return null;
    const allowed = ['title', 'notes', 'remindAt', 'cwd', 'status', 'order', 'trailId'];
    for (const k of allowed) if (k in patch) t[k] = patch[k];
    if ('trailId' in patch && !this.trail(t.trailId)) t.trailId = null;
    if ('remindAt' in patch) { t.remindedAt = null; t.remindAck = false; }
    if ('status' in patch) t.doneAt = patch.status === 'done' ? now() : null;
    this.changed();
    return t;
  }

  // A due reminder stays in "Needs you" until the to-do is opened.
  ackReminder(id) {
    const t = this.todo(id);
    if (!t || !t.remindAt || t.remindAck || new Date(t.remindAt) > new Date()) return;
    t.remindAck = true;
    this.changed();
  }

  deleteTodo(id) {
    this.state.todos = this.state.todos.filter(t => t.id !== id);
    for (const s of this.state.sessions) s.todoIds = (s.todoIds || []).filter(x => x !== id);
    for (const r of this.state.runs) r.todoIds = (r.todoIds || []).filter(x => x !== id);
    this.changed();
  }

  // --- sessions ---
  session(id) { return this.state.sessions.find(s => s.id === id); }

  upsertSession(sess) {
    const existing = this.session(sess.id);
    if (existing) Object.assign(existing, sess);
    else this.state.sessions.unshift({ todoIds: [], createdAt: now(), ...sess });
    this.changed();
    return this.session(sess.id);
  }

  patchSession(id, patch) {
    const s = this.session(id);
    if (!s) return null;
    Object.assign(s, patch);
    this.changed();
    return s;
  }

  linkSession(sessionId, todoId, notify = true) {
    const s = this.session(sessionId);
    const t = this.todo(todoId);
    if (s && !s.todoIds.includes(todoId)) s.todoIds.push(todoId);
    if (t && !t.sessionIds.includes(sessionId)) t.sessionIds.push(sessionId);
    if (notify) this.changed();
  }

  forgetSession(id) {
    this.state.sessions = this.state.sessions.filter(s => s.id !== id);
    for (const t of this.state.todos) t.sessionIds = t.sessionIds.filter(x => x !== id);
    this.changed();
  }

  forgetClosedSessions() {
    const drop = new Set(this.state.sessions.filter(s => !s.live).map(s => s.id));
    this.state.sessions = this.state.sessions.filter(s => !drop.has(s.id));
    for (const t of this.state.todos) t.sessionIds = t.sessionIds.filter(x => !drop.has(x));
    this.changed();
  }

  // --- background runs ---
  run(id) { return this.state.runs.find(r => r.id === id); }

  addRun(run) {
    this.state.runs.unshift({ createdAt: now(), todoIds: [], ...run });
    for (const tid of run.todoIds || []) {
      const t = this.todo(tid);
      if (t && !t.runIds.includes(run.id)) t.runIds.push(run.id);
    }
    this.changed();
    return this.run(run.id);
  }

  patchRun(id, patch) {
    const r = this.run(id);
    if (!r) return null;
    Object.assign(r, patch);
    this.changed();
    return r;
  }

  forgetRuns(ids) {
    const drop = new Set(ids);
    this.state.runs = this.state.runs.filter(r => !drop.has(r.id));
    for (const t of this.state.todos) t.runIds = t.runIds.filter(x => !drop.has(x));
    this.changed();
  }

  // --- workflows (saved session templates; see workflows.js) ---
  workflow(id) { return this.state.workflows.find(w => w.id === id); }

  addWorkflow(fields = {}) {
    const w = {
      id: crypto.randomUUID(), name: 'New workflow', cwd: null, mode: 'session', template: '', prepareTemplate: '',
      values: {}, runAllowAll: false, schedule: null, scheduleSetAt: null, due: null, lastSlotAt: null,
      lastStartedAt: null, createdAt: now(), ...fields,
    };
    this.state.workflows.push(w);
    this.changed();
    return w;
  }

  updateWorkflow(id, patch) {
    const w = this.workflow(id);
    if (!w) return null;
    Object.assign(w, patch);
    this.changed();
    return w;
  }

  deleteWorkflow(id) {
    this.state.workflows = this.state.workflows.filter(w => w.id !== id);
    this.changed();
  }

  // --- trails: sessions about the same piece of work, sharing the trail's notes ---
  // Membership lives on the members (trailId on to-dos, sessions, runs and workflows), never in
  // a list on the trail, so there's nothing to keep in sync when one of them goes.
  trail(id) { return id ? this.state.trails.find(t => t.id === id) : undefined; }

  addTrail({ title = 'New trail', notes = '', cwd = null } = {}) {
    const t = {
      id: crypto.randomUUID(), title: String(title).trim() || 'New trail', notes: String(notes || ''), cwd: cwd || null,
      status: 'active', order: Math.max(-1, ...this.state.trails.map(x => x.order ?? 0)) + 1,
      createdAt: now(), updatedAt: now(), archivedAt: null, suggestions: [],
    };
    this.state.trails.push(t);
    this.changed();
    return t;
  }

  updateTrail(id, patch) {
    const t = this.trail(id);
    if (!t) return null;
    for (const k of ['title', 'notes', 'cwd', 'status', 'order']) if (k in patch) t[k] = patch[k];
    if ('status' in patch) t.archivedAt = patch.status === 'archived' ? now() : null;
    t.updatedAt = now();
    this.changed();
    return t;
  }

  deleteTrail(id) {
    this.state.trails = this.state.trails.filter(t => t.id !== id);
    for (const list of [this.state.todos, this.state.sessions, this.state.runs, this.state.workflows]) for (const x of list) if (x.trailId === id) x.trailId = null;
    this.changed();
  }

  // Adds a dated line to the notes: at the end, or in place of `replaces` (lines of the notes,
  // as quotedLines returns them) while they're still there. The user's own text around it is
  // left as it is.
  appendTrailNote(id, text, replaces = null) {
    const t = this.trail(id);
    const body = String(text || '').trim();
    if (!t || !body) return null;
    const line = `- [${localDate()}] ${body.replace(/\n/g, '\n  ')}`;
    const at = replaces ? t.notes.indexOf(replaces) : -1;
    const notes = rtrim(t.notes);
    if (at >= 0) t.notes = t.notes.slice(0, at) + line + t.notes.slice(at + replaces.length);
    else t.notes = notes ? `${notes}\n${line}` : line;
    t.updatedAt = now();
    this.changed();
    return t;
  }

  // `replaces` quotes something already in the notes that this corrects. It's kept as the
  // lines read now, so the trail can show what accepting it takes out.
  suggestTrailNote(id, text, sessionId = null, replaces = null) {
    const t = this.trail(id);
    const body = String(text || '').trim();
    if (!t || !body) return null;
    const s = { id: crypto.randomUUID(), text: body, sessionId, sessionTitle: this.session(sessionId)?.title || null, createdAt: now() };
    const old = replaces ? quotedLines(t.notes, replaces) : null;
    if (old) s.replaces = old;
    t.suggestions.push(s);
    this.changed();
    return s;
  }

  // Accept (optionally with the user's edits) adds it to the notes, in place of the lines it
  // replaces when it has some; dismiss drops it.
  resolveSuggestion(trailId, suggestionId, accept, text = null) {
    const t = this.trail(trailId);
    const s = t?.suggestions.find(x => x.id === suggestionId);
    if (!s) return null;
    t.suggestions = t.suggestions.filter(x => x.id !== suggestionId);
    if (accept) this.appendTrailNote(trailId, text ?? s.text, s.replaces);
    else this.changed();
    return t;
  }

  // --- condensing: a shorter version of the notes, drafted by Claude, that the user reviews ---
  // trail.condense is the draft in progress ({ status: running | ready | failed, base: the
  // notes it was made from, text, auto: Stroll started it because the notes got long }).
  startCondense(id, auto = false) {
    const t = this.trail(id);
    if (!t) return null;
    t.condense = { status: 'running', auto: Boolean(auto), base: t.notes, startedAt: now() };
    this.changed();
    return t.condense;
  }

  // `startedAt` names the draft, so a late answer to one that was dismissed changes nothing. A
  // draft that isn't shorter isn't worth the user's time, and one Stroll started fails quietly.
  finishCondense(id, startedAt, { text = '', error = null } = {}) {
    const t = this.trail(id);
    const c = t?.condense;
    if (!c || c.status !== 'running' || c.startedAt !== startedAt) return null;
    const body = String(text || '').trim();
    const fromWords = words(c.base);
    const toWords = words(body);
    const problem = error || (!body ? 'Claude returned nothing.' : toWords >= fromWords ? 'Claude found nothing to cut.' : null);
    if (!problem) t.condense = { ...c, status: 'ready', text: body, fromWords, toWords, finishedAt: now() };
    else if (c.auto) this.answerCondense(t);
    else t.condense = { ...c, status: 'failed', error: problem, finishedAt: now() };
    this.changed();
    return t;
  }

  answerCondense(t) {
    t.condense = null;
    t.condenseSkipWords = Math.round(words(t.notes) * REOFFER_GROWTH);
  }

  // The notes still begin as they did when the draft was made: anything after that was added
  // since (an accepted suggestion, a line typed at the end) and is kept after the draft.
  addedSince(t, base) {
    const start = rtrim(base);
    return t.notes.startsWith(start) ? t.notes.slice(start.length).trim() : null;
  }

  // Replaces the notes with the draft, as the user edited it. The notes it replaces are kept
  // for one undo.
  applyCondense(id, text = null) {
    const t = this.trail(id);
    const c = t?.condense;
    if (!c || c.status !== 'ready') return null;
    const added = this.addedSince(t, c.base);
    if (added === null) throw new Error('The notes changed since this was drafted. Condense them again.');
    const body = String(text ?? '').trim() || c.text;
    const before = t.notes;
    t.notes = added ? `${body}\n${added}` : body;
    t.previousNotes = { text: before, after: t.notes, at: now() };
    this.answerCondense(t);
    t.updatedAt = now();
    this.changed();
    return t;
  }

  dismissCondense(id) {
    const t = this.trail(id);
    if (!t?.condense) return null;
    this.answerCondense(t);
    this.changed();
    return t;
  }

  // Puts back the notes from before the last condense, with the lines added after it.
  undoCondense(id) {
    const t = this.trail(id);
    const p = t?.previousNotes;
    if (!p) return null;
    const added = this.addedSince(t, p.after);
    t.notes = added ? `${rtrim(p.text)}\n${added}` : p.text;
    t.previousNotes = null;
    this.answerCondense(t);
    t.updatedAt = now();
    this.changed();
    return t;
  }

  setSessionTrail(sessionId, trailId) {
    const s = this.session(sessionId);
    if (!s) return null;
    s.trailId = this.trail(trailId) ? trailId : null;
    this.changed();
    return s;
  }

  rememberDir(dir) {
    if (!dir) return;
    this.state.recentDirs = [dir, ...this.state.recentDirs.filter(d => d !== dir)].slice(0, 12);
    this.changed();
  }
}

module.exports = { Store, words, quotedLines };
