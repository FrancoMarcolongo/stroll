const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');

const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const INDEX_PATH = path.join(__dirname, '..', 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(INDEX_PATH).href;
const { paths, loadConfig, saveOverrides, mergeDeep } = require('./config');
const { Store } = require('./store');
const { Sessions } = require('./sessions');
const { Runs } = require('./runs');
const { Approvals } = require('./approvals');
const { Server, writeHookSettings, writeMcpConfig } = require('./server');
const { recentSessions } = require('./recent');

app.setName('Stroll');
// A separate data folder (tests, experiments) gets its own Electron profile, so it can run
// next to the real Stroll instead of tripping the single-instance lock.
if (process.env.STROLL_HOME) app.setPath('userData', path.join(process.env.STROLL_HOME, 'electron-profile'));

let win = null;
let config; let store; let sessions; let runs; let server; let approvals;
let focusView = null; // what the user is looking at: { type, id }
let pendingNav = null; // a view to open once a (re)created window has loaded
let updateInfo = null;
let quitting = false;
const shownNotifications = new Set(); // macOS drops click events of notifications that get garbage-collected
const lastNotified = new Map();


const handoffPrompt = (todos, instructions, cwd) => [
  todos.length === 1 ? `Work on this to-do from the user's list: ${todos[0].title}` : "Work on these to-dos from the user's list:",
  ...(todos.length === 1 ? [] : todos.map(t => `- ${t.title}`)),
  ...todos.filter(t => t.notes).map(t => `Notes on "${t.title}": ${t.notes}`),
  instructions ? `\nInstructions: ${instructions}` : '',
  `\nWorking folder: ${cwd}`,
  '\nInvestigate, gather the context needed and prepare drafts so the user can finish this quickly.',
].filter(Boolean).join('\n');

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function notify(title, body, view, { kind = null, key = null } = {}) {
  const n = config.notifications || {};
  if (!Notification.isSupported() || !n.enabled || (kind && n[kind] === false)) return;
  if (key) {
    // A session finishing turn after turn (e.g. under /loop) pings at most every 20s.
    const last = lastNotified.get(key) || 0;
    if (Date.now() - last < 20000) return;
    lastNotified.set(key, Date.now());
  }
  const note = new Notification({ title, body: body || '', silent: n.sound === false });
  shownNotifications.add(note);
  const forget = () => shownNotifications.delete(note);
  note.on('click', () => { forget(); showWindow(view); });
  note.on('close', forget);
  note.show();
}

function isLookingAt(type, id) {
  return win && win.isFocused() && focusView && focusView.type === type && focusView.id === id;
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
  const total = waiting + ready;
  app.dock?.setBadge(total ? String(total) : '');
}

// `allowAll` comes only from the hand-off dialog: a hand-off asked for from inside a Claude
// session (the MCP tool) can't turn off the run's permission prompts.
function startHandoff(todoIds, { instructions = '', prompt = null, cwd = null, title = null, allowAll = false } = {}) {
  const todos = todoIds.map(id => store.todo(id)).filter(Boolean);
  const dir = cwd || todos.find(t => t.cwd)?.cwd || store.state.recentDirs[0] || config.defaultCwd;
  return runs.start({
    prompt: prompt || handoffPrompt(todos, instructions, dir),
    cwd: dir,
    title: title || (todos.length === 1 ? todos[0].title : todos.length ? `${todos.length} to-dos` : null),
    todoIds,
    allowAll,
  });
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
    claudePath: config.claudePath,
    claudeMissing: !config.claudePath,
    version: app.getVersion(),
    appDir: paths.appDir,
  };
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
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
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
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('ui:command', 'settings') },
        { label: 'Check for Updates…', click: () => checkUpdates().then(() => send('ui:command', updateInfo ? 'show-update' : 'up-to-date')) },
        { type: 'separator' },
        { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Session', accelerator: 'CmdOrCtrl+N', click: () => send('ui:command', 'new-session') },
        { label: 'Add To-do', accelerator: 'CmdOrCtrl+K', click: () => send('ui:command', 'quick-add') },
        { label: 'Overview', accelerator: 'CmdOrCtrl+0', click: () => send('ui:command', 'home') },
        { label: 'Next Needing You', accelerator: 'CmdOrCtrl+J', click: () => send('ui:command', 'next-needs') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Every IPC call must come from Stroll's own page.
const fromApp = e => e.senderFrame && e.senderFrame.url.split('#')[0] === INDEX_URL;
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromApp(e)) throw new Error('blocked');
    return fn(...args);
  });
}
function on(channel, fn) {
  ipcMain.on(channel, (e, ...args) => { if (fromApp(e)) fn(...args); });
}

function registerIpc() {
  handle('state:get', () => ({ ...store.snapshot(), config: publicConfig(), update: updateInfo }));

  handle('todo:add', data => store.addTodo(data));
  handle('todo:update', (id, patch) => store.updateTodo(id, patch));
  handle('todo:delete', id => store.deleteTodo(id));
  handle('todo:handoff', (todoIds, opts) => startHandoff(todoIds, opts));

  handle('session:create', opts => sessions.create(opts));
  handle('session:buffer', id => sessions.buffer(id));
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
  handle('run:reviewed', id => store.patchRun(id, { status: 'reviewed', unseen: false }));
  handle('run:forget', id => { store.forgetRuns([id]); runs.deleteFiles([id]); });
  handle('runs:clearFinished', () => {
    const ids = store.state.runs.filter(r => r.status !== 'running' && !r.unseen).map(r => r.id);
    store.forgetRuns(ids);
    runs.deleteFiles(ids);
    return ids.length;
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
    send('config:changed', publicConfig());
    return publicConfig();
  });
  handle('app:checkUpdates', async () => { await checkUpdates(); return updateInfo; });
  handle('app:applyUpdate', () => applyUpdate());

  handle('dialog:pickDir', async start => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: start || config.defaultCwd });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('open:external', url => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); });
  on('ui:focus', view => { focusView = view; if (win?.isFocused()) markSeen(view); });
}

async function boot() {
  // Run from source, the Dock would show Electron's icon; use Stroll's.
  app.dock?.setIcon(nativeImage.createFromPath(ICON_PATH));
  config = loadConfig();
  store = new Store(paths.state);
  server = new Server();
  sessions = new Sessions({ store, config, paths, server });
  runs = new Runs({ store, config, paths });
  approvals = new Approvals({ store, config });
  approvals.on('requested', (run, a) => {
    if (isLookingAt('run', run.id)) return;
    notify('A background run needs your OK', `${run.title}: ${a.detail.slice(0, 140)}`, { type: 'run', id: run.id }, { kind: 'needsYou' });
  });
  approvals.on('config', () => send('config:changed', publicConfig()));
  runs.deleteFiles(store.prune());

  await server.start({
    onHook: (id, event, payload) => sessions.handleHook(id, event, payload),
    listTodos: status => store.state.todos.filter(t => status === 'all' || t.status === status),
    addTodo: body => store.addTodo(body),
    updateTodo: (id, patch) => store.updateTodo(id, patch),
    handoffTodo: (id, { instructions, cwd }) => {
      if (!store.todo(id)) return { error: 'no such to-do' };
      try { return { runId: startHandoff([id], { instructions, cwd }), status: 'running' }; } catch (e) { return { error: e.message }; }
    },
    listRuns: status => store.state.runs
      .filter(r => !status || r.status === status)
      .map(({ prompt, ...r }) => r),
    requestApproval: body => approvals.request(body),
    getApproval: id => approvals.get(id),
    listSessions: () => store.state.sessions.map(s => ({ id: s.id, title: s.title, cwd: s.cwd, live: s.live, status: s.status, preview: s.preview, todoIds: s.todoIds, lastActivityAt: s.lastActivityAt })),
  });
  writeHookSettings(paths.hookSettings);
  writeMcpConfig(paths.mcpConfig, { serverScript: paths.mcpServer, port: server.port, token: server.token });
  writeMcpConfig(paths.mcpConfigRuns, { serverScript: paths.mcpServer, port: server.port, token: server.token, mode: 'runs' });

  let pendingState = null;
  store.on('change', () => {
    updateBadge();
    clearTimeout(pendingState);
    pendingState = setTimeout(() => send('state:changed', store.snapshot()), 30);
  });
  sessions.on('data', (id, seq, data) => send('session:data', id, seq, data));
  sessions.on('exit', id => send('session:exit', id));
  sessions.on('failed', (id, message) => send('ui:error', message));
  sessions.on('attention', (id, message, kind) => {
    if (isLookingAt('session', id)) { markSeen({ type: 'session', id }); return; }
    const s = store.session(id);
    if (s?.muted) return;
    notify(s?.title || 'Claude session', message, { type: 'session', id }, { kind, key: kind === 'finishedTurns' ? `turn:${id}` : null });
  });
  runs.on('event', (id, ev) => send('run:event', id, ev));
  runs.on('finished', id => {
    approvals.denyAllFor(id, 'The run ended.');
    const r = store.run(id);
    if (!r || r.status === 'cancelled' || isLookingAt('run', id)) return;
    store.patchRun(id, { unseen: true });
    notify(r.status === 'ready' ? 'Background run ready' : `Background run ${r.status}`, r.title, { type: 'run', id }, { kind: 'backgroundRuns' });
  });

  registerIpc();
  buildMenu();
  createWindow();
  updateBadge();
  setInterval(checkReminders, 30 * 1000);
  setTimeout(checkReminders, 3000);
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
    store?.flush();
    server?.stop();
  });
}
