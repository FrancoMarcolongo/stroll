const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { writePrivate } = require('./config');

const now = () => new Date().toISOString();
const DAY = 24 * 60 * 60 * 1000;
const KEEP_CLOSED_SESSIONS = 100;
const KEEP_FINISHED_RUNS_DAYS = 30;

function emptyState() {
  return { version: 1, todos: [], sessions: [], runs: [], workflows: [], recentDirs: [] };
}

// Single writer: the app owns state.json. The MCP server goes through the app's HTTP API.
class Store extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
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

  addTodo({ title, notes = '', remindAt = null, cwd = null, sessionId = null }) {
    const t = {
      id: crypto.randomUUID(), title: String(title).trim(), notes, status: 'open',
      order: Math.max(-1, ...this.state.todos.map(x => x.order ?? 0)) + 1,
      createdAt: now(), doneAt: null, remindAt, remindedAt: null, remindAck: false, cwd,
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
    const allowed = ['title', 'notes', 'remindAt', 'cwd', 'status', 'order'];
    for (const k of allowed) if (k in patch) t[k] = patch[k];
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

  rememberDir(dir) {
    if (!dir) return;
    this.state.recentDirs = [dir, ...this.state.recentDirs.filter(d => d !== dir)].slice(0, 12);
    this.changed();
  }
}

module.exports = { Store };
