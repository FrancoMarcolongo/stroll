/* global Terminal, FitAddon, WebLinksAddon, Unicode11Addon */
const api = window.stroll;
const $ = sel => document.querySelector(sel);

const S = {
  data: null,
  view: { type: 'home', id: null },
  selected: new Set(),
  recent: [],
  recentLoaded: false,
  update: null,
  windowFocused: true,
};
const terms = new Map(); // session id -> { term, fit, el, lastSeq, ready, queue }

const THEME = {
  background: '#0e1116', foreground: '#e6edf3', cursor: '#e6edf3', cursorAccent: '#0e1116',
  selectionBackground: '#2f3b4d',
  black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
};

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortDir = d => (d ? d.replace(/^\/Users\/[^/]+/, '~') : '');
function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
const agoText = iso => (ago(iso) === 'now' ? 'just now' : `${ago(iso)} ago`);
function fmtDuration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const todo = id => S.data.todos.find(t => t.id === id);
const session = id => S.data.sessions.find(s => s.id === id);
// Live sessions in sidebar order (latest activity first); ⌘1–9 and Ctrl+Tab follow it.
const liveSessions = () => S.data.sessions.filter(s => s.live).sort((a, b) => (b.lastActivityAt || '').localeCompare(a.lastActivityAt || ''));
const run = id => S.data.runs.find(r => r.id === id);
const workflow = id => (S.data.workflows || []).find(w => w.id === id);

// Line icons (24px grid, stroked), inlined so the app needs no icon dependency.
const svgIcon = body => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  plus: svgIcon('<path d="M12 5v14M5 12h14"/>'),
  play: svgIcon('<path d="M7 5l12 7-12 7z"/>'),
  handoff: svgIcon('<path d="M7 17L17 7"/><path d="M8 7h9v9"/>'),
  check: svgIcon('<path d="M20 6L9 17l-5-5"/>'),
  overview: svgIcon('<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>'),
  folder: svgIcon('<path d="M3 7.5A2.5 2.5 0 015.5 5H9l2 2.5h7.5A2.5 2.5 0 0121 10v6.5a2.5 2.5 0 01-2.5 2.5h-13A2.5 2.5 0 013 16.5z"/>'),
  bell: svgIcon('<path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 003.4 0"/>'),
  activity: svgIcon('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
  list: svgIcon('<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>'),
  link: svgIcon('<path d="M10 13a5 5 0 007.07 0l3-3a5 5 0 00-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 00-7.07 0l-3 3a5 5 0 007.07 7.07l1.5-1.5"/>'),
  stop: svgIcon('<rect x="6" y="6" width="12" height="12" rx="2.5"/>'),
  resume: svgIcon('<path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'),
  trash: svgIcon('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>'),
  copy: svgIcon('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>'),
  unread: svgIcon('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/>'),
  read: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>'),
  clock: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  terminal: svgIcon('<path d="M5 17l5-5-5-5"/><path d="M13 19h6"/>'),
  settings: svgIcon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>'),
  mute: svgIcon('<path d="M13.73 21a2 2 0 01-3.46 0"/><path d="M18.63 13A17.9 17.9 0 0118 8"/><path d="M6.26 6.26A5.86 5.86 0 006 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 00-9.33-5"/><path d="M2 2l20 20"/>'),
  download: svgIcon('<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>'),
  alert: svgIcon('<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/>'),
};
document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = ICON[el.dataset.icon] || ''; });

const SESSION_LABEL = { working: 'working', waiting: 'needs you', idle: 'your turn', starting: 'starting', closed: 'closed' };
const RUN_LABEL = { running: 'running', ready: 'ready for you', failed: 'failed', reviewed: 'reviewed', cancelled: 'cancelled', interrupted: 'interrupted' };
const sessionState = s => (s.live ? s.status || 'starting' : 'closed');

// Dots only mark what's ongoing or not yet seen: green working, yellow needs you, blue your
// turn (until you open it). Everything else, including a turn you've already looked at, has none.
const DOT_LABEL = { working: 'working', waiting: 'needs you', idle: 'your turn' };
function sessionDot(s) {
  if (!s.live) return 'none';
  if (s.status === 'working') return 'working';
  if (s.status === 'waiting') return 'waiting';
  if (s.status === 'idle' && s.unseen) return 'idle';
  return 'none';
}
function runDot(r) {
  if (r.pendingApproval) return 'waiting';
  if (r.status === 'running') return 'working';
  if (!r.unseen) return 'none';
  return r.status === 'ready' ? 'idle' : 'waiting';
}
const dotHtml = dot => `<span class="dot ${dot}"${DOT_LABEL[dot] ? ` title="${DOT_LABEL[dot]}"` : ''}></span>`;

const plainText = md => md.replace(/^#{1,4} /gm, '').replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim();

function lightMarkdown(text) {
  return esc(text)
    .replace(/^(#{1,4}) (.*)$/gm, '<span class="h">$2</span>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

// ---------- in-place list updates ----------
// Status pushes arrive several times a second while sessions work. Rebuilding a list with
// innerHTML destroyed the row under the mouse on every push (hover and cursor flicker), so
// rows are matched by key and only rows whose markup changed are updated, in place.
const lastHtml = new WeakMap();
const tpl = document.createElement('template');

function rowKey(el, i) {
  if (el.dataset.kind && el.dataset.id) return `${el.dataset.kind}:${el.dataset.id}`;
  return `${el.className}:${el.textContent.trim().slice(0, 40)}:${i}`;
}

function patchList(ul, html) {
  tpl.innerHTML = html;
  const fresh = [...tpl.content.children];
  const current = new Map([...ul.children].map(el => [el.dataset.key, el]));
  const wanted = fresh.map((el, i) => {
    const key = rowKey(el, i);
    const markup = el.outerHTML;
    const node = current.get(key);
    current.delete(key);
    if (!node) {
      el.dataset.key = key;
      lastHtml.set(el, markup);
      return el;
    }
    if (lastHtml.get(node) !== markup) {
      for (const a of [...node.attributes]) if (a.name !== 'data-key' && !el.hasAttribute(a.name)) node.removeAttribute(a.name);
      for (const a of [...el.attributes]) node.setAttribute(a.name, a.value);
      node.innerHTML = el.innerHTML;
      lastHtml.set(node, markup);
    }
    return node;
  });
  for (const stale of current.values()) stale.remove();
  wanted.forEach((node, i) => { if (ul.children[i] !== node) ul.insertBefore(node, ul.children[i] || null); });
}

// Everything waiting on the user: sessions that need them or finished unseen, unseen runs, due reminders.
function needsYou(d) {
  const live = d.sessions.filter(s => s.live);
  return {
    waiting: live.filter(s => sessionDot(s) === 'waiting'),
    yourTurn: live.filter(s => sessionDot(s) === 'idle'),
    runs: d.runs.filter(r => ['idle', 'waiting'].includes(runDot(r))),
    reminders: d.todos.filter(t => t.status === 'open' && t.remindAt && !t.remindAck && new Date(t.remindAt) <= new Date()),
    workflows: (d.workflows || []).filter(w => w.due && !w.due.runId),
  };
}

// ---------- sidebar ----------
function renderSidebar() {
  const d = S.data;
  const open = d.todos.filter(t => t.status === 'open').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const done = d.todos.filter(t => t.status === 'done').sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
  const n = needsYou(d);
  $('#nav-needs').textContent = (n.waiting.length + n.yourTurn.length + n.runs.length + n.reminders.length + n.workflows.length) || '';
  $('#home-btn').classList.toggle('active', S.view.type === 'home');
  $('#settings-btn').classList.toggle('active', S.view.type === 'settings');
  $('#todo-count').textContent = open.length || '';
  $('#done-count').textContent = done.length || '';
  patchList($('#todo-list'), open.length ? open.map(todoRow).join('') : '<li class="empty">Nothing open. Add one above.</li>');
  patchList($('#done-list'), done.slice(0, 30).map(todoRow).join(''));

  const live = liveSessions();
  const closed = d.sessions.filter(s => !s.live).slice(0, 8);
  const restorable = d.sessions.filter(s => !s.live && s.restorable);
  const restoreBar = restorable.length
    ? `<li class="restore">${restorable.length} session${restorable.length === 1 ? ' was' : 's were'} open when Stroll quit
        <span><button class="btn primary" data-act="restore-all">Resume all</button><button class="btn ghost" data-act="restore-dismiss">Dismiss</button></span></li>`
    : '';
  patchList($('#session-list'), restoreBar
    + (live.length ? live.map(sessionRow).join('') : '<li class="empty">No live sessions.</li>')
    + (closed.length ? `<li class="divider">Closed<button class="link-btn" data-act="clear-closed">Clear</button></li>${closed.map(sessionRow).join('')}` : ''));

  const runs = d.runs.slice().sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  const activeRuns = runs.filter(r => r.status !== 'reviewed');
  $('#run-count').textContent = activeRuns.length || '';
  const finished = runs.filter(r => r.status !== 'running' && !r.unseen).length;
  patchList($('#run-list'), runs.length
    ? [...activeRuns, ...runs.filter(r => r.status === 'reviewed').slice(0, 5)].map(runRow).join('')
      + (finished ? `<li class="divider">${finished} finished<button class="link-btn" data-act="clear-runs">Clear</button></li>` : '')
    : '<li class="empty">Hand off a to-do to run it here.</li>');

  patchList($('#workflow-list'), (d.workflows || []).map(workflowRow).join('')
    || '<li class="empty">Add one with +, or right-click a session and save it as a workflow.</li>');

  patchList($('#recent-list'), S.recent.length ? S.recent.map(recentRow).join('') : `<li class="empty">${S.recentLoaded ? 'Nothing recent.' : 'Loading…'}</li>`);

  const attention = { todos: n.reminders.length, sessions: n.waiting.length + n.yourTurn.length, runs: n.runs.length, workflows: n.workflows.length };
  for (const [key, count] of Object.entries(attention)) document.querySelector(`section[data-section="${key}"]`)?.toggleAttribute('data-alert', count > 0);

  $('#multi-bar').hidden = S.selected.size === 0;
  $('#multi-count').textContent = `${S.selected.size} to-do${S.selected.size === 1 ? '' : 's'} selected`;
}

// Where an open to-do stands: a live linked session makes it "In progress" (tinted by that
// session's state, "Needs you" when one is waiting), then background runs, else nothing.
function todoState(t) {
  if (t.status !== 'open') return null;
  const live = t.sessionIds.map(session).filter(s => s && s.live);
  if (live.length) {
    const dots = live.map(sessionDot);
    const tone = ['waiting', 'idle', 'working'].find(d => dots.includes(d)) || 'active';
    return { tone, label: tone === 'waiting' ? 'Needs you' : 'In progress', title: `${live.length} live session${live.length === 1 ? '' : 's'}` };
  }
  const runs = t.runIds.map(run).filter(Boolean);
  if (runs.some(r => r.pendingApproval)) return { tone: 'waiting', label: 'Needs you', title: 'A background run is waiting for your OK' };
  if (runs.some(r => r.status === 'running')) return { tone: 'working', label: 'Handed off', title: 'Background run in progress' };
  if (runs.some(r => r.unseen && r.status === 'ready')) return { tone: 'idle', label: 'Ready', title: 'Background run finished' };
  return null;
}
// Where a to-do's work is happening now, for "Go to": a live session (one that needs you first,
// then the latest), else an active or unread background run. Starting would make a new one.
function activeWork(t) {
  const live = t.sessionIds.map(session).filter(s => s && s.live);
  if (live.length) {
    const rank = s => ({ waiting: 0, idle: 1, working: 2 }[sessionDot(s)] ?? 3);
    live.sort((a, b) => rank(a) - rank(b) || (b.lastActivityAt || '').localeCompare(a.lastActivityAt || ''));
    return { type: 'session', id: live[0].id };
  }
  const runs = t.runIds.map(run).filter(Boolean);
  const r = runs.find(x => x.pendingApproval) || runs.find(x => x.status === 'running') || runs.find(x => x.unseen && x.status === 'ready');
  return r ? { type: 'run', id: r.id } : null;
}
const workIcon = w => (w.type === 'session' ? ICON.terminal : ICON.activity);

const pillHtml = st => (st ? `<span class="pill ${st.tone}" title="${esc(st.title || '')}"><i></i>${esc(st.label)}</span>` : '');

function todoRow(t) {
  const isActive = S.view.type === 'todo' && S.view.id === t.id;
  const done = t.status === 'done';
  const work = done ? null : activeWork(t);
  const reminder = t.remindAt && !t.remindedAt && !done
    ? `<span class="reminder" title="Reminder ${esc(new Date(t.remindAt).toLocaleString())}">${ICON.clock}</span>` : '';
  return `<li class="row ${isActive ? 'active' : ''} ${S.selected.has(t.id) ? 'selected' : ''}" data-kind="todo" data-id="${esc(t.id)}">
    <button class="check ${done ? 'done' : ''}" data-act="toggle" title="${done ? 'Reopen' : 'Mark done'}">${ICON.check}</button>
    <div class="main"><div class="title">${esc(t.title)}</div></div>
    <span class="meta">${pillHtml(todoState(t))}${reminder}</span>
    ${done ? '' : `<span class="row-actions">${work ? `<button class="icon-btn" data-act="goto-work" title="Go to its ${work.type === 'session' ? 'session' : 'background run'}">${workIcon(work)}</button>` : ''}<button class="icon-btn" data-act="start" title="${work ? 'Start another session' : 'Start a session'}">${ICON.play}</button><button class="icon-btn" data-act="handoff" title="Hand off to a background run">${ICON.handoff}</button></span>`}
  </li>`;
}

function sessionRow(s) {
  const st = sessionState(s);
  const isActive = S.view.type === 'session' && S.view.id === s.id;
  const preview = s.preview || (s.live ? SESSION_LABEL[st] || st : 'closed');
  return `<li class="row ${isActive ? 'active' : ''} ${s.live ? '' : 'dim'}" data-kind="session" data-id="${esc(s.id)}" title="${esc(shortDir(s.cwd))}">
    ${dotHtml(sessionDot(s))}
    <div class="main"><div class="title-line"><span class="title">${esc(s.title || 'Untitled session')}</span>${s.muted ? `<span class="muted-icon" title="Notifications muted">${ICON.mute}</span>` : ''}<span class="when">${ago(s.lastActivityAt)}</span></div>
    <div class="sub">${esc(preview)}</div></div>
  </li>`;
}

function runRow(r) {
  const isActive = S.view.type === 'run' && S.view.id === r.id;
  const preview = r.pendingApproval ? `Needs your OK: ${r.pendingApproval.detail}`
    : r.status === 'running' ? (r.lastActivity || 'Starting…')
      : `${RUN_LABEL[r.status] || r.status}${r.result ? ` · ${plainText(r.result).slice(0, 120)}` : ''}`;
  return `<li class="row ${isActive ? 'active' : ''} ${r.status === 'reviewed' ? 'dim' : ''}" data-kind="run" data-id="${esc(r.id)}">
    ${dotHtml(runDot(r))}
    <div class="main"><div class="title-line"><span class="title">${esc(r.title)}</span><span class="when">${ago(r.finishedAt || r.startedAt)}</span></div>
    <div class="sub">${esc(preview)}</div></div>
  </li>`;
}

function recentRow(r) {
  const fresh = Date.now() - new Date(r.lastActivityAt).getTime() < 5 * 60 * 1000;
  return `<li class="row" data-kind="recent" data-id="${esc(r.id)}" title="${esc(r.title)}">
    ${dotHtml('none')}
    <div class="main"><div class="title">${esc(r.title)}</div>
    <div class="sub">${fresh ? 'active elsewhere · ' : ''}${esc(shortDir(r.cwd))} · ${ago(r.lastActivityAt)}</div></div>
  </li>`;
}

// ---------- terminals ----------
function ensureTerm(id) {
  if (terms.has(id)) return terms.get(id);
  const el = document.createElement('div');
  el.className = 'term';
  el.dataset.id = id;
  $('#terminals').appendChild(el);
  const cfg = S.data.config.terminal || {};
  const term = new Terminal({
    fontFamily: cfg.fontFamily || 'Menlo, monospace',
    fontSize: cfg.fontSize || 13,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10000,
    theme: THEME,
    macOptionClickForcesSelection: true,
    macOptionIsMeta: cfg.optionIsMeta === true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => api.invoke('open:external', uri)));
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.open(el);
  const entry = { term, fit, el, lastSeq: 0, ready: false, queue: [], replaying: false };
  terms.set(id, entry);

  term.onData(d => { if (!entry.replaying) api.send('session:write', id, d); });
  term.onBinary(d => { if (!entry.replaying) api.send('session:write', id, d); });
  term.attachCustomKeyEventHandler(ev => {
    if (ev.type !== 'keydown') return !ev.metaKey;
    // Claude Code sends no hook when a turn is interrupted; tell Stroll so the dot settles.
    if (ev.key === 'Escape') api.send('session:interrupt', id);
    // Shift+Enter → newline in Claude Code's prompt (same sequence /terminal-setup configures).
    if (ev.key === 'Enter' && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) { ev.preventDefault(); api.send('session:write', id, '\x1b\r'); return false; }
    if (ev.metaKey && ev.key === 'c' && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); return false; }
    return !ev.metaKey; // ⌘ shortcuts belong to the app and the menu (⌘V paste still reaches the terminal)
  });
  loadBuffer(id);
  return entry;
}

function loadBuffer(id) {
  const e = terms.get(id);
  e.ready = false;
  api.invoke('session:buffer', id).then(({ data, seq, modes }) => {
    // While replaying, xterm answers the old terminal queries in the history (cursor reports,
    // colours); those answers must not be typed into the live session. `modes` re-applies
    // terminal modes (bracketed paste, focus) whose setup scrolled out of the buffer.
    e.replaying = true;
    e.term.write(`${data || ''}${modes || ''}`, () => {
      e.replaying = false;
      e.lastSeq = seq;
      e.ready = true;
      for (const [s, d] of e.queue) if (s > e.lastSeq) { e.term.write(d); e.lastSeq = s; }
      e.queue = [];
    });
  });
}

// A resumed session is a new process whose output sequence restarts at 1; queue its output
// until loadBuffer() has replayed what the main process already holds.
function resetTerm(id) {
  const e = terms.get(id);
  if (!e) return;
  e.term.reset();
  e.lastSeq = 0;
  e.ready = false;
  e.queue = [];
}

function fitVisible() {
  if (S.view.type !== 'session') return;
  const e = terms.get(S.view.id);
  if (!e || !e.el.classList.contains('visible')) return;
  try {
    e.fit.fit();
    api.send('session:resize', S.view.id, e.term.cols, e.term.rows);
  } catch (_) { /* not laid out yet */ }
}

api.on('session:data', (id, seq, data) => {
  const e = terms.get(id);
  if (!e) return; // replayed from the main-process buffer when first shown
  if (!e.ready) { e.queue.push([seq, data]); return; }
  if (seq <= e.lastSeq) return;
  e.term.write(data);
  e.lastSeq = seq;
});
api.on('session:exit', id => { if (S.view.type === 'session' && S.view.id === id) renderMain(); });

// ---------- main views ----------
function navigate(view) {
  S.view = view;
  api.send('ui:focus', view);
  renderSidebar();
  renderMain();
}

// A view can be opened for something created a moment ago (a new session, a hand-off) before
// the state:changed push arrives; fetch fresh state once before giving up on it.
async function ensureKnown(view) {
  const find = { session, run, todo, workflow }[view.type];
  if (!find || find(view.id)) return true;
  const fresh = await api.invoke('state:get');
  S.data = { ...fresh, config: S.data.config };
  renderSidebar();
  return !!find(view.id);
}

function renderMain() {
  const v = S.view;
  const find = { session, run, todo, workflow }[v.type];
  if (find && !find(v.id)) {
    ensureKnown(v).then(ok => { if (S.view === v) { if (ok) renderMain(); else navigate({ type: 'home' }); } });
    return;
  }
  const header = $('#view-header');
  const panel = $('#panel');
  const termsEl = $('#terminals');
  const showTerm = v.type === 'session';
  termsEl.hidden = !showTerm;
  panel.hidden = showTerm;
  for (const [tid, e] of terms) e.el.classList.toggle('visible', showTerm && tid === v.id);
  termsEl.querySelectorAll('.term-ended').forEach(n => n.remove());
  if (v.type !== 'home') panel.dataset.view = ''; // the overview rebuilds its skeleton on return

  if (v.type === 'session') return renderSession(header, termsEl);
  if (v.type === 'run') return renderRun(header, panel);
  if (v.type === 'todo') return renderTodo(header, panel);
  if (v.type === 'workflow') return renderWorkflow(header, panel);
  if (v.type === 'settings') return renderSettings(header, panel);
  return renderHome(header, panel);
}

function headerChips(todoIds) {
  return (todoIds || []).map(todo).filter(Boolean)
    .map(t => `<span class="chip" data-goto-todo="${esc(t.id)}" title="Open to-do: ${esc(t.title)}">${ICON.read}${esc(t.title.slice(0, 40))}</span>`).join('');
}

function renderSession(header, termsEl) {
  const s = session(S.view.id);
  if (!s) return navigate({ type: 'home' });
  header.innerHTML = `
    <span class="h-title" id="session-title" contenteditable="true" spellcheck="false" title="Click to rename">${esc(s.title || 'Untitled session')}</span>
    ${sessionPill(s)}
    <span class="h-path" title="${esc(s.cwd || '')}">${ICON.folder}${esc(shortDir(s.cwd))}</span>
    ${headerChips(s.todoIds)}
    <span class="spacer"></span>
    ${s.live ? `<button class="btn ghost" data-act="mark-unread" title="Show the blue dot again so you come back to it">${ICON.unread}Mark unread</button>` : ''}
    <button class="btn ghost" data-act="link-todo">${ICON.link}Link to-do</button>
    ${s.live
    ? `<button class="btn danger" data-act="kill-session">${ICON.stop}End session</button>`
    : `<button class="btn primary" data-act="resume-session">${ICON.resume}Resume</button><button class="btn danger" data-act="forget-session">${ICON.trash}Remove</button>`}
  `;
  const titleEl = $('#session-title');
  titleEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); } });
  titleEl.addEventListener('blur', () => {
    const t = titleEl.textContent.trim();
    if (t && t !== s.title) api.invoke('session:rename', s.id, t);
  });

  if (s.live || terms.has(s.id)) {
    const e = ensureTerm(s.id);
    e.el.classList.add('visible');
    requestAnimationFrame(() => { fitVisible(); if (s.live) e.term.focus(); });
  }
  if (!s.live) {
    const bar = document.createElement('div');
    bar.className = 'term-ended';
    bar.innerHTML = `This session is closed. <button class="btn primary" data-act="resume-session">${ICON.resume}Resume it here</button>`;
    termsEl.appendChild(bar);
  }
}

const STATE_TITLE = { working: 'Working', waiting: 'Needs you', idle: 'Your turn', starting: 'Starting', closed: 'Closed' };
function sessionPill(s) {
  const st = sessionState(s);
  const dot = sessionDot(s);
  return `<span class="pill ${dot === 'none' ? 'neutral' : dot}" id="session-pill"><i></i>${STATE_TITLE[st] || st}</span>`;
}

function updateSessionHeader() {
  const s = session(S.view.id);
  if (!s) return;
  const pill = $('#session-pill');
  const fresh = sessionPill(s);
  if (pill && pill.outerHTML !== fresh) pill.outerHTML = fresh;
  const liveBtns = !!$('#view-header [data-act="kill-session"]');
  if (liveBtns !== !!s.live) renderMain();
}

const runHeaderKey = r => `${r.status}:${runDot(r)}:${r.allowAll ? 'all' : ''}`;
const ALLOW_ALL_HELP = 'No prompts: it runs scripts, fetches and other tools without asking. Edits, pushes, PRs and sending messages stay blocked, but a script it runs can do anything you can.';

async function renderRun(header, panel) {
  const r = run(S.view.id);
  if (!r) return navigate({ type: 'home' });
  const tone = { running: 'working', failed: 'failed', interrupted: 'failed' }[r.status] || (r.status === 'ready' && r.unseen ? 'idle' : 'neutral');
  header.dataset.status = runHeaderKey(r);
  header.innerHTML = `
    <span class="h-title">${esc(r.title)}</span>
    <span class="pill ${tone}"><i></i>${esc((RUN_LABEL[r.status] || r.status).replace(/^./, c => c.toUpperCase()))}</span>
    <span class="h-meta" id="run-meta"></span>
    ${headerChips(r.todoIds)}
    <span class="spacer"></span>
    ${r.status === 'running' && r.allowAll ? `<span class="pill waiting" title="${esc(ALLOW_ALL_HELP)}"><i></i>Allowing all</span><button class="btn ghost" data-act="run-ask-again">Ask me again</button>` : ''}
    ${r.status === 'running' ? `<button class="btn danger" data-act="cancel-run">${ICON.stop}Cancel</button>` : ''}
    ${r.status !== 'running' ? `<button class="btn primary" data-act="open-run">${ICON.terminal}Continue in a session</button>` : ''}
    ${r.status === 'ready' || r.status === 'failed' ? `<button class="btn ghost" data-act="reviewed-run">${ICON.read}Mark reviewed</button>` : ''}
    ${r.status !== 'running' ? `<button class="btn danger" data-act="forget-run">${ICON.trash}Remove</button>` : ''}
  `;
  updateRunMeta();
  panel.innerHTML = `<div class="run-view">
    <details class="run-prompt-wrap"><summary>Prompt</summary><div class="run-prompt">${esc(r.prompt)}</div></details>
    <div id="run-approval"></div>
    <div class="events" id="run-events"></div>
    <div id="run-result"></div>
  </div>`;
  const events = await api.invoke('run:events', r.id);
  if (S.view.type !== 'run' || S.view.id !== r.id) return;
  // The final assistant message is the result; show it once, in the result card.
  const resultText = (run(r.id)?.result || '').trim();
  renderRunApproval();
  $('#run-events').innerHTML = events.filter(e => e.kind !== 'result' && !(e.kind === 'text' && resultText && e.text.trim() === resultText)).map(eventHtml).join('');
  renderRunResult();
  panel.scrollTop = panel.scrollHeight;
}

function updateRunMeta() {
  const r = run(S.view.id);
  const meta = $('#run-meta');
  if (!r || !meta) return;
  const bits = [shortDir(r.cwd), `started ${agoText(r.startedAt)}`];
  if (r.durationMs) bits.push(fmtDuration(r.durationMs));
  if (r.costUsd != null) bits.push(`$${r.costUsd.toFixed(2)}`);
  meta.textContent = bits.join(' · ');
}

function renderRunApproval() {
  const r = run(S.view.id);
  const box = $('#run-approval');
  if (!r || !box) return;
  const a = r.pendingApproval;
  if ((box.dataset.id || '') === (a?.id || '')) return;
  box.dataset.id = a?.id || '';
  if (!a) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="approval">
    <div class="ap-head">${ICON.alert}<b>This run needs your OK</b><span class="h-meta">${esc(a.summary)} · asked ${agoText(a.requestedAt)}</span></div>
    <pre class="ap-detail">${esc(a.detail)}</pre>
    ${a.rule
    ? `<label class="ap-rule"><span>"Always allow" adds this rule for future runs</span><input type="text" id="ap-rule" value="${esc(a.rule)}" spellcheck="false"></label>`
    : '<p class="help">Commands with pipes, loops or variables can only be allowed once.</p>'}
    <div class="actions">
      <button class="btn primary" data-act="ap-allow">${ICON.check}Allow once</button>
      ${a.rule ? `<button class="btn" data-act="ap-always">${ICON.read}Always allow</button>` : ''}
      <button class="btn" data-act="ap-all" title="${esc(ALLOW_ALL_HELP)}">Allow all for this run</button>
      <button class="btn danger" data-act="ap-deny">Deny</button>
      <span class="help">No answer in 15 minutes counts as Deny.</span>
    </div>
  </div>`;
}

function renderRunResult() {
  const r = run(S.view.id);
  const box = $('#run-result');
  if (!r || !box) return;
  if (r.status === 'running') { box.innerHTML = `<div class="h-meta">${r.pendingApproval ? 'Paused until you answer above.' : `Working… ${esc(r.lastActivity || '')}`}</div>`; return; }
  const failed = r.status === 'failed' || r.status === 'interrupted' || r.status === 'cancelled';
  const body = r.result || r.error || (r.status === 'interrupted' ? 'Stroll was closed while this run was going.' : 'No result.');
  box.innerHTML = `<div class="result ${failed ? 'failed' : ''}">
    <h4><span>${failed ? esc(RUN_LABEL[r.status] || 'Failed') : 'Result'}</span><button class="btn" data-act="copy-result">Copy</button></h4>
    <div class="md">${lightMarkdown(body)}</div>
    ${r.permissionDenials?.length ? `<div class="denials">Blocked tools (needs you): ${esc([...new Set(r.permissionDenials)].join(', '))}</div>` : ''}
  </div>`;
}

function eventHtml(ev) {
  if (ev.kind === 'text') return `<div class="ev-text">${lightMarkdown(ev.text)}</div>`;
  if (ev.kind === 'tool') return `<div class="ev-tool"><b>${esc(ev.name)}</b> ${esc(ev.detail)}</div>`;
  if (ev.kind === 'tool_error') return `<div class="ev-error">✗ ${esc(ev.text)}</div>`;
  return '';
}

api.on('run:event', (id, ev) => {
  if (S.view.type !== 'run' || S.view.id !== id || ev.kind === 'result') return;
  const list = $('#run-events');
  if (!list) return;
  const panel = $('#panel');
  const atBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 60;
  list.insertAdjacentHTML('beforeend', eventHtml(ev));
  if (atBottom) panel.scrollTop = panel.scrollHeight;
});

function renderTodo(header, panel) {
  const t = todo(S.view.id);
  if (!t) return navigate({ type: 'home' });
  const done = t.status === 'done';
  header.innerHTML = `
    <button class="check ${done ? 'done' : ''}" data-act="toggle-current" title="${done ? 'Reopen' : 'Mark done'}">${ICON.check}</button>
    <span class="h-title">${esc(t.title)}</span>
    <span id="todo-pill">${pillHtml(todoState(t))}</span>
    <span class="h-meta">added ${agoText(t.createdAt)}${done ? ` · done ${agoText(t.doneAt)}` : ''}</span>
    <span class="spacer"></span>
    ${done ? '' : `<span id="todo-start">${todoStartButtons(t)}</span>`}
    <button class="btn ghost" data-act="toggle-current">${done ? `${ICON.resume}Reopen` : `${ICON.check}Mark done`}</button>
    <button class="btn danger" data-act="delete-current">${ICON.trash}Delete</button>
  `;
  panel.innerHTML = `<div class="todo-view">
    <div class="field"><label>Title</label><input type="text" id="todo-title" value="${esc(t.title)}"></div>
    <div class="field"><label>Notes</label><textarea id="todo-notes" placeholder="Context, links, what done looks like…">${esc(t.notes)}</textarea></div>
    <div class="field"><label>Reminder</label><div class="inline"><input type="datetime-local" id="todo-remind" value="${toLocalInput(t.remindAt)}">
      <button class="btn" data-remind="60">In 1h</button><button class="btn" data-remind="tomorrow">Tomorrow 9:00</button><button class="btn ghost" data-remind="clear">Clear</button></div></div>
    <div class="field"><label>Working directory</label><div class="inline"><input type="text" id="todo-cwd" value="${esc(t.cwd || '')}" placeholder="${esc(S.data.config.defaultCwd)}"><button class="btn" data-act="pick-todo-cwd">Browse…</button></div></div>
    <div class="field links" id="todo-links"></div>
  </div>`;
  renderTodoLinks();

  const save = patch => api.invoke('todo:update', t.id, patch);
  $('#todo-title').addEventListener('change', e => { const v = e.target.value.trim(); if (v) save({ title: v }); });
  $('#todo-notes').addEventListener('change', e => save({ notes: e.target.value }));
  $('#todo-cwd').addEventListener('change', e => save({ cwd: e.target.value.trim() || null }));
  $('#todo-remind').addEventListener('change', e => save({ remindAt: e.target.value ? new Date(e.target.value).toISOString() : null }));
}

// With work already going, "Go to" leads and starting another session is the secondary choice.
function todoStartButtons(t) {
  const work = activeWork(t);
  return `${work ? `<button class="btn primary" data-act="goto-work-current">${workIcon(work)}Go to ${work.type === 'session' ? 'session' : 'run'}</button>` : ''}`
    + `<button class="btn ${work ? '' : 'primary'}" data-act="start-current">${ICON.play}${work ? 'New session' : 'Start session'}</button>`
    + `<button class="btn" data-act="handoff-current">${ICON.handoff}Hand off</button>`;
}

function renderTodoLinks() {
  const t = todo(S.view.id);
  const box = $('#todo-links');
  if (!t || !box) return;
  const pill = $('#todo-pill');
  const pillMarkup = pillHtml(todoState(t));
  if (pill && pill.innerHTML !== pillMarkup) pill.innerHTML = pillMarkup;
  const start = $('#todo-start');
  const startMarkup = start && todoStartButtons(t);
  if (start && start.dataset.markup !== startMarkup) { start.innerHTML = startMarkup; start.dataset.markup = startMarkup; }
  const sess = t.sessionIds.map(session).filter(Boolean);
  const runs = t.runIds.map(run).filter(Boolean);
  if (!box.querySelector('ul')) box.innerHTML = '<label>Linked work</label><ul class="list"></ul>';
  patchList(box.querySelector('ul'), sess.length + runs.length === 0
    ? '<li class="empty" style="padding-left:0">None yet. Start a session or hand it off.</li>'
    : `${sess.map(sessionRow).join('')}${runs.map(runRow).join('')}`);
}

function renderHome(header, panel) {
  const d = S.data;
  const live = d.sessions.filter(s => s.live);
  const n = needsYou(d);
  const needs = [
    ...n.waiting.map(sessionRow),
    ...n.runs.map(runRow),
    ...n.reminders.map(todoRow),
    ...n.workflows.map(workflowRow),
    ...n.yourTurn.map(sessionRow),
  ];
  const progress = [...live.filter(s => s.status === 'working' || s.status === 'starting').map(sessionRow), ...d.runs.filter(r => r.status === 'running' && !r.pendingApproval).map(runRow)];
  const open = d.todos.filter(t => t.status === 'open').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  // Built once per visit; later state pushes only patch the counts and lists.
  if (panel.dataset.view !== 'home') {
    header.innerHTML = `<span class="h-title">Overview</span><span class="spacer"></span><button class="btn primary" data-act="new-session">${ICON.plus}New session</button>`;
    const card = (cls, icon, title, id) => `<div class="card ${cls}"><h3><span class="card-icon">${ICON[icon]}</span>${title}<span class="count" id="${id}-n"></span></h3><ul class="list" id="${id}"></ul></div>`;
    panel.innerHTML = `
      <div class="overview-head"><h1>${greeting()}</h1><span class="h-meta" id="ov-meta"></span></div>
      <div class="overview">
        ${card('needs', 'bell', 'Needs you', 'ov-needs')}
        ${card('progress', 'activity', 'In progress', 'ov-progress')}
        ${card('todos', 'list', 'To-dos', 'ov-todos')}
      </div>`;
    panel.dataset.view = 'home';
  }
  const empty = text => `<li class="empty">${text}</li>`;
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  $('#ov-meta').textContent = `${today} · ${live.length} live session${live.length === 1 ? '' : 's'} · ${d.runs.filter(r => r.status === 'running').length} in the background · ${open.length} open to-do${open.length === 1 ? '' : 's'}`;
  $('#ov-needs-n').textContent = needs.length || '';
  $('#ov-progress-n').textContent = progress.length || '';
  $('#ov-todos-n').textContent = open.length || '';
  patchList($('#ov-needs'), needs.join('') || empty('All clear.'));
  patchList($('#ov-progress'), progress.join('') || empty('Nothing running.'));
  patchList($('#ov-todos'), open.map(todoRow).join('') || empty('Nothing open.'));
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 19 ? 'Good afternoon' : 'Good evening';
}

// ---------- modals ----------
function modal(html, onMount) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="backdrop"><div class="modal">${html}</div></div>`;
  const close = () => { root.innerHTML = ''; if (S.view.type === 'session') terms.get(S.view.id)?.term.focus(); };
  root.querySelector('.backdrop').addEventListener('mousedown', e => { if (e.target.classList.contains('backdrop')) close(); });
  onMount(root.querySelector('.modal'), close);
}

function dirField(initial) {
  const dirs = S.data.recentDirs.slice(0, 8);
  return `<div class="field"><label>Working directory</label>
    <div class="inline"><input type="text" name="cwd" value="${esc(initial)}"><button type="button" class="btn" data-pick-dir>Browse…</button></div>
    ${dirs.length ? `<div class="dir-chips">${dirs.map(d => `<span class="chip" data-dir="${esc(d)}">${esc(shortDir(d))}</span>`).join('')}</div>` : ''}</div>`;
}

function wireDirField(m) {
  const input = m.querySelector('input[name=cwd]');
  m.querySelectorAll('[data-dir]').forEach(c => c.addEventListener('click', () => { input.value = c.dataset.dir; }));
  m.querySelector('[data-pick-dir]').addEventListener('click', async () => {
    const d = await api.invoke('dialog:pickDir', input.value);
    if (d) input.value = d;
  });
  return input;
}

function startModal(todoIds = []) {
  const todos = todoIds.map(todo).filter(Boolean);
  const title = todos.length === 1 ? todos[0].title : todos.length ? todos.map(t => t.title).join(' + ').slice(0, 80) : '';
  const cwd = todos.find(t => t.cwd)?.cwd || S.data.recentDirs[0] || S.data.config.defaultCwd;
  modal(`
    <h2>${todos.length ? 'Start a session' : 'New session'}</h2>
    ${todos.length ? `<div class="sub">For: ${todos.map(t => esc(t.title)).join(' · ')}. Claude gets the to-do${todos.length > 1 ? 's' : ''} as context.</div>` : ''}
    <div class="field"><label>Name</label><input type="text" name="title" value="${esc(title)}" placeholder="Optional"></div>
    ${dirField(cwd)}
    <div class="field"><label>First message</label><textarea name="first" rows="3" placeholder="Optional. Leave empty to start typing in the session."></textarea></div>
    <footer><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-go>${ICON.play}Start <kbd>⌘↩</kbd></button></footer>
  `, (m, close) => {
    const cwdInput = wireDirField(m);
    const go = async () => {
      let id;
      try {
        id = await api.invoke('session:create', {
          cwd: cwdInput.value.trim(), title: m.querySelector('[name=title]').value.trim() || null,
          todoIds, firstMessage: m.querySelector('[name=first]').value,
        });
      } catch (err) { return flashError(err); }
      close();
      S.selected.clear();
      if (terms.has(id)) resetTerm(id);
      navigate({ type: 'session', id });
    };
    m.querySelector('[data-go]').addEventListener('click', go);
    m.querySelector('[data-close]').addEventListener('click', close);
    m.addEventListener('keydown', e => { if (e.key === 'Enter' && e.metaKey) go(); if (e.key === 'Escape') close(); });
    m.querySelector(todos.length ? '[name=first]' : '[name=title]').focus();
  });
}

function handoffModal(todoIds) {
  const todos = todoIds.map(todo).filter(Boolean);
  const cwd = todos.find(t => t.cwd)?.cwd || S.data.recentDirs[0] || S.data.config.defaultCwd;
  modal(`
    <h2>Hand off to a background run</h2>
    <div class="sub">${todos.map(t => esc(t.title)).join(' · ')}<br>It investigates and drafts, never edits, pushes or sends, and asks you before anything else. You'll get a notification when it's ready or needs you.</div>
    <div class="field"><label>Instructions</label><textarea name="instructions" rows="5" placeholder="Optional. What should it look at, what should the draft be?"></textarea></div>
    ${dirField(cwd)}
    ${toggle('handoff-allow-all', false, 'Allow everything it asks for', ALLOW_ALL_HELP)}
    <footer><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-go>${ICON.handoff}Hand off <kbd>⌘↩</kbd></button></footer>
  `, (m, close) => {
    const cwdInput = wireDirField(m);
    const go = async () => {
      let id;
      try {
        id = await api.invoke('todo:handoff', todoIds, {
          instructions: m.querySelector('[name=instructions]').value.trim(),
          cwd: cwdInput.value.trim() || null,
          allowAll: m.querySelector('#handoff-allow-all').checked,
        });
      } catch (err) { return flashError(err); }
      close();
      S.selected.clear();
      renderSidebar();
      flash(`Handed off: ${todos.length === 1 ? todos[0].title : `${todos.length} to-dos`}`, { type: 'run', id });
    };
    m.querySelector('[data-go]').addEventListener('click', go);
    m.querySelector('[data-close]').addEventListener('click', close);
    m.addEventListener('keydown', e => { if (e.key === 'Enter' && e.metaKey) go(); if (e.key === 'Escape') close(); });
    m.querySelector('[name=instructions]').focus();
  });
}

function linkTodoModal(sessionId) {
  const s = session(sessionId);
  const open = S.data.todos.filter(t => t.status === 'open' && !s.todoIds.includes(t.id));
  modal(`
    <h2>Link a to-do to this session</h2>
    <ul class="list pick-list" style="padding:0">${open.map(t => `<li class="row" data-pick="${esc(t.id)}"><div class="main"><div class="title">${esc(t.title)}</div></div></li>`).join('') || '<li class="empty">No other open to-dos.</li>'}</ul>
    <footer><button class="btn ghost" data-close>Close</button></footer>
  `, (m, close) => {
    m.querySelectorAll('[data-pick]').forEach(r => r.addEventListener('click', async () => { await api.invoke('session:link', sessionId, r.dataset.pick); close(); }));
    m.querySelector('[data-close]').addEventListener('click', close);
    m.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  });
}

let flashTimer = null;
function flash(text, view, { error = false, ms = 4000 } = {}) {
  let el = $('#flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'flash';
    document.body.appendChild(el);
  }
  el.className = error ? 'error' : '';
  el.innerHTML = `${error ? ICON.alert : ''}<span></span>`;
  el.querySelector('span').textContent = text;
  el.onclick = () => { if (view) navigate(view); el.remove(); };
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.remove(), ms);
}
// IPC errors arrive as "Error invoking remote method 'x': Error: <message>".
const errorText = err => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const flashError = err => flash(errorText(err), null, { error: true, ms: 9000 });

// ---------- actions ----------
// Done with a to-do that still has live sessions: offer to end them (they stay resumable
// under Closed). Reopening never asks.
function setTodoDone(id, done) {
  const t = todo(id);
  if (!t) return undefined;
  if (!done) return api.invoke('todo:update', id, { status: 'open' });
  const live = t.sessionIds.map(session).filter(s => s && s.live);
  if (!live.length) return api.invoke('todo:update', id, { status: 'done' });
  const many = live.length > 1;
  modal(`
    <h2>Mark “${esc(t.title)}” done?</h2>
    <div class="sub">${many ? `${live.length} sessions are` : 'A session is'} still open for this to-do. End ${many ? 'them' : 'it'} too? You can resume ${many ? 'them' : 'it'} later from Closed.</div>
    <ul class="confirm-list">${live.map(s => `<li>${sessionDot(s) === 'none' ? '' : dotHtml(sessionDot(s))}<div class="main"><div class="title">${esc(s.title || 'Untitled session')}</div><div class="sub">${esc(s.preview || STATE_TITLE[sessionState(s)] || '')}</div></div></li>`).join('')}</ul>
    <footer>
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn" data-keep>${ICON.check}Done, keep open</button>
      <button class="btn primary" data-end>${ICON.stop}Done and end ${many ? `${live.length} sessions` : 'session'}</button>
    </footer>
  `, (m, close) => {
    const finish = async endSessions => {
      close();
      await api.invoke('todo:update', id, { status: 'done' });
      if (endSessions) for (const s of live) await api.invoke('session:kill', s.id);
      flash(endSessions ? `Done · ended ${live.length} session${many ? 's' : ''}` : 'Done');
    };
    m.querySelector('[data-end]').addEventListener('click', () => finish(true));
    m.querySelector('[data-keep]').addEventListener('click', () => finish(false));
    m.querySelector('[data-close]').addEventListener('click', close);
    m.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    m.querySelector('[data-end]').focus();
  });
  return undefined;
}

function confirmModal({ title, body, confirm, danger = false }) {
  return new Promise(resolve => {
    modal(`<h2>${esc(title)}</h2>${body ? `<div class="sub">${esc(body)}</div>` : ''}
      <footer><button class="btn ghost" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(confirm)}</button></footer>`, (m, close) => {
      m.querySelector('[data-ok]').addEventListener('click', () => { close(); resolve(true); });
      m.querySelector('[data-close]').addEventListener('click', () => { close(); resolve(false); });
      m.addEventListener('keydown', e => { if (e.key === 'Escape') { close(); resolve(false); } });
      m.querySelector('[data-ok]').focus();
    });
  });
}

async function resumeSession(id, title, cwd) {
  if (terms.has(id)) resetTerm(id);
  try { await api.invoke('session:create', { resumeId: id, title, cwd }); } catch (err) { flashError(err); return false; }
  if (terms.has(id)) loadBuffer(id);
  navigate({ type: 'session', id });
  return true;
}

document.addEventListener('click', async e => {
  const actEl = e.target.closest('[data-act]');
  const rowEl = e.target.closest('[data-kind]');
  const gotoTodo = e.target.closest('[data-goto-todo]');
  if (gotoTodo) return navigate({ type: 'todo', id: gotoTodo.dataset.gotoTodo });

  if (actEl) {
    const act = actEl.dataset.act;
    const id = rowEl?.dataset.id;
    switch (act) {
      case 'toggle': return setTodoDone(id, todo(id)?.status !== 'done');
      case 'start': return startModal([id]);
      case 'goto-work': case 'goto-work-current': {
        const t = todo(act === 'goto-work' ? id : S.view.id);
        const work = t && activeWork(t);
        return work ? navigate(work) : undefined;
      }
      case 'handoff': return handoffModal([id]);
      case 'new-session': return startModal([]);
      case 'toggle-current': return setTodoDone(S.view.id, todo(S.view.id)?.status !== 'done');
      case 'start-current': return startModal([S.view.id]);
      case 'handoff-current': return handoffModal([S.view.id]);
      case 'delete-current': {
        const t = todo(S.view.id);
        if (await confirmModal({ title: `Delete “${t.title}”?`, body: 'Its linked sessions and runs stay; only the to-do goes.', confirm: 'Delete', danger: true })) {
          await api.invoke('todo:delete', t.id);
          navigate({ type: 'home' });
        }
        return undefined;
      }
      case 'pick-todo-cwd': {
        const d = await api.invoke('dialog:pickDir', $('#todo-cwd').value);
        if (d) { $('#todo-cwd').value = d; api.invoke('todo:update', S.view.id, { cwd: d }); }
        return undefined;
      }
      case 'link-todo': return linkTodoModal(S.view.id);
      case 'mark-unread': return api.invoke('session:markRead', S.view.id, false);
      case 'restore-all': {
        const toResume = S.data.sessions.filter(s => !s.live && s.restorable);
        const results = await Promise.allSettled(toResume.map(s => {
          if (terms.has(s.id)) resetTerm(s.id);
          return api.invoke('session:create', { resumeId: s.id, title: s.title, cwd: s.cwd });
        }));
        const failed = results.find(r => r.status === 'rejected');
        if (failed) flashError(failed.reason);
        for (const s of toResume) if (terms.has(s.id)) loadBuffer(s.id);
        await api.invoke('session:clearRestorable');
        return flash(`Resumed ${toResume.length} session${toResume.length === 1 ? '' : 's'}`);
      }
      case 'restore-dismiss': return api.invoke('session:clearRestorable');
      case 'clear-closed': {
        const closedIds = S.data.sessions.filter(s => !s.live).map(s => s.id);
        await api.invoke('sessions:clearClosed');
        for (const cid of closedIds) { terms.get(cid)?.term.dispose(); terms.get(cid)?.el.remove(); terms.delete(cid); }
        if (S.view.type === 'session' && closedIds.includes(S.view.id)) navigate({ type: 'home' });
        return flash(`Cleared ${closedIds.length} closed session${closedIds.length === 1 ? '' : 's'}`);
      }
      case 'clear-runs': {
        const n = await api.invoke('runs:clearFinished');
        if (S.view.type === 'run' && !run(S.view.id)) navigate({ type: 'home' });
        return flash(`Cleared ${n} finished run${n === 1 ? '' : 's'}`);
      }
      case 'ap-allow': case 'ap-always': case 'ap-deny': {
        const a = run(S.view.id)?.pendingApproval;
        if (!a) return undefined;
        const decision = act === 'ap-deny' ? 'deny' : 'allow';
        const rule = act === 'ap-always' ? ($('#ap-rule')?.value.trim() || a.rule) : null;
        await api.invoke('run:decide', a.id, decision, rule);
        return flash(act === 'ap-always' ? `Allowed, and saved “${rule}” for future runs` : decision === 'allow' ? 'Allowed once' : 'Denied');
      }
      case 'ap-all':
        await api.invoke('run:allowAll', S.view.id, true);
        return flash('Allowing everything this run asks for');
      case 'run-ask-again':
        await api.invoke('run:allowAll', S.view.id, false);
        return flash('This run asks you again');
      case 'wf-start': return startWorkflowModal(id);
      case 'wf-start-current': return startWorkflowModal(S.view.id);
      case 'wf-prepare': {
        try { flash('Preparing in the background', await api.invoke('workflow:prepare', S.view.id)); } catch (err) { flashError(err); }
        return undefined;
      }
      case 'wf-dismiss': return api.invoke('workflow:dismiss', S.view.id);
      case 'wf-open-run': return navigate({ type: 'run', id: workflow(S.view.id)?.due?.runId });
      case 'wf-continue': {
        const r = run(workflow(S.view.id)?.due?.runId);
        if (!r) return undefined;
        await api.invoke('run:reviewed', r.id);
        return resumeSession(r.id, r.title, r.cwd);
      }
      case 'wf-delete': {
        const w = workflow(S.view.id);
        if (await confirmModal({ title: `Delete “${w.name}”?`, body: 'Its past sessions and runs stay.', confirm: 'Delete', danger: true })) {
          await api.invoke('workflow:delete', w.id);
          navigate({ type: 'home' });
        }
        return undefined;
      }
      case 'wf-pick-cwd': {
        const d = await api.invoke('dialog:pickDir', $('#wf-cwd').value);
        if (d) { $('#wf-cwd').value = d; api.invoke('workflow:update', S.view.id, { cwd: d }); }
        return undefined;
      }
      case 'apply-update': return applyUpdate();
      case 'dismiss-update': S.update = null; return renderBanner();
      case 'open-settings': return navigate({ type: 'settings' });
      case 'kill-session': return api.invoke('session:kill', S.view.id);
      case 'resume-session': {
        const s = session(S.view.id);
        return resumeSession(s.id, s.title, s.cwd);
      }
      case 'forget-session': {
        const s = session(S.view.id);
        await api.invoke('session:forget', s.id);
        terms.get(s.id)?.term.dispose();
        terms.get(s.id)?.el.remove();
        terms.delete(s.id);
        return navigate({ type: 'home' });
      }
      case 'cancel-run': return api.invoke('run:cancel', S.view.id);
      case 'reviewed-run': return api.invoke('run:reviewed', S.view.id);
      case 'forget-run': { await api.invoke('run:forget', S.view.id); return navigate({ type: 'home' }); }
      case 'open-run': {
        const r = run(S.view.id);
        if (r.status === 'ready') api.invoke('run:reviewed', r.id);
        return resumeSession(r.id, r.title, r.cwd).then(ok => { if (ok) for (const t of r.todoIds) api.invoke('session:link', r.id, t); });
      }
      case 'copy-result': {
        const r = run(S.view.id);
        navigator.clipboard.writeText(r.result || r.error || '');
        return flash('Copied');
      }
      default: return undefined;
    }
  }

  if (rowEl) {
    const { kind, id } = rowEl.dataset;
    if (kind === 'todo' && (e.metaKey || e.shiftKey)) {
      if (S.selected.has(id)) S.selected.delete(id); else S.selected.add(id);
      return renderSidebar();
    }
    if (kind === 'recent') {
      const r = S.recent.find(x => x.id === id);
      const fresh = Date.now() - new Date(r.lastActivityAt).getTime() < 5 * 60 * 1000;
      if (fresh && !window.confirm('This session looks active in another terminal. Resuming it here too can make the two copies diverge. Resume anyway?')) return undefined;
      S.recent = S.recent.filter(x => x.id !== id);
      return resumeSession(id, r.title, r.cwd);
    }
    return navigate({ type: kind, id });
  }
  return undefined;
});

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-remind]');
  if (!btn || S.view.type !== 'todo') return;
  const kind = btn.dataset.remind;
  let at = null;
  if (kind === '60') at = new Date(Date.now() + 60 * 60 * 1000);
  if (kind === 'tomorrow') { at = new Date(); at.setDate(at.getDate() + 1); at.setHours(9, 0, 0, 0); }
  api.invoke('todo:update', S.view.id, { remindAt: at ? at.toISOString() : null });
  $('#todo-remind').value = at ? toLocalInput(at.toISOString()) : '';
});

// Right-click on a session or background run: mark it read (hide its dot) or unread (show it).
function closeMenu() { document.querySelector('.ctx-menu')?.remove(); }
document.addEventListener('contextmenu', e => {
  closeMenu();
  const row = e.target.closest('[data-kind="session"], [data-kind="run"]');
  if (!row) return;
  const { kind, id } = row.dataset;
  const item = kind === 'session' ? session(id) : run(id);
  if (!item) return;
  const dot = kind === 'session' ? sessionDot(item) : runDot(item);
  const items = [];
  if (dot === 'idle' || dot === 'waiting') items.push([`${ICON.read}Mark as read`, () => api.invoke(`${kind}:markRead`, id, true)]);
  else if (dot === 'none' && (kind === 'session' ? item.live : item.status !== 'running')) items.push([`${ICON.unread}Mark as unread`, () => api.invoke(`${kind}:markRead`, id, false)]);
  if (kind === 'session') items.push([item.muted ? `${ICON.bell}Unmute notifications` : `${ICON.mute}Mute notifications`, () => api.invoke('session:mute', id, !item.muted)]);
  items.push([`${ICON.list}Save as workflow`, async () => {
    const w = await api.invoke(kind === 'session' ? 'workflow:fromSession' : 'workflow:fromRun', id);
    if (!w) return;
    navigate({ type: 'workflow', id: w.id });
    flash('Saved as a workflow. Mark what changes each time with {{name}}.');
  }]);
  if (kind === 'run' && item.status !== 'running') items.push([`${ICON.trash}Remove`, async () => { await api.invoke('run:forget', id); if (S.view.type === 'run' && S.view.id === id) navigate({ type: 'home' }); }]);
  if (!items.length) return;
  e.preventDefault();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - 180)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - 60)}px`;
  menu.innerHTML = items.map(([label], i) => `<button data-i="${i}">${label}</button>`).join('');
  menu.addEventListener('click', ev => {
    const b = ev.target.closest('[data-i]');
    if (b) items[Number(b.dataset.i)][1]();
    closeMenu();
  });
  document.body.appendChild(menu);
});
document.addEventListener('mousedown', e => { if (!e.target.closest('.ctx-menu')) closeMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

$('#multi-bar').addEventListener('click', e => {
  const b = e.target.closest('[data-multi]');
  if (!b) return;
  const ids = [...S.selected];
  if (b.dataset.multi === 'start') startModal(ids);
  if (b.dataset.multi === 'handoff') handoffModal(ids);
  if (b.dataset.multi === 'clear') { S.selected.clear(); renderSidebar(); }
});

$('#quick-add').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#quick-add-input');
  const title = input.value.trim();
  if (!title) return;
  input.value = '';
  await api.invoke('todo:add', { title });
  flash(`Added: ${title}`);
});
$('#quick-add-input').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.target.value = ''; e.target.blur(); if (S.view.type === 'session') terms.get(S.view.id)?.term.focus(); }
});
$('#home-btn').addEventListener('click', () => navigate({ type: 'home' }));
$('#new-session-btn').addEventListener('click', () => startModal([]));
$('#new-workflow-btn').addEventListener('click', async () => {
  const w = await api.invoke('workflow:add', {});
  navigate({ type: 'workflow', id: w.id });
  setTimeout(() => $('#wf-name')?.select(), 100);
});
// ---------- sidebar sections: collapse (click the header) and reorder (drag it), kept in config
const SECTION_KEYS = ['todos', 'sessions', 'runs', 'workflows', 'recent'];
const SECTION_MIME = 'application/x-stroll-section';
const sectionOpen = key => !sidebarPrefs().collapsed.has(key);

function sidebarPrefs() {
  const sb = S.data?.config?.sidebar || {};
  const saved = (sb.order || []).filter(k => SECTION_KEYS.includes(k));
  return { order: [...saved, ...SECTION_KEYS.filter(k => !saved.includes(k))], collapsed: new Set(sb.collapsed || []) };
}

function applySidebarLayout() {
  const { order, collapsed } = sidebarPrefs();
  const box = $('#sidebar-scroll');
  for (const k of order) box.appendChild(box.querySelector(`section[data-section="${k}"]`));
  for (const sec of box.querySelectorAll('section[data-section]')) sec.classList.toggle('collapsed', collapsed.has(sec.dataset.section));
}

function saveSidebar(patch) {
  S.data.config.sidebar = { ...(S.data.config.sidebar || {}), ...patch };
  applySidebarLayout();
  api.invoke('config:set', { sidebar: patch });
}

const sidebarBox = $('#sidebar-scroll');
sidebarBox.addEventListener('click', e => {
  const header = e.target.closest('section[data-section] > header');
  if (!header || e.target.closest('button:not([data-sec-toggle])')) return;
  const key = header.parentElement.dataset.section;
  const { collapsed } = sidebarPrefs();
  if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
  saveSidebar({ collapsed: [...collapsed] });
  if (key === 'recent' && !collapsed.has(key)) refreshRecent();
});

let dragSection = null;
const clearDropMarks = () => sidebarBox.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
function endSectionDrag() {
  clearDropMarks();
  sidebarBox.querySelector('.dragging')?.classList.remove('dragging');
  dragSection = null;
}
sidebarBox.addEventListener('dragstart', e => {
  const header = e.target.closest?.('section[data-section] > header');
  if (!header) return;
  dragSection = header.parentElement.dataset.section;
  e.dataTransfer.setData(SECTION_MIME, dragSection);
  e.dataTransfer.effectAllowed = 'move';
  header.parentElement.classList.add('dragging');
});
// Handled here, before the document's file-drop handlers see it.
sidebarBox.addEventListener('dragover', e => {
  if (!dragSection) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
  clearDropMarks();
  const sec = e.target.closest('section[data-section]');
  if (!sec || sec.dataset.section === dragSection) return;
  const r = sec.getBoundingClientRect();
  sec.classList.add(e.clientY < r.top + Math.min(r.height / 2, 40) ? 'drop-before' : 'drop-after');
});
sidebarBox.addEventListener('drop', e => {
  if (!dragSection) return;
  e.preventDefault();
  e.stopPropagation();
  const target = sidebarBox.querySelector('.drop-before, .drop-after');
  if (target) {
    const order = sidebarPrefs().order.filter(k => k !== dragSection);
    order.splice(order.indexOf(target.dataset.section) + (target.classList.contains('drop-before') ? 0 : 1), 0, dragSection);
    saveSidebar({ order });
  }
  endSectionDrag();
});
sidebarBox.addEventListener('dragend', endSectionDrag);

// Ctrl+Tab / Ctrl+Shift+Tab: next / previous live session, in sidebar order. The order is
// frozen while Ctrl is held, so a session changing status mid-cycle doesn't reshuffle it.
let cycleOrder = null;
function cycleSessions(step) {
  cycleOrder = cycleOrder || liveSessions().map(s => s.id);
  const ids = cycleOrder.filter(id => session(id)?.live);
  if (!ids.length) return;
  const i = S.view.type === 'session' ? ids.indexOf(S.view.id) : -1;
  const next = i < 0 ? (step > 0 ? 0 : ids.length - 1) : (i + step + ids.length) % ids.length;
  navigate({ type: 'session', id: ids[next] });
}
window.addEventListener('keyup', e => { if (e.key === 'Control') cycleOrder = null; });
window.addEventListener('blur', () => { cycleOrder = null; });

window.addEventListener('keydown', e => {
  if (e.key === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault(); e.stopPropagation();
    if (S.data) cycleSessions(e.shiftKey ? -1 : 1);
    return;
  }
  if (!e.metaKey || e.altKey || e.ctrlKey) return;
  if (/^[1-9]$/.test(e.key)) {
    const s = liveSessions()[Number(e.key) - 1];
    if (s) { e.preventDefault(); e.stopPropagation(); navigate({ type: 'session', id: s.id }); }
  }
}, true);

api.on('ui:command', cmd => {
  if (cmd === 'quick-add') { $('#quick-add-input').focus(); $('#quick-add-input').select(); }
  if (cmd === 'new-session') startModal([]);
  if (cmd === 'home') navigate({ type: 'home' });
  if (cmd === 'settings') navigate({ type: 'settings' });
  if (cmd === 'next-needs') nextNeedingYou();
  if (cmd === 'show-update') renderBanner();
  if (cmd === 'up-to-date') flash('Stroll is up to date');
});
let pendingView = null; // navigation requested (e.g. a notification click) before init finished
api.on('ui:navigate', view => { if (S.data) navigate(view); else pendingView = view; });
api.on('ui:window-focus', f => { S.windowFocused = f; });

async function refreshRecent() {
  S.recent = await api.invoke('recent:list');
  S.recentLoaded = true;
  renderSidebar();
}

api.on('state:changed', data => {
  if (!S.data) return; // init's state:get will pick it up
  const keepConfig = S.data.config;
  S.data = { ...data, config: keepConfig };
  for (const id of [...S.selected]) if (!todo(id) || todo(id).status !== 'open') S.selected.delete(id);
  renderSidebar();
  const v = S.view;
  if (v.type === 'home') renderMain();
  else if (v.type === 'session') updateSessionHeader();
  else if (v.type === 'todo') {
    const t = todo(v.id);
    if (!t) navigate({ type: 'home' });
    else { renderTodoLinks(); const check = $('#view-header .check'); if (check && check.classList.contains('done') !== (t.status === 'done')) renderMain(); }
  } else if (v.type === 'workflow') {
    if (!workflow(v.id)) navigate({ type: 'home' });
    else renderWorkflowLive();
  } else if (v.type === 'run') {
    const r = run(v.id);
    if (!r) navigate({ type: 'home' });
    else {
      updateRunMeta();
      const headerRunning = !!$('#view-header [data-act="cancel-run"]');
      if (headerRunning !== (r.status === 'running') || $('#view-header').dataset.status !== runHeaderKey(r)) renderMain();
      else { renderRunResult(); renderRunApproval(); }
    }
  }
});

new ResizeObserver(() => fitVisible()).observe($('#terminals'));
setInterval(() => { renderSidebar(); if (sectionOpen('recent')) refreshRecent(); }, 60 * 1000);

// ---------- banner: Claude Code missing, update available ----------
function renderBanner() {
  const el = $('#banner');
  const c = S.data?.config;
  let html = '';
  if (c?.claudeMissing) {
    html = `<div class="banner error">${ICON.alert}<span><b>Claude Code isn't installed</b>, or it isn't on your PATH. Install it from <a href="https://claude.com/claude-code">claude.com/claude-code</a>, then restart Stroll.</span></div>`;
  } else if (S.update) {
    const n = S.update.behind;
    html = `<div class="banner">${ICON.download}<span><b>Update available</b> · ${n} new change${n === 1 ? '' : 's'}. Updating restarts Stroll; open sessions can be resumed after.</span>
      <button class="btn sm primary" data-act="apply-update">Update and restart</button><button class="btn sm ghost" data-act="dismiss-update">Later</button></div>`;
  }
  el.innerHTML = html;
  el.hidden = !html;
}

async function applyUpdate() {
  const ok = await confirmModal({
    title: 'Update Stroll?',
    body: 'This pulls the latest version and restarts Stroll. Open sessions end and can be resumed after the restart; running background runs stop.',
    confirm: 'Update and restart',
  });
  if (!ok) return;
  flash('Updating… this can take a minute', null, { ms: 120000 });
  const r = await api.invoke('app:applyUpdate');
  if (!r.ok) flashError(r.error);
}

// ⌘J: cycle through what needs you, most urgent first.
function nextNeedingYou() {
  const n = needsYou(S.data);
  const list = [
    ...n.waiting.map(s => ({ type: 'session', id: s.id })),
    ...n.yourTurn.map(s => ({ type: 'session', id: s.id })),
    ...n.runs.map(r => ({ type: 'run', id: r.id })),
    ...n.reminders.map(t => ({ type: 'todo', id: t.id })),
    ...n.workflows.map(w => ({ type: 'workflow', id: w.id })),
  ];
  if (!list.length) return flash('Nothing needs you right now');
  const i = list.findIndex(v => v.type === S.view.type && v.id === S.view.id);
  return navigate(list[(i + 1) % list.length]);
}

// ---------- workflows ----------
// Saved session templates for recurring work (see src/main/workflows.js for the blanks syntax).
const MODE_LABEL = { session: 'Opens a session', run: 'Runs in the background' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// "today 10:00 AM", "Mon 10:00 AM", or with the date when it's more than a few days away.
function slotText(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const days = Math.round((new Date(iso).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  const opts = Math.abs(days) < 7 ? { weekday: 'short' } : { weekday: 'short', month: 'short', day: 'numeric' };
  return `${d.toLocaleDateString(undefined, opts)} ${time}`;
}

// Due is yellow; a workflow prepared in the background follows its run.
function workflowDot(w) {
  if (!w.due) return 'none';
  if (!w.due.runId) return 'waiting';
  const r = run(w.due.runId);
  return r ? runDot(r) : 'none';
}

function workflowStatus(w) {
  const d = w.due;
  if (d?.error) return `Couldn't prepare: ${d.error}`;
  if (d?.missed) return `Missed ${slotText(d.at)}`;
  if (d?.runId) {
    const r = run(d.runId);
    if (!r) return 'Its prepared run was removed';
    if (r.pendingApproval) return 'Preparing · needs your OK';
    if (r.status === 'running') return 'Preparing in the background…';
    return r.status === 'ready' || r.status === 'reviewed' ? 'Prepared · ready to continue' : `Prep ${RUN_LABEL[r.status] || r.status}`;
  }
  if (d) return `Due since ${slotText(d.at)}`;
  if (w.nextAt) return `Next ${slotText(w.nextAt)}`;
  if (w.lastStartedAt) return `Last started ${agoText(w.lastStartedAt)}`;
  return MODE_LABEL[w.mode] || '';
}

function workflowRow(w) {
  const isActive = S.view.type === 'workflow' && S.view.id === w.id;
  return `<li class="row ${isActive ? 'active' : ''}" data-kind="workflow" data-id="${esc(w.id)}">
    ${dotHtml(workflowDot(w))}
    <div class="main"><div class="title">${esc(w.name)}</div><div class="sub">${esc(workflowStatus(w))}</div></div>
    <span class="row-actions"><button class="icon-btn" data-act="wf-start" title="Start">${ICON.play}</button></span>
  </li>`;
}

function renderWorkflow(header, panel) {
  const w = workflow(S.view.id);
  if (!w) return navigate({ type: 'home' });
  header.innerHTML = `
    <span class="h-title" id="wf-title">${esc(w.name)}</span>
    <span id="wf-pill"></span>
    <span class="h-meta" id="wf-meta"></span>
    <span class="spacer"></span>
    <button class="btn primary" data-act="wf-start-current">${ICON.play}Start</button>
    <button class="btn" data-act="wf-prepare" title="Run the prep message in the background now">${ICON.handoff}Prepare now</button>
    <button class="btn danger" data-act="wf-delete">${ICON.trash}Delete</button>`;
  const sched = w.schedule || { days: [], time: '10:00', action: 'remind' };
  panel.innerHTML = `<div class="todo-view wf-view">
    <div id="wf-due"></div>
    <div class="field links"><label>History</label><ul class="list" id="wf-history"></ul></div>
    <section class="set-group"><h3>Setup</h3>
      <div class="field"><label>Name</label><input type="text" id="wf-name" value="${esc(w.name)}"></div>
      <div class="field"><label>Working directory</label><div class="inline"><input type="text" id="wf-cwd" value="${esc(w.cwd || '')}" placeholder="${esc(S.data.config.defaultCwd)}"><button class="btn" data-act="wf-pick-cwd">Browse…</button></div></div>
      <div class="field"><label>Runs as</label><select id="wf-mode">
        <option value="session" ${w.mode !== 'run' ? 'selected' : ''}>A session: you work through it with Claude</option>
        <option value="run" ${w.mode === 'run' ? 'selected' : ''}>A background run: it reports back when done</option></select></div>
      <div class="field"><label>First message</label><textarea id="wf-template" rows="3" spellcheck="false" placeholder="/plugin:skill {{stories=every story In Development}}">${esc(w.template)}</textarea>
        <p class="help">What Stroll types for you; a skill works as in the terminal. Blanks become the start form: <code>{{name}}</code> a text field, <code>{{name=default}}</code> one with a default, <code>{{name?text}}</code> a switch that adds <code>text</code>.</p></div>
      <div class="field"><label>Prep message (optional)</label><textarea id="wf-prepare" rows="2" spellcheck="false" placeholder="The read-only half, e.g. a diff-only or report-only variant. Same blanks.">${esc(w.prepareTemplate || '')}</textarea>
        <p class="help">"Prepare now" and a scheduled prep run this in the background with your last values. When it's ready, continue it in a session to do the rest. Empty means the first message.</p></div>
      ${toggle('wf-allow-all', w.runAllowAll, 'Its background runs allow everything they ask for', ALLOW_ALL_HELP)}
    </section>
    <section class="set-group"><h3>Schedule</h3>
      <div class="field"><label>Days</label><div class="day-picks">${DAYS.map((d, i) => `<button type="button" class="chip day ${sched.days.includes(i) ? 'on' : ''}" data-day="${i}">${d}</button>`).join('')}</div></div>
      <div class="field two"><div><label>Time</label><input type="time" id="wf-time" value="${esc(sched.time)}"></div>
        <div><label>When it's due</label><select id="wf-action">
          <option value="remind" ${sched.action !== 'prepare' ? 'selected' : ''}>Remind me</option>
          <option value="prepare" ${sched.action === 'prepare' ? 'selected' : ''}>Prepare in the background, then tell me</option></select></div></div>
      <p class="help" id="wf-sched-help"></p>
    </section>
  </div>`;
  renderWorkflowLive();

  const save = patch => api.invoke('workflow:update', w.id, patch);
  const on = (sel, ev, fn) => panel.querySelector(sel).addEventListener(ev, fn);
  on('#wf-name', 'change', e => { const v = e.target.value.trim(); if (v) save({ name: v }); });
  on('#wf-cwd', 'change', e => save({ cwd: e.target.value.trim() || null }));
  on('#wf-mode', 'change', e => save({ mode: e.target.value }));
  on('#wf-template', 'change', e => save({ template: e.target.value.trim() }));
  on('#wf-prepare', 'change', e => save({ prepareTemplate: e.target.value.trim() }));
  on('#wf-allow-all', 'change', e => save({ runAllowAll: e.target.checked }));
  const saveSchedule = () => {
    const days = [...panel.querySelectorAll('.day.on')].map(b => Number(b.dataset.day));
    save({ schedule: days.length ? { days, time: $('#wf-time').value || '10:00', action: $('#wf-action').value } : null });
  };
  panel.querySelectorAll('.day').forEach(b => b.addEventListener('click', () => { b.classList.toggle('on'); saveSchedule(); }));
  on('#wf-time', 'change', saveSchedule);
  on('#wf-action', 'change', saveSchedule);
}

// The parts of the workflow view that follow state pushes; the setup form is left alone so
// typing isn't interrupted.
function renderWorkflowLive() {
  const w = workflow(S.view.id);
  if (!w || !$('#wf-due')) return;
  const setHtml = (el, markup) => { if (el && el.dataset.markup !== markup) { el.innerHTML = markup; el.dataset.markup = markup; } };
  $('#wf-title').textContent = w.name;
  $('#wf-meta').textContent = `${shortDir(w.cwd || S.data.config.defaultCwd)} · ${MODE_LABEL[w.mode] || ''}`;
  const dot = workflowDot(w);
  setHtml($('#wf-pill'), w.due ? `<span class="pill ${dot === 'none' ? 'neutral' : dot}"><i></i>${esc(workflowStatus(w))}</span>`
    : w.nextAt ? `<span class="pill neutral"><i></i>Next ${esc(slotText(w.nextAt))}</span>` : '');

  const d = w.due;
  const r = d?.runId ? run(d.runId) : null;
  const heading = d?.error ? "Couldn't prepare it" : d?.missed ? 'Missed while Stroll was closed'
    : r?.pendingApproval ? 'Preparing: it needs your OK' : r?.status === 'running' ? 'Preparing in the background'
      : d?.runId ? 'Prepared in the background' : 'Due now';
  setHtml($('#wf-due'), !d ? '' : `<div class="approval">
    <div class="ap-head">${ICON.bell}<b>${heading}</b><span class="h-meta">${d.scheduled === false ? 'started' : 'scheduled'} ${esc(slotText(d.at))}</span></div>
    ${d.error ? `<p class="help">${esc(d.error)}</p>` : ''}
    ${r ? `<ul class="list" style="padding:0">${runRow(r)}</ul>` : ''}
    <div class="actions">
      ${r && r.status !== 'running' ? `<button class="btn primary" data-act="wf-continue">${ICON.terminal}Continue in a session</button>`
    : r ? `<button class="btn ${r.pendingApproval ? 'primary' : ''}" data-act="wf-open-run">${ICON.activity}Open run</button>`
      : `<button class="btn primary" data-act="wf-start-current">${ICON.play}Start</button>`}
      ${d.missed ? `<button class="btn" data-act="wf-prepare">${ICON.handoff}Prepare now</button>` : ''}
      <button class="btn ghost" data-act="wf-dismiss">Dismiss</button>
    </div></div>`);

  const items = [
    ...S.data.sessions.filter(s => s.workflowId === w.id).map(s => ({ at: s.createdAt || s.lastActivityAt, html: sessionRow(s) })),
    ...S.data.runs.filter(x => x.workflowId === w.id).map(x => ({ at: x.startedAt, html: runRow(x) })),
  ].sort((a, b) => (b.at || '').localeCompare(a.at || '')).slice(0, 12);
  patchList($('#wf-history'), items.map(i => i.html).join('') || '<li class="empty" style="padding-left:0">Nothing yet. Its sessions and runs show up here.</li>');
  $('#wf-sched-help').textContent = w.schedule
    ? `Next: ${slotText(w.nextAt)}. It fires only while Stroll is open; a time missed while it was closed shows up as missed, it doesn't run late.`
    : 'Pick one or more days to schedule it.';
}

// The start form: the template's blanks, filled with last time's values, and what will be sent.
async function startWorkflowModal(id) {
  const w = workflow(id);
  if (!w) return;
  const { fields } = await api.invoke('workflow:render', w.template, w.values);
  const values = { ...w.values };
  modal(`
    <h2>Start “${esc(w.name)}”</h2>
    <div class="sub">${esc(MODE_LABEL[w.mode] || '')} in ${esc(shortDir(w.cwd || S.data.config.defaultCwd))}</div>
    ${fields.map(f => (f.kind === 'switch'
    ? toggle(`wf-f-${f.key}`, Boolean(values[f.key]), esc(f.label), `Adds <code>${esc(f.text)}</code>`)
    : `<div class="field"><label>${esc(f.label)}</label><input type="text" data-key="${esc(f.key)}" value="${esc(values[f.key] ?? '')}" placeholder="${esc(f.default)}" spellcheck="false"></div>`)).join('')}
    <div class="field"><label>${w.mode === 'run' ? 'Prompt' : 'First message'}</label><pre class="wf-preview" id="wf-preview"></pre></div>
    <footer><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-go>${ICON.play}Start <kbd>↩</kbd></button></footer>
  `, (m, close) => {
    const read = () => {
      for (const f of fields) {
        values[f.key] = f.kind === 'switch'
          ? m.querySelector(`#wf-f-${CSS.escape(f.key)}`).checked
          : m.querySelector(`[data-key="${CSS.escape(f.key)}"]`).value.trim();
      }
      return values;
    };
    const preview = async () => {
      const { text } = await api.invoke('workflow:render', w.template, read());
      m.querySelector('#wf-preview').textContent = text || 'Empty. Add a first message under Setup.';
    };
    m.addEventListener('input', preview);
    m.addEventListener('change', preview);
    preview();
    const go = async () => {
      let view;
      try { view = await api.invoke('workflow:start', id, read()); } catch (err) { return flashError(err); }
      close();
      return navigate(view);
    };
    m.querySelector('[data-go]').addEventListener('click', go);
    m.querySelector('[data-close]').addEventListener('click', close);
    m.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.target.type === 'text')) { e.preventDefault(); go(); }
      if (e.key === 'Escape') close();
    });
    (m.querySelector('input[type=text]') || m.querySelector('[data-go]')).focus();
  });
}

// ---------- settings ----------
const toggle = (id, on, label, help = '') => `<label class="toggle"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span class="switch"></span>
  <span class="t-text"><span>${label}</span>${help ? `<small>${help}</small>` : ''}</span></label>`;

function renderSettings(header, panel) {
  const c = S.data.config;
  header.innerHTML = `<span class="h-title">Settings</span><span class="h-meta">Stroll ${esc(c.version)}</span>`;
  panel.innerHTML = `<div class="settings-view">
    <section class="set-group"><h3>General</h3>
      <div class="field"><label>Default folder</label>
        <div class="inline"><input type="text" id="set-cwd" value="${esc(c.defaultCwd)}"><button class="btn" data-set="pick-cwd">Browse…</button></div>
        <p class="help">Where sessions and hand-offs start when a to-do has no folder of its own.</p></div>
      <div class="field"><label>Claude Code</label>
        <p class="help">${c.claudeMissing ? '<span class="warn">Not found on your PATH.</span> Install it from claude.com/claude-code, then restart Stroll.' : esc(c.claudePath)}</p></div>
    </section>
    <section class="set-group"><h3>Terminal</h3>
      <div class="field two">
        <div><label>Font size</label><input type="number" id="set-font-size" min="9" max="24" value="${Number(c.terminal.fontSize) || 13}"></div>
        <div><label>Font</label><input type="text" id="set-font-family" value="${esc(c.terminal.fontFamily)}"></div>
      </div>
      ${toggle('set-option-meta', c.terminal.optionIsMeta, 'Use Option as Meta', 'Enables Option+Enter and Option+arrows in Claude Code. Leave it off if you type characters such as @ or # with Option.')}
    </section>
    <section class="set-group"><h3>Notifications</h3>
      ${toggle('set-n-enabled', c.notifications.enabled, 'Show notifications')}
      ${toggle('set-n-sound', c.notifications.sound, 'Play a sound')}
      ${toggle('set-n-needs', c.notifications.needsYou, 'When a session needs you', 'Permission prompts, questions and plans to approve.')}
      ${toggle('set-n-turns', c.notifications.finishedTurns, 'When a session finishes a turn', 'At most one every 20 seconds per session. Right-click a session to mute it.')}
      ${toggle('set-n-runs', c.notifications.backgroundRuns, 'When a background run finishes')}
    </section>
    <section class="set-group"><h3>Background runs</h3>
      ${toggle('set-connectors', c.background.includeConnectors, 'Let runs read Slack, Gmail and Google Drive', 'Read-only. Off by default: emails and messages are where an agent is most likely to meet planted instructions.')}
      <div class="field"><label>Model</label><input type="text" id="set-model" value="${esc(c.background.model || '')}" placeholder="Default (same as Claude Code)"></div>
      <div class="field"><label>Also allow without asking</label>
        <textarea id="set-extra-rules" rows="4" spellcheck="false" placeholder="One rule per line, e.g. Bash(python3 ~/scripts/read_tickets.py:*)">${esc((c.background.extraAllowedTools || []).join('\n'))}</textarea>
        <p class="help">Claude Code permission rules. Anything a run wants that isn't allowed asks you first; edits, pushes, PRs and sending messages are never allowed.</p></div>
    </section>
    <section class="set-group"><h3>Updates</h3>
      ${toggle('set-updates', c.updates.check, 'Check for updates automatically', 'Stroll checks its git repository every few hours.')}
      <div class="actions"><button class="btn" data-set="check-updates">${ICON.download}Check now</button></div>
    </section>
  </div>`;

  const save = patch => api.invoke('config:set', patch).then(() => flash('Saved', null, { ms: 1500 })).catch(flashError);
  const bind = (sel, ev, fn) => panel.querySelector(sel).addEventListener(ev, fn);
  bind('#set-cwd', 'change', e => save({ defaultCwd: e.target.value.trim() }));
  bind('[data-set="pick-cwd"]', 'click', async () => {
    const d = await api.invoke('dialog:pickDir', $('#set-cwd').value);
    if (d) { $('#set-cwd').value = d; save({ defaultCwd: d }); }
  });
  bind('#set-font-size', 'change', e => save({ terminal: { fontSize: Math.min(24, Math.max(9, Number(e.target.value) || 13)) } }));
  bind('#set-font-family', 'change', e => save({ terminal: { fontFamily: e.target.value.trim() || 'Menlo, monospace' } }));
  bind('#set-option-meta', 'change', e => save({ terminal: { optionIsMeta: e.target.checked } }));
  bind('#set-n-enabled', 'change', e => save({ notifications: { enabled: e.target.checked } }));
  bind('#set-n-sound', 'change', e => save({ notifications: { sound: e.target.checked } }));
  bind('#set-n-needs', 'change', e => save({ notifications: { needsYou: e.target.checked } }));
  bind('#set-n-turns', 'change', e => save({ notifications: { finishedTurns: e.target.checked } }));
  bind('#set-n-runs', 'change', e => save({ notifications: { backgroundRuns: e.target.checked } }));
  bind('#set-connectors', 'change', e => save({ background: { includeConnectors: e.target.checked } }));
  bind('#set-model', 'change', e => save({ background: { model: e.target.value.trim() || null } }));
  bind('#set-extra-rules', 'change', e => save({ background: { extraAllowedTools: e.target.value.split('\n').map(l => l.trim()).filter(Boolean) } }));
  bind('#set-updates', 'change', e => save({ updates: { check: e.target.checked } }));
  bind('[data-set="check-updates"]', 'click', async () => {
    S.update = await api.invoke('app:checkUpdates');
    renderBanner();
    if (!S.update) flash('Stroll is up to date');
  });
}

// ---------- drag and drop ----------
// Dropping files on an open session types their paths, shell-quoted, like iTerm or Terminal
// (Claude Code attaches image paths). Drops never navigate the window.
const shellQuote = p => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`);
document.addEventListener('dragover', e => {
  if (e.dataTransfer?.types?.includes(SECTION_MIME)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = S.view.type === 'session' && session(S.view.id)?.live ? 'copy' : 'none';
});
document.addEventListener('drop', e => {
  if (e.dataTransfer?.types?.includes(SECTION_MIME)) return;
  e.preventDefault();
  const s = S.view.type === 'session' ? session(S.view.id) : null;
  if (!s?.live) { flash('Drop files on an open session to paste their paths'); return; }
  const files = [...(e.dataTransfer?.files || [])].map(f => { try { return api.pathForFile(f); } catch (_) { return ''; } }).filter(Boolean);
  const text = files.length
    ? files.map(shellQuote).join(' ')
    : (e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).join(' ');
  if (!text) return;
  api.send('session:write', s.id, `${text} `);
  terms.get(s.id)?.term.focus();
});

// Links in the UI open in the browser, never in the window.
document.addEventListener('click', e => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  api.invoke('open:external', a.href);
}, true);

api.on('ui:error', msg => flash(msg, null, { error: true, ms: 10000 }));
api.on('ui:update', info => { S.update = info; if (S.data) renderBanner(); });
api.on('config:changed', cfg => {
  if (!S.data) return;
  S.data.config = cfg;
  applySidebarLayout();
  for (const e of terms.values()) {
    e.term.options.fontSize = Number(cfg.terminal.fontSize) || 13;
    e.term.options.fontFamily = cfg.terminal.fontFamily;
    e.term.options.macOptionIsMeta = cfg.terminal.optionIsMeta === true;
  }
  fitVisible();
  renderBanner();
  const rules = $('#set-extra-rules');
  if (rules && document.activeElement !== rules) rules.value = (cfg.background.extraAllowedTools || []).join('\n');
});

$('#settings-btn').addEventListener('click', () => navigate({ type: 'settings' }));

(async () => {
  S.data = await api.invoke('state:get');
  S.update = S.data.update || null;
  applySidebarLayout();
  renderSidebar();
  if (sectionOpen('recent')) refreshRecent();
  renderBanner();
  navigate(pendingView || { type: 'home' });
})();
