const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu, nativeImage, powerSaveBlocker, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL, fileURLToPath } = require('url');
const { execFile } = require('child_process');

const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const INDEX_PATH = path.join(__dirname, '..', 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(INDEX_PATH).href;
const IS_MAC = process.platform === 'darwin';
// App shortcuts: ⌘ on macOS. Elsewhere plain Ctrl keys belong to Claude Code in the terminal
// (Ctrl+K, Ctrl+J, Ctrl+N…), so they take Ctrl+Shift, as terminal apps do for Ctrl+Shift+C/V.
// There the page handles them (app.js), and the menu only shows them.
const appKey = k => (IS_MAC ? { accelerator: `Cmd+${k}` } : { accelerator: `Ctrl+Shift+${k}`, registerAccelerator: false });
const { paths, loadConfig, saveOverrides, mergeDeep, findOnPath } = require('./config');
const { Store, words, quotedLines } = require('./store');
const { condenseNotes, killAll: killCondenses } = require('./condense');
const { cleanWriteDirs } = require('./writable');
const { Remote, notifyMode, phonesWanted } = require('./remote');
const { Sessions } = require('./sessions');
const { Runs } = require('./runs');
const { Approvals } = require('./approvals');
const { Server, writeHookSettings, writeMcpConfig } = require('./server');
const { recentSessions, firstPrompt } = require('./recent');
const { parseFields, renderTemplate, dueSlot, nextSlot, validSchedule } = require('./workflows');
const { parseChangelog, cmpVersion, unseenSections } = require('./changelog');
const files = require('./files');

const CHANGELOG_PATH = path.join(__dirname, '..', '..', 'CHANGELOG.md');

app.setName('Stroll');
// A separate data folder (tests, experiments) gets its own Electron profile, so it can run
// next to the real Stroll instead of tripping the single-instance lock.
if (process.env.STROLL_HOME) app.setPath('userData', path.join(process.env.STROLL_HOME, 'electron-profile'));

let win = null;
let config; let store; let sessions; let runs; let server; let approvals; let remote;
let focusView = null; // what the user is looking at: { type, id }
let pendingNav = null; // a view to open once a (re)created window has loaded
let updateInfo = null;
let quitting = false;
const shownNotifications = new Set(); // macOS drops click events of notifications that get garbage-collected
const lastNotified = new Map();


function handoffPrompt(todos, instructions, cwd, trail = null) {
  // Notes' references are looked up where their editor checked them, then in the run's folder.
  const refs = files.refsNote([
    ...todos.map(t => ({ text: t.notes, dirs: [t.cwd || store.trail(t.trailId)?.cwd || config.defaultCwd, cwd] })),
    { text: trail?.notes, dirs: [trail?.cwd || config.defaultCwd, cwd] },
    { text: instructions, dirs: [cwd] },
  ]);
  return [
    todos.length === 1 ? `Work on this to-do from the user's list: ${todos[0].title}`
      : todos.length ? "Work on these to-dos from the user's list:" : `Work on this, for the user's trail "${trail?.title}".`,
    ...(todos.length > 1 ? todos.map(t => `- ${t.title}`) : []),
    ...todos.filter(t => t.notes).map(t => `Notes on "${t.title}": ${t.notes}`),
    trail ? `\nThis is part of the trail "${trail.title}". Its notes, the context the user keeps for this work:\n${trail.notes.trim() || '(empty)'}` : '',
    instructions ? `\nInstructions: ${instructions}` : '',
    `\nWorking folder: ${cwd}`,
    refs ? `\n${refs}` : '',
    '\nInvestigate, gather the context needed and prepare drafts so the user can finish this quickly.',
  ].filter(Boolean).join('\n');
}

// To the window, and to the paired phones that are connected (remote.js picks what they get).
function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  remote?.broadcast(channel, args);
}

// With phone access on, work in progress keeps the computer from going to sleep on its own:
// whoever walked away is counting on it to carry on. Closing the lid still stops everything.
let awake = null;
function updateAwake() {
  const want = Boolean(config.remote?.enabled) && sessions.busyCount() + runs.busyCount() > 0;
  if (want && awake === null) awake = powerSaveBlocker.start('prevent-app-suspension');
  else if (!want && awake !== null) { powerSaveBlocker.stop(awake); awake = null; }
}

// A notification here, and on the paired phones when the setting says so (remote.js). A kind
// turned off under Notifications goes to neither. `phones: false` for what only matters at
// the computer; `desktop: false` for what the user is looking at here, which a phone set to
// "always" still hears about.
function notify(title, body, view, { kind = null, key = null, phones = true, desktop = true } = {}) {
  if (key) {
    // A session finishing turn after turn (e.g. under /loop) pings at most every 20s.
    const last = lastNotified.get(key) || 0;
    if (Date.now() - last < 20000) return;
    lastNotified.set(key, Date.now());
  }
  const n = config.notifications || {};
  const wanted = !(kind && n[kind] === false);
  if (phones && wanted && phonesWanted(config.remote?.notify, atComputer())) remote?.notifyPhones({ title, body, view });
  if (!desktop || !wanted || !Notification.isSupported() || !n.enabled) return;
  const note = new Notification({ title, body: body || '', silent: n.sound === false });
  shownNotifications.add(note);
  const forget = () => shownNotifications.delete(note);
  note.on('click', () => { forget(); showWindow(view); });
  note.on('close', forget);
  note.show();
}

// Is someone at the computer with Stroll in front? A window stays "focused" long after its
// user walked away, so this also takes recent input: none for a while, or a locked screen,
// means nobody is looking. What happens then isn't counted as seen, and their phone is told.
const PRESENT_SECONDS = 90;
function atComputer() {
  if (!win || win.isDestroyed() || !win.isFocused()) return false;
  try { return powerMonitor.getSystemIdleState(PRESENT_SECONDS) === 'active'; } catch (_) { return true; }
}

function isLookingAt(type, id) {
  return atComputer() && focusView && focusView.type === type && focusView.id === id;
}

// The user has now seen what this session/run finished with: drop its "your turn" marker.
function markSeen(view) {
  if (!view || !store) return;
  if (view.type === 'session' && store.session(view.id)?.unseen) store.patchSession(view.id, { unseen: false });
  if (view.type === 'run' && store.run(view.id)?.unseen) store.patchRun(view.id, { unseen: false });
  if (view.type === 'todo') store.ackReminder(view.id);
}

function updateBadge() {
  const s = store.state;
  const waiting = s.sessions.filter(x => x.live && (x.status === 'waiting' || (x.status === 'idle' && x.unseen))).length;
  const ready = s.runs.filter(r => (r.unseen && r.status !== 'running') || r.pendingApproval).length;
  // A prepared workflow counts through its run.
  const due = s.workflows.filter(w => w.due && !w.due.runId).length;
  const missedStarts = s.todos.filter(t => t.status === 'open' && (t.startMissed || t.startError)).length;
  const total = waiting + ready + due + missedStarts;
  app.dock?.setBadge(total ? String(total) : '');
}

// `allowAll` comes only from the hand-off dialog: a hand-off asked for from inside a Claude
// session (the MCP tool) can't turn off the run's permission prompts.
// A hand-off from a trail (no to-do) takes its task from the instructions; one from a to-do on
// a trail gets the trail's notes too.
function startHandoff(todoIds, { instructions = '', prompt = null, cwd = null, title = null, allowAll = false, trailId } = {}) {
  const todos = todoIds.map(id => store.todo(id)).filter(Boolean);
  const trail = store.trail(trailId !== undefined ? trailId : todos.map(t => t.trailId).find(Boolean)) || null;
  if (!todos.length && !prompt && !String(instructions).trim()) throw new Error('Say what the background run should do.');
  const dir = cwd || todos.find(t => t.cwd)?.cwd || trail?.cwd || store.state.recentDirs[0] || config.defaultCwd;
  const firstLine = String(instructions).trim().split('\n')[0].slice(0, 60);
  const runId = runs.start({
    prompt: prompt || handoffPrompt(todos, instructions, dir, trail),
    cwd: dir,
    title: title || (todos.length === 1 ? todos[0].title : todos.length ? `${todos.length} to-dos` : trail ? `${trail.title} · ${firstLine}` : null),
    todoIds,
    allowAll,
    trailId: trail?.id || null,
  });
  clearTodoStarts(todoIds);
  return runId;
}

// ---------- to-dos that start on their own ----------
// Nobody is watching a session that a schedule opens, so three rules hold here:
// - it starts in the folder the user chose, never a guessed one (todoStartDir);
// - it starts once: started by hand first, the schedule is used up (clearTodoStarts);
// - only Stroll's own window sets a schedule. The tools Claude sessions have and the phone
//   can't, and a session can't move a scheduled to-do to another folder either (boot()).
const START_MODES = ['session', 'run'];
// Sessions a schedule opened, by session id, to report one that dies right away as not started.
const scheduledStarts = new Map();

// Where a to-do starts on its own: its folder, else its trail's, and it has to be there. Not
// the last folder used, not home.
function todoStartDir(t) {
  const dir = t.cwd || store.trail(t.trailId)?.cwd || null;
  if (!dir) throw new Error('Give this to-do a working directory first. A start on its own never guesses the folder.');
  let there = false;
  try { there = fs.statSync(dir).isDirectory(); } catch (_) { /* gone */ }
  if (!there) throw new Error(`Its working directory is not there any more: ${dir}`);
  return dir;
}

// A to-do started by hand (Start, Hand off, from the phone or a session) before its time
// doesn't start again at that time.
function clearTodoStarts(todoIds) {
  for (const id of todoIds || []) if (store.todo(id)?.startAt) store.setTodoStart(id, { startAt: null });
}

// From the to-do view. The first message and the mode are saved whatever happens to the time;
// a time is accepted only for an open to-do that has its folder, and only if still to come.
function setTodoStart(id, patch) {
  const t = store.todo(id);
  if (!t) throw new Error('That to-do no longer exists.');
  const { startAt, ...rest } = cleanTodoStart(patch);
  if (Object.keys(rest).length) store.setTodoStart(id, rest);
  if (startAt === undefined) return store.todo(id);
  if (startAt) {
    if (t.status !== 'open') throw new Error('That to-do is done.');
    todoStartDir(t);
    if (Date.parse(startAt) <= Date.now()) throw new Error('Pick a time that is still to come.');
  }
  return store.setTodoStart(id, { startAt });
}

// Only fields that make sense, from the to-do view.
function cleanTodoStart(patch = {}) {
  const out = {};
  if ('firstMessage' in patch) out.firstMessage = String(patch.firstMessage || '');
  if ('startAt' in patch) {
    const ms = Date.parse(patch.startAt);
    out.startAt = patch.startAt && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  if ('startMode' in patch) out.startMode = START_MODES.includes(patch.startMode) ? patch.startMode : 'session';
  if ('startAllowAll' in patch) out.startAllowAll = Boolean(patch.startAllowAll);
  if (patch.dismissMissed) { out.startMissed = null; out.startError = null; }
  return out;
}

// Starts a to-do with its first message: a session, or a hand-off when it's set to run in
// the background. Both take the to-do's trail, as Start and Hand off do. Its schedule and any
// missed start are cleared once it has started, so a start that fails keeps them.
function startTodo(id) {
  const t = store.todo(id);
  if (!t) throw new Error('That to-do no longer exists.');
  if (t.status !== 'open') throw new Error('That to-do is done.');
  const message = (t.firstMessage || '').trim();
  const cwd = todoStartDir(t);
  const started = t.startMode === 'run'
    ? { type: 'run', id: startHandoff([id], { instructions: message, cwd, allowAll: t.startAllowAll }) }
    : { type: 'session', id: sessions.create({ cwd, title: t.title, todoIds: [id], firstMessage: message || null }) };
  store.setTodoStart(id, { startAt: null, startMissed: null, startError: null });
  return started;
}

// Same rule as workflows: a start missed while Stroll was closed is reported, never run late.
function checkTodoStarts() {
  const nowMs = Date.now();
  for (const t of store.state.todos) {
    if (t.status !== 'open' || !t.startAt) continue;
    const atMs = Date.parse(t.startAt);
    if (!(atMs <= nowMs)) continue;
    const at = t.startAt;
    const view = { type: 'todo', id: t.id };
    if (nowMs - atMs > WORKFLOW_GRACE_MS) {
      store.setTodoStart(t.id, { startAt: null, startMissed: at });
      notify(`Missed: ${t.title}`, `It was set to start ${slotLabel(at)}, while Stroll was closed or the computer asleep.`, view);
      continue;
    }
    try {
      const started = startTodo(t.id);
      if (started.type === 'session') scheduledStarts.set(started.id, { todoId: t.id, at });
      notify(`Started: ${t.title}`, started.type === 'run' ? 'Handed off to a background run.' : 'Its session is open.', started);
    } catch (e) {
      store.setTodoStart(t.id, { startAt: null, startMissed: at, startError: e.message });
      notify(`${t.title} couldn't start`, e.message, view);
    }
  }
}

// What a session sees of its trail through the MCP tools: the notes now, and the trail's work.
function trailForApi(trailId, sessionId) {
  const t = store.trail(trailId || store.session(sessionId)?.trailId);
  if (!t) return null;
  const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s);
  return {
    id: t.id, title: t.title, notes: t.notes, cwd: t.cwd, status: t.status,
    pendingSuggestions: t.suggestions.map(x => ({ text: x.text, replaces: x.replaces })),
    todos: store.state.todos.filter(x => x.trailId === t.id).map(x => ({ id: x.id, title: x.title, status: x.status, notes: x.notes || undefined })),
    workflows: store.state.workflows.filter(x => x.trailId === t.id)
      .map(x => ({ id: x.id, name: x.name, runsAs: x.mode === 'run' ? 'background run' : 'session', nextAt: x.nextAt || undefined, lastStartedAt: x.lastStartedAt || undefined })),
    sessions: store.state.sessions.filter(x => x.trailId === t.id)
      .map(x => ({ id: x.id, title: x.title, live: x.live, status: x.status, preview: x.preview, lastActivityAt: x.lastActivityAt, current: x.id === sessionId || undefined })),
    runs: store.state.runs.filter(x => x.trailId === t.id)
      .map(x => ({ id: x.id, title: x.title, status: x.status, finishedAt: x.finishedAt, result: clip(x.result, 4000) })),
  };
}

const NO_TRAIL = "This session isn't on a trail. Ask the user which trail they mean (trail_list shows them) and pass its id.";
const NOT_IN_NOTES = "`replaces` isn't in the notes as they are now (trail_get returns them). Quote a line from them, or leave `replaces` out to add a line.";

// Claude drafts a shorter version of a trail's notes. The draft waits on the trail: the notes
// change only when the user takes it.
function startCondense(id, { auto = false } = {}) {
  const t = store.trail(id);
  if (!t || t.condense?.status === 'running') return t || null;
  if (!config.claudePath) throw new Error('Claude Code (`claude`) was not found on your PATH.');
  if (!t.notes.trim()) throw new Error('There are no notes to condense yet.');
  const { startedAt, base } = store.startCondense(id, auto);
  condenseNotes({ config, cwd: paths.dataDir, title: t.title, notes: base })
    .then(text => store.finishCondense(id, startedAt, { text }), err => store.finishCondense(id, startedAt, { error: err.message }));
  return t;
}

// Notes that sessions keep adding to only grow. Past the limit Stroll asks for a shorter draft
// on its own, and not again until the user has answered it and the notes have grown some more.
function autoCondense(id) {
  const t = store.trail(id);
  const cfg = config.trails || {};
  if (!t || !cfg.autoCondense || t.status !== 'active' || t.condense || !config.claudePath) return;
  if (words(t.notes) <= Math.max(Number(cfg.condenseAtWords) || 800, t.condenseSkipWords || 0)) return;
  startCondense(id, { auto: true });
}

// ---------- workflows ----------
const WORKFLOW_GRACE_MS = 15 * 60 * 1000; // a scheduled time missed by more than this was missed
const WORKFLOW_KEYS = ['name', 'cwd', 'mode', 'template', 'prepareTemplate', 'values', 'runAllowAll', 'schedule', 'trailId', 'writeDirs'];
const shortDate = () => new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const slotLabel = iso => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

// Only known fields, and a schedule that makes sense, from the renderer or an import file.
function cleanWorkflow(fields = {}) {
  const w = {};
  for (const k of WORKFLOW_KEYS) if (k in fields) w[k] = fields[k];
  if ('mode' in w) w.mode = w.mode === 'run' ? 'run' : 'session';
  if ('runAllowAll' in w) w.runAllowAll = Boolean(w.runAllowAll);
  if ('trailId' in w) w.trailId = store.trail(w.trailId) ? w.trailId : null;
  if ('writeDirs' in w) w.writeDirs = cleanWriteDirs(w.writeDirs);
  if ('schedule' in w) {
    w.schedule = validSchedule(w.schedule)
      ? { days: [...new Set(w.schedule.days.map(Number))].sort(), time: w.schedule.time, action: w.schedule.action === 'prepare' ? 'prepare' : 'remind' }
      : null;
    // A time that already passed today shouldn't fire the moment it's set.
    w.scheduleSetAt = new Date().toISOString();
    w.nextAt = w.schedule ? new Date(nextSlot(w.schedule, Date.now())).toISOString() : null;
  }
  return w;
}

// What a background run on a trail is told. A session gets more (sessions.js): it can also
// suggest notes, which a read-only run can't.
const trailRunContext = trail => (trail
  ? `This run is part of the user's trail "${trail.title}", a piece of work that takes many sessions. Its notes, the context the user keeps for that work:\n${trail.notes.trim() || '(empty)'}`
  : null);

// A workflow's background run: its trail's notes, and the files its message and those notes
// reference with @ (a session expands @ in its first message itself; a run doesn't).
function workflowRunContext(text, trail, cwd) {
  const dir = cwd || config.defaultCwd;
  const refs = files.refsNote([
    { text, dirs: [dir] },
    { text: trail?.notes, dirs: [trail?.cwd || config.defaultCwd, dir] },
  ]);
  return [trailRunContext(trail), refs].filter(Boolean).join('\n\n') || null;
}

// Starts a workflow with the values from its start form, which are kept for next time. What it
// starts goes on the workflow's trail, or on the one picked for this start (null: none).
function startWorkflow(id, values = {}, { trailId } = {}) {
  const wf = store.workflow(id);
  if (!wf) throw new Error('That workflow no longer exists.');
  const vals = { ...wf.values, ...values };
  const text = renderTemplate(wf.template, vals);
  if (!text) throw new Error('This workflow has no first message yet. Add one under Setup.');
  store.updateWorkflow(id, { values: vals, due: null, lastStartedAt: new Date().toISOString() });
  const title = `${wf.name} · ${shortDate()}`;
  const trail = store.trail(trailId !== undefined ? trailId : wf.trailId) || null;
  const cwd = wf.cwd || trail?.cwd || null;
  if (wf.mode === 'run') {
    return { type: 'run', id: runs.start({ prompt: text, cwd, title, workflowId: id, allowAll: wf.runAllowAll, trailId: trail?.id || null, context: workflowRunContext(text, trail, cwd), writeDirs: wf.writeDirs || [] }) };
  }
  return { type: 'session', id: sessions.create({ cwd, title, firstMessage: text, workflowId: id, trailId: trail?.id || null }) };
}

// The read-only half as a background run, to continue in a session once it's ready.
function prepareWorkflow(id, at = new Date().toISOString(), scheduled = false) {
  const wf = store.workflow(id);
  if (!wf) throw new Error('That workflow no longer exists.');
  const text = renderTemplate(wf.prepareTemplate || wf.template, wf.values);
  if (!text) throw new Error('This workflow has no first message yet. Add one under Setup.');
  const trail = store.trail(wf.trailId) || null;
  const cwd = wf.cwd || trail?.cwd || null;
  const runId = runs.start({
    prompt: text, cwd, title: `${wf.name} · prepared ${shortDate()}`, workflowId: id, allowAll: wf.runAllowAll,
    trailId: trail?.id || null, context: workflowRunContext(text, trail, cwd), writeDirs: wf.writeDirs || [],
  });
  store.updateWorkflow(id, { due: { at, missed: false, runId, scheduled } });
  return { type: 'run', id: runId };
}

function checkWorkflows() {
  const nowMs = Date.now();
  for (const wf of store.state.workflows) {
    const next = wf.schedule ? new Date(nextSlot(wf.schedule, nowMs)).toISOString() : null;
    if ((wf.nextAt || null) !== next) store.updateWorkflow(wf.id, { nextAt: next });
    const due = dueSlot(wf, nowMs, WORKFLOW_GRACE_MS);
    if (!due) continue;
    const at = new Date(due.at).toISOString();
    const view = { type: 'workflow', id: wf.id };
    store.updateWorkflow(wf.id, { lastSlotAt: at });
    if (due.missed) {
      store.updateWorkflow(wf.id, { due: { at, missed: true } });
      notify(`Missed: ${wf.name}`, `It was due ${slotLabel(at)}, while Stroll was closed.`, view);
    } else if (wf.schedule.action === 'prepare') {
      try {
        prepareWorkflow(wf.id, at, true);
      } catch (e) {
        store.updateWorkflow(wf.id, { due: { at, missed: false, error: e.message } });
        notify(`${wf.name} couldn't start`, e.message, view);
      }
    } else {
      store.updateWorkflow(wf.id, { due: { at, missed: false } });
      notify(`${wf.name} is due`, 'Open it to start.', view);
    }
  }
}

// One-time import: a list of workflows in ~/.stroll/workflows-import.json, renamed once read.
function importWorkflows() {
  const file = path.join(paths.dataDir, 'workflows-import.json');
  if (!fs.existsSync(file)) return;
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const w of Array.isArray(list) ? list : []) {
      if (!w?.name || store.state.workflows.some(x => x.name === w.name)) continue;
      store.addWorkflow(cleanWorkflow(w));
    }
    fs.renameSync(file, `${file}.imported`);
  } catch (e) {
    console.error('[stroll] workflows-import.json:', e.message);
  }
}

function checkReminders() {
  const nowMs = Date.now();
  for (const t of store.state.todos) {
    if (t.status !== 'open' || !t.remindAt || t.remindedAt) continue;
    if (new Date(t.remindAt).getTime() <= nowMs) {
      t.remindedAt = new Date().toISOString();
      store.changed();
      notify('Reminder', t.title, { type: 'todo', id: t.id });
    }
  }
}

// What the renderer needs from the config (never the full object: it has PATH etc.).
function publicConfig() {
  return {
    defaultCwd: config.defaultCwd,
    terminal: config.terminal,
    notifications: config.notifications,
    background: {
      model: config.background.model,
      includeConnectors: config.background.includeConnectors,
      extraAllowedTools: config.background.extraAllowedTools || [],
    },
    updates: config.updates,
    trails: config.trails,
    remote: { enabled: Boolean(config.remote?.enabled), relayUrl: config.remote?.relayUrl || '', notify: notifyMode(config.remote?.notify) },
    sidebar: config.sidebar,
    claudePath: config.claudePath,
    claudeMissing: !config.claudePath,
    version: app.getVersion(),
    appDir: paths.appDir,
  };
}

// "What's new": the changelog sections this user hasn't seen (all of them for Settings).
// Showing them counts as seen, so they appear once.
function whatsNew(all = false) {
  let sections;
  try { sections = parseChangelog(fs.readFileSync(CHANGELOG_PATH, 'utf8')); } catch (_) { return null; }
  const current = app.getVersion();
  const list = all ? sections.filter(s => cmpVersion(s.version, current) <= 0) : unseenSections(sections, store.state.lastSeenVersion, current);
  if (!all && store.state.lastSeenVersion !== current) {
    store.state.lastSeenVersion = current;
    store.changed();
  }
  return list.length ? { version: current, sections: list.slice(0, 10) } : null;
}

// ---------- updates (installs are git checkouts) ----------
function git(args, opts = {}) {
  return new Promise(resolve => {
    execFile('git', ['-C', paths.appDir, ...args], { timeout: 60000, env: { ...process.env, PATH: config.envPath }, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() });
    });
  });
}

async function checkUpdates() {
  if (!config.updates?.check || !fs.existsSync(path.join(paths.appDir, '.git'))) return;
  if (!(await git(['fetch', '--quiet'])).ok) return;
  const behind = Number((await git(['rev-list', '--count', 'HEAD..@{u}'])).out) || 0;
  updateInfo = behind > 0 ? { behind } : null;
  send('ui:update', updateInfo);
}

async function applyUpdate() {
  const pull = await git(['pull', '--ff-only']);
  if (!pull.ok) return { ok: false, error: pull.err || 'git pull failed' };
  const install = await new Promise(resolve => {
    execFile('npm', ['install', '--no-audit', '--no-fund'], { cwd: paths.appDir, timeout: 600000, env: { ...process.env, PATH: config.envPath } },
      (err, _o, stderr) => resolve({ ok: !err, err: String(stderr || err?.message || '') }));
  });
  if (!install.ok) return { ok: false, error: `npm install failed: ${install.err.slice(-400)}` };
  app.relaunch();
  app.quit();
  return { ok: true };
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 900, minHeight: 560,
    title: 'Stroll',
    icon: ICON_PATH,
    backgroundColor: '#0e1116',
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }
      : { autoHideMenuBar: true }), // Alt shows the menu bar
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  win.loadFile(INDEX_PATH);
  const wc = win.webContents;
  // The window only ever shows index.html. Without this, dropping a file or link on it would
  // navigate there, and that page would get the preload bridge into live sessions.
  wc.on('will-navigate', (e, url) => { if (url !== INDEX_URL) e.preventDefault(); });
  wc.on('will-redirect', (e, url) => { if (url !== INDEX_URL) e.preventDefault(); });
  wc.on('will-attach-webview', e => e.preventDefault());
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') console.log(`[renderer ${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  wc.on('did-finish-load', () => {
    if (pendingNav) { send('ui:navigate', pendingNav); pendingNav = null; }
    if (updateInfo) send('ui:update', updateInfo);
  });
  if (process.env.STROLL_DEBUG_OPEN) {
    // Debug aid: "session:<cwd>" starts a session there, "todo-session:<n>" one for the n-th
    // to-do, "run:<id>" / "todo:<id>" opens that view.
    wc.once('did-finish-load', () => setTimeout(() => {
      const [type, arg] = process.env.STROLL_DEBUG_OPEN.split(/:(.*)/s);
      if (type === 'session') send('ui:navigate', { type: 'session', id: sessions.create({ cwd: arg, title: 'debug session' }) });
      else if (type === 'todo-session') {
        const t = store.state.todos[Number(arg) || 0];
        sessions.create({ cwd: config.defaultCwd, title: t.title, todoIds: [t.id] });
      } else send('ui:navigate', { type, id: arg });
    }, 500));
  }
  if (process.env.STROLL_DEBUG_JS) {
    // Debug aid: run a snippet in the renderer once it's up (e.g. open a dialog for a snapshot).
    wc.once('did-finish-load', () => setTimeout(() => {
      wc.executeJavaScript(process.env.STROLL_DEBUG_JS).catch(e => console.log('[debug js]', e.message));
    }, Number(process.env.STROLL_DEBUG_JS_DELAY || 4000)));
  }
  if (process.env.STROLL_SNAPSHOT) {
    // Debug aid: save a PNG of the window shortly after load (used to check the UI headlessly).
    wc.once('did-finish-load', () => setTimeout(async () => {
      const img = await wc.capturePage();
      fs.writeFileSync(process.env.STROLL_SNAPSHOT, img.toPNG());
      if (process.env.STROLL_SNAPSHOT_QUIT) { quitting = true; app.quit(); }
    }, Number(process.env.STROLL_SNAPSHOT_DELAY || 2500)));
  }
  win.on('focus', () => { send('ui:window-focus', true); markSeen(focusView); });
  win.on('blur', () => send('ui:window-focus', false));
  win.on('closed', () => { win = null; });
}

function showWindow(view) {
  if (!win) { pendingNav = view || null; createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (view) send('ui:navigate', view);
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Settings…', ...appKey(','), click: () => send('ui:command', 'settings') },
        { label: 'Check for Updates…', click: () => checkUpdates().then(() => send('ui:command', updateInfo ? 'show-update' : 'up-to-date')) },
        { type: 'separator' },
        ...(IS_MAC ? [
          { role: 'services' }, { type: 'separator' },
          { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        ] : []),
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Session', ...appKey('N'), click: () => send('ui:command', 'new-session') },
        { label: 'Add To-do', ...appKey('K'), click: () => send('ui:command', 'quick-add') },
        { label: 'Search', ...appKey('F'), click: () => send('ui:command', 'search') },
        { label: 'Overview', ...appKey('0'), click: () => send('ui:command', 'home') },
        { label: 'Next Needing You', ...appKey('J'), click: () => send('ui:command', 'next-needs') },
        { type: 'separator' },
        // Ctrl+W deletes a word in Claude Code's prompt.
        IS_MAC ? { role: 'close' } : { role: 'close', accelerator: 'Ctrl+Shift+W' },
      ],
    },
    // Off macOS, Ctrl+C/V/X/Z/A belong to Claude Code in the terminal (interrupt, image paste…):
    // the Edit menu only shows them. Text fields handle them on their own, the terminal uses
    // Ctrl+Shift+C/V.
    IS_MAC ? { role: 'editMenu' } : {
      label: 'Edit',
      submenu: ['undo', 'redo', null, 'cut', 'copy', 'paste', null, 'selectAll']
        .map(role => (role ? { role, registerAccelerator: false } : { type: 'separator' })),
    },
    {
      label: 'View',
      submenu: [
        // Ctrl+R is Claude Code's history search.
        IS_MAC ? { role: 'reload' } : { role: 'reload', accelerator: 'Ctrl+Shift+R' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Every IPC call must come from Stroll's own page. The handlers are also kept by channel, for
// paired phones: remote.js calls the ones a phone is allowed.
const fromApp = e => e.senderFrame && e.senderFrame.url.split('#')[0] === INDEX_URL;
const invokeHandlers = new Map();
const sendHandlers = new Map();
function handle(channel, fn) {
  invokeHandlers.set(channel, fn);
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromApp(e)) throw new Error('blocked');
    return fn(...args);
  });
}
function on(channel, fn) {
  sendHandlers.set(channel, fn);
  ipcMain.on(channel, (e, ...args) => { if (fromApp(e)) fn(...args); });
}

function registerIpc() {
  handle('state:get', () => ({ ...store.snapshot(), config: publicConfig(), update: updateInfo }));

  handle('todo:add', data => store.addTodo(data));
  handle('todo:update', (id, patch) => store.updateTodo(id, patch));
  handle('todo:delete', id => store.deleteTodo(id));
  handle('todo:handoff', (todoIds, opts) => startHandoff(todoIds, opts));
  handle('todo:setStart', (id, patch) => setTodoStart(id, patch));
  handle('todo:startNow', id => startTodo(id));

  handle('fs:complete', (cwd, query) => files.complete(cwd, query));
  handle('fs:peek', (cwd, p) => files.peek(cwd, p));
  handle('fs:refs', (cwd, refs) => files.refKinds(cwd, refs));
  handle('fs:display', (cwd, list) => (list || []).map(p => files.displayPath(cwd, p)));

  // A trail made from a session, a to-do or a workflow takes it in.
  handle('trail:add', ({ title, notes, cwd, sessionId, todoId, workflowId } = {}) => {
    const t = store.addTrail({ title, notes, cwd });
    if (sessionId) store.setSessionTrail(sessionId, t.id);
    if (todoId) store.updateTodo(todoId, { trailId: t.id });
    if (workflowId) store.updateWorkflow(workflowId, { trailId: t.id });
    return t;
  });
  handle('trail:update', (id, patch = {}) => {
    const clean = {};
    if (typeof patch.title === 'string' && patch.title.trim()) clean.title = patch.title.trim();
    if (typeof patch.notes === 'string') clean.notes = patch.notes;
    if ('cwd' in patch) clean.cwd = (typeof patch.cwd === 'string' && patch.cwd.trim()) || null;
    if (patch.status === 'active' || patch.status === 'archived') clean.status = patch.status;
    return store.updateTrail(id, clean);
  });
  handle('trail:delete', id => store.deleteTrail(id));
  handle('trail:suggestion', (trailId, suggestionId, accept, text) => {
    const t = store.resolveSuggestion(trailId, suggestionId, Boolean(accept), typeof text === 'string' && text.trim() ? text : null);
    if (t && accept) autoCondense(trailId);
    return t;
  });
  handle('trail:condense', (id, action, text) => {
    if (action === 'start') return startCondense(id);
    if (action === 'apply') return store.applyCondense(id, typeof text === 'string' ? text : null);
    if (action === 'dismiss') return store.dismissCondense(id);
    if (action === 'undo') return store.undoCondense(id);
    return null;
  });
  handle('session:setTrail', (id, trailId) => store.setSessionTrail(id, trailId || null));

  handle('session:create', opts => {
    const id = sessions.create(opts);
    clearTodoStarts(opts?.todoIds);
    return id;
  });
  handle('session:buffer', (id, tail) => sessions.buffer(id, tail));
  handle('session:kill', id => sessions.kill(id));
  handle('session:forget', id => { sessions.kill(id); store.forgetSession(id); });
  handle('session:rename', (id, title) => store.patchSession(id, { title }));
  handle('session:link', (id, todoId) => store.linkSession(id, todoId));
  handle('session:mute', (id, muted) => store.patchSession(id, { muted: Boolean(muted) }));
  handle('sessions:clearClosed', () => store.forgetClosedSessions());
  // Terminal input never marks a session seen: every xterm, visible or not, also answers the
  // TUI's own queries (cursor position, colours, focus), which would clear "unread" instantly.
  // Seen = opening the session, or returning to the window while it's on screen.
  on('session:write', (id, data) => sessions.write(id, data));
  on('session:interrupt', id => sessions.interruptHint(id));
  // Read hides the dot (and dismisses a "needs you" until the next real event); unread shows
  // the blue "your turn" dot again.
  handle('session:markRead', (id, read) => {
    const s = store.session(id);
    if (!s) return;
    store.patchSession(id, read ? { unseen: false, ...(s.status === 'waiting' ? { status: 'idle' } : {}) } : { unseen: true });
  });
  handle('run:markRead', (id, read) => store.patchRun(id, { unseen: !read }));
  handle('run:decide', (approvalId, decision, rule) => approvals.decide(approvalId, decision, rule));
  handle('run:allowAll', (id, on) => approvals.setAllowAll(id, on));
  handle('session:clearRestorable', () => {
    for (const s of store.state.sessions) if (s.restorable) s.restorable = false;
    store.changed();
  });
  on('session:resize', (id, cols, rows) => sessions.resize(id, cols, rows));

  handle('run:events', id => runs.getEvents(id));
  handle('run:cancel', id => {
    runs.cancel(id);
    approvals.denyAllFor(id, 'The run was cancelled.');
  });
  handle('run:reviewed', id => {
    store.patchRun(id, { status: 'reviewed', unseen: false });
    // Continuing a prepared workflow's run is starting that workflow.
    for (const w of store.state.workflows) if (w.due?.runId === id) store.updateWorkflow(w.id, { due: null, lastStartedAt: new Date().toISOString() });
  });
  handle('run:forget', id => { store.forgetRuns([id]); runs.deleteFiles([id]); });
  handle('runs:clearFinished', () => {
    const ids = store.state.runs.filter(r => r.status !== 'running' && !r.unseen).map(r => r.id);
    store.forgetRuns(ids);
    runs.deleteFiles(ids);
    return ids.length;
  });

  handle('workflow:add', fields => store.addWorkflow({ cwd: config.defaultCwd, ...cleanWorkflow(fields) }));
  handle('workflow:update', (id, patch) => store.updateWorkflow(id, cleanWorkflow(patch)));
  handle('workflow:delete', id => store.deleteWorkflow(id));
  handle('workflow:start', (id, values, opts) => startWorkflow(id, values, opts && 'trailId' in opts ? { trailId: opts.trailId || null } : {}));
  handle('workflow:prepare', id => prepareWorkflow(id));
  handle('workflow:dismiss', id => store.updateWorkflow(id, { due: null }));
  handle('workflow:render', (template, values) => ({ fields: parseFields(template), text: renderTemplate(template, values) }));
  handle('workflow:fromSession', id => {
    const s = store.session(id);
    if (!s) return null;
    const template = s.firstMessage || firstPrompt(s.claudeSessionId || s.id) || '';
    return store.addWorkflow({ name: (s.title || 'New workflow').replace(/ · .*$/, ''), cwd: s.cwd, template, trailId: s.trailId || null });
  });
  handle('workflow:fromRun', id => {
    const r = store.run(id);
    return r ? store.addWorkflow({ name: r.title.replace(/ · .*$/, ''), cwd: r.cwd, mode: 'run', template: r.prompt, runAllowAll: Boolean(r.allowAll), trailId: r.trailId || null, writeDirs: r.writeDirs || [] }) : null;
  });

  handle('recent:list', () => {
    const known = new Set(store.state.sessions.flatMap(s => [s.id, s.claudeSessionId]).concat(store.state.runs.map(r => r.id)));
    return recentSessions(known);
  });

  handle('config:set', patch => {
    saveOverrides(patch);
    config = Object.assign(config, mergeDeep(config, patch));
    sessions.config = config;
    runs.config = config;
    if (patch && patch.remote) { remote.apply().catch(e => console.error('[stroll] phone access:', e.message)); updateAwake(); }
    send('config:changed', publicConfig());
    return publicConfig();
  });
  handle('remote:get', () => remote.status());
  handle('remote:pair', () => remote.startPairing());
  handle('remote:cancelPair', () => remote.cancelPairing());
  handle('remote:forget', id => remote.forget(id));
  handle('remote:testPush', id => remote.testPush(id));
  handle('app:checkUpdates', async () => { await checkUpdates(); return updateInfo; });
  handle('app:whatsNew', all => whatsNew(Boolean(all)));
  handle('app:applyUpdate', () => applyUpdate());

  handle('dialog:pickDir', async start => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: start || config.defaultCwd });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:pickFiles', async start => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], defaultPath: start || config.defaultCwd });
    return r.canceled ? [] : r.filePaths;
  });
  handle('open:external', url => openLink(url));
  on('ui:focus', view => { focusView = view; if (win?.isFocused()) markSeen(view); });
}

// http(s) goes to the browser. file:// opens in Zed when it's on the PATH, at the line from a
// #42 or #L42 fragment. Without Zed a file is shown, never run: a link's text can say anything,
// and opening a .command or .app with its default app would launch it. So macOS opens it in
// the text editor, and directories (and everything on other systems) are revealed instead.
function openLink(url) {
  if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
  if (!/^file:\/\//i.test(url)) return undefined;
  let file; let line;
  try {
    const u = new URL(url);
    line = u.hash.match(/^#L?(\d+)$/)?.[1];
    u.hash = '';
    file = fileURLToPath(u);
  } catch (_) {
    return undefined; // malformed, or a file:// link to another host
  }
  if (!fs.existsSync(file)) return undefined;
  const zed = findOnPath('zed', config.envPath);
  const done = () => {};
  if (zed) execFile(zed, [line ? `${file}:${line}` : file], done);
  else if (process.platform === 'darwin' && fs.statSync(file).isFile()) execFile('open', ['-t', file], done);
  else shell.showItemInFolder(file);
  return undefined;
}

async function boot() {
  // Run from source, the Dock would show Electron's icon; use Stroll's.
  app.dock?.setIcon(nativeImage.createFromPath(ICON_PATH));
  config = loadConfig();
  store = new Store(paths.state);
  // A new install starts with nothing to catch up on.
  if (store.fresh) store.state.lastSeenVersion = app.getVersion();
  server = new Server();
  sessions = new Sessions({ store, config, paths, server });
  runs = new Runs({ store, config, paths });
  approvals = new Approvals({ store, config });
  approvals.on('requested', (run, a) => {
    notify('A background run needs your OK', `${run.title}: ${a.detail.slice(0, 140)}`, { type: 'run', id: run.id }, { kind: 'needsYou', desktop: !isLookingAt('run', run.id) });
  });
  approvals.on('config', () => send('config:changed', publicConfig()));
  runs.deleteFiles(store.prune());

  await server.start({
    onHook: (id, event, payload) => sessions.handleHook(id, event, payload),
    listTodos: status => store.state.todos.filter(t => status === 'all' || t.status === status),
    addTodo: body => store.addTodo(body),
    // A session can't move a to-do that is set to start on its own: where it starts is the
    // user's choice, made in Stroll's window.
    updateTodo: (id, patch) => {
      if (store.todo(id)?.startAt && patch && (patch.cwd !== undefined || patch.trailId !== undefined)) {
        return { error: "This to-do is set to start on its own, so its working directory and trail can only be changed in Stroll's window. Ask the user to do it there." };
      }
      return store.updateTodo(id, patch);
    },
    handoffTodo: (id, { instructions, cwd }) => {
      if (!store.todo(id)) return { error: 'no such to-do' };
      try { return { runId: startHandoff([id], { instructions, cwd }), status: 'running' }; } catch (e) { return { error: e.message }; }
    },
    listRuns: status => store.state.runs
      .filter(r => !status || r.status === status)
      .map(({ prompt, ...r }) => r),
    requestApproval: body => approvals.request(body),
    getApproval: id => approvals.get(id),
    listSessions: () => store.state.sessions.map(s => ({ id: s.id, title: s.title, cwd: s.cwd, live: s.live, status: s.status, preview: s.preview, todoIds: s.todoIds, trailId: s.trailId || null, lastActivityAt: s.lastActivityAt })),
    listTrails: () => store.state.trails.filter(t => t.status === 'active')
      .map(t => ({ id: t.id, title: t.title, cwd: t.cwd, liveSessions: store.state.sessions.filter(x => x.trailId === t.id && x.live).length, openTodos: store.state.todos.filter(x => x.trailId === t.id && x.status === 'open').length })),
    getTrail: (trailId, sessionId) => trailForApi(trailId, sessionId) || { error: trailId ? 'no such trail' : NO_TRAIL },
    suggestTrailNote: ({ trailId, sessionId, text, replaces }) => {
      const t = store.trail(trailId || store.session(sessionId)?.trailId);
      if (!t) return { error: trailId ? 'no such trail' : NO_TRAIL };
      if (replaces && !quotedLines(t.notes, replaces)) return { error: NOT_IN_NOTES };
      const sug = store.suggestTrailNote(t.id, text, sessionId, replaces);
      if (!sug) return { error: 'text is required' };
      return { ok: true, trail: t.title, message: `Suggested${sug.replaces ? ', in place of the line it replaces' : ''}. The user accepts or dismisses it in Stroll.` };
    },
    addTrailNote: ({ trailId, sessionId, text, replaces }) => {
      const t = store.trail(trailId || store.session(sessionId)?.trailId);
      if (!t) return { error: trailId ? 'no such trail' : NO_TRAIL };
      const old = replaces ? quotedLines(t.notes, replaces) : null;
      if (replaces && !old) return { error: NOT_IN_NOTES };
      if (!store.appendTrailNote(t.id, text, old)) return { error: 'text is required' };
      autoCondense(t.id);
      return { ok: true, trail: t.title, notes: t.notes };
    },
  });
  writeHookSettings(paths.hookSettings);
  writeMcpConfig(paths.mcpConfig, { serverScript: paths.mcpServer, port: server.port, token: server.token });
  writeMcpConfig(paths.mcpConfigRuns, { serverScript: paths.mcpServer, port: server.port, token: server.token, mode: 'runs' });

  let pendingState = null;
  store.on('change', () => {
    updateBadge();
    updateAwake();
    clearTimeout(pendingState);
    pendingState = setTimeout(() => send('state:changed', store.snapshot()), 30);
  });
  sessions.on('data', (id, seq, data) => send('session:data', id, seq, data));
  sessions.on('exit', id => { send('session:exit', id); scheduledStarts.delete(id); });
  sessions.on('size', (id, cols, rows) => send('session:size', id, cols, rows));
  sessions.on('failed', (id, message) => {
    send('ui:error', message);
    // One a schedule opened: it was announced as started, so say that it didn't.
    const sched = scheduledStarts.get(id);
    const t = sched && store.todo(sched.todoId);
    if (!t || t.status !== 'open') return;
    store.setTodoStart(t.id, { startMissed: sched.at, startError: message });
    notify(`${t.title} didn't start`, message, { type: 'todo', id: t.id });
  });
  sessions.on('attention', (id, message, kind) => {
    const looking = isLookingAt('session', id);
    if (looking) markSeen({ type: 'session', id });
    const s = store.session(id);
    if (s?.muted) return;
    notify(s?.title || 'Claude session', message, { type: 'session', id }, { kind, key: kind === 'finishedTurns' ? `turn:${id}` : null, desktop: !looking });
  });
  runs.on('event', (id, ev) => send('run:event', id, ev));
  runs.on('finished', id => {
    approvals.denyAllFor(id, 'The run ended.');
    const r = store.run(id);
    if (!r || r.status === 'cancelled') return;
    const looking = isLookingAt('run', id);
    if (!looking) store.patchRun(id, { unseen: true });
    notify(r.status === 'ready' ? 'Background run ready' : `Background run ${r.status}`, r.title, { type: 'run', id }, { kind: 'backgroundRuns', desktop: !looking });
  });

  registerIpc();
  // Phone access: off until the user turns it on in Settings.
  remote = new Remote({ file: paths.remote, config, api: { invoke: invokeHandlers, send: sendHandlers, seen: markSeen, version: app.getVersion() } });
  remote.on('changed', status => send('remote:changed', status));
  remote.on('paired', device => notify('Phone paired', `${device.name} can now reach Stroll on this computer.`, { type: 'settings' }, { phones: false }));
  remote.apply().catch(e => console.error('[stroll] phone access:', e.message));
  buildMenu();
  createWindow();
  updateBadge();
  importWorkflows();
  setInterval(() => { checkReminders(); checkWorkflows(); checkTodoStarts(); }, 30 * 1000);
  setTimeout(() => { checkReminders(); checkWorkflows(); checkTodoStarts(); }, 3000);
  setTimeout(checkUpdates, 15 * 1000);
  setInterval(checkUpdates, 6 * 60 * 60 * 1000);
}

if (!app.requestSingleInstanceLock()) {
  // Another Stroll is running: it gets focused (second-instance) and this one leaves before
  // booting, so it can't overwrite the running instance's mcp-config.json.
  app.exit(0);
} else {
  app.whenReady().then(boot);
  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());
  // Closing the window keeps sessions and runs alive; quitting ends them.
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', e => {
    if (!quitting) {
      const busy = sessions?.busyCount() || 0;
      const running = runs?.busyCount() || 0;
      if (busy || running) {
        e.preventDefault();
        const what = [busy && `${busy} session${busy === 1 ? ' is' : 's are'} working`, running && `${running} background run${running === 1 ? ' is' : 's are'} running`].filter(Boolean).join(' and ');
        const choice = dialog.showMessageBoxSync(win || undefined, {
          type: 'warning', buttons: ['Quit', 'Cancel'], defaultId: 1, cancelId: 1,
          message: 'Quit Stroll?', detail: `${what}. Quitting stops them. Sessions can be resumed later; background runs can't.`,
        });
        if (choice !== 0) return;
      }
      quitting = true;
      if (busy || running) { app.quit(); return; }
    }
    sessions?.killAll();
    sessions?.stop();
    runs?.killAll();
    killCondenses();
    remote?.stop();
    store?.flush();
    server?.stop();
  });
}
