// Stroll on a phone: a second view of the Stroll running on your computer. Nothing runs here.
// It shows what needs you there and lets you answer: approve what a run asks for, read a
// report, tick a to-do, start a workflow. The connection is link.js.
(function () {
  const link = new self.StrollLink();
  const C = self.StrollChannel;
  const $ = sel => document.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const S = { data: null, view: { type: 'home' }, busy: new Set() };

  // --- small helpers, the same wording and rules as the desktop window ---
  function ago(iso) {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }
  const agoText = iso => (ago(iso) === 'now' ? 'just now' : `${ago(iso)} ago`);
  const shortDir = d => (d ? d.replace(/^\/(Users|home)\/[^/]+/, '~') : '');
  function lightMarkdown(text) {
    return esc(text)
      .replace(/^(#{1,4}) (.*)$/gm, '<span class="h">$2</span>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  }
  const SESSION_LABEL = { working: 'Working', waiting: 'Needs you', idle: 'Your turn', starting: 'Starting', bg: 'Running in the background' };
  const RUN_LABEL = { running: 'Running', ready: 'Ready for you', failed: 'Failed', reviewed: 'Reviewed', cancelled: 'Cancelled', interrupted: 'Interrupted' };
  function sessionDot(s) {
    if (!s.live) return 'none';
    if (s.status === 'working') return 'working';
    if (s.status === 'waiting') return 'waiting';
    if (s.status === 'idle' && s.unseen) return 'idle';
    if (s.background?.length) return 'bg';
    return 'none';
  }
  function runDot(r) {
    if (r.pendingApproval) return 'waiting';
    if (r.status === 'running') return 'working';
    if (!r.unseen) return 'none';
    return r.status === 'ready' ? 'idle' : 'waiting';
  }
  const dot = kind => `<i class="dot ${kind}"></i>`;
  const run = id => S.data?.runs.find(r => r.id === id);
  const session = id => S.data?.sessions.find(s => s.id === id);
  const workflow = id => (S.data?.workflows || []).find(w => w.id === id);
  const computer = () => link.ready?.name || link.computer?.name || 'your computer';

  function slotText(iso) {
    const d = new Date(iso);
    const days = Math.round((new Date(iso).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (days === 0) return `today ${time}`;
    if (days === 1) return `tomorrow ${time}`;
    if (days === -1) return `yesterday ${time}`;
    return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
  }
  function workflowStatus(w) {
    const d = w.due;
    if (d?.error) return `Couldn’t prepare: ${d.error}`;
    if (d?.missed) return `Missed ${slotText(d.at)}`;
    if (d?.runId) {
      const r = run(d.runId);
      if (!r) return 'Prepared';
      if (r.pendingApproval) return 'Preparing · needs your OK';
      if (r.status === 'running') return 'Preparing in the background…';
      return r.status === 'ready' || r.status === 'reviewed' ? 'Prepared · ready to continue' : `Prep ${(RUN_LABEL[r.status] || r.status).toLowerCase()}`;
    }
    if (d) return `Due since ${slotText(d.at)}`;
    if (w.nextAt) return `Next ${slotText(w.nextAt)}`;
    if (w.lastStartedAt) return `Last started ${agoText(w.lastStartedAt)}`;
    return w.mode === 'run' ? 'Runs in the background' : 'Opens a session';
  }

  // --- feedback ---
  let toastTimer = null;
  function toast(text, error = false) {
    const el = $('#toast');
    el.textContent = text;
    el.className = error ? 'show error' : 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ''; }, error ? 6000 : 2600);
  }
  // Asks the computer for something; says so when it couldn't.
  async function ask(channel, ...args) {
    try { return await link.invoke(channel, ...args); } catch (e) { toast(e.message, true); throw e; }
  }
  function confirmSheet({ title, body, confirm, danger = false }) {
    return new Promise(resolve => {
      const el = $('#sheet');
      el.innerHTML = `<div class="sheet-card"><h2>${esc(title)}</h2><p>${esc(body)}</p>
        <div class="actions"><button class="btn" data-no>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(confirm)}</button></div></div>`;
      el.className = 'show';
      const done = answer => { el.className = ''; el.innerHTML = ''; resolve(answer); };
      el.querySelector('[data-yes]').onclick = () => done(true);
      el.querySelector('[data-no]').onclick = () => done(false);
      el.onclick = e => { if (e.target === el) done(false); };
    });
  }

  // --- navigation: the address keeps the view, so the phone's back button works ---
  function parseHash() {
    if (location.hash === '#/new') return { type: 'new' };
    const m = location.hash.match(/^#\/(run|workflow|session)\/([\w-]+)$/);
    return m ? { type: m[1], id: m[2] } : { type: 'home' };
  }
  const hashOf = view => (view.type === 'home' ? '#/' : view.id ? `#/${view.type}/${view.id}` : `#/${view.type}`);
  function go(view) {
    if (location.hash !== hashOf(view)) location.hash = hashOf(view); else show();
  }
  // Looking at a run or a session counts as having seen it, and gets its live output.
  const focusOf = view => (view.type === 'run' || view.type === 'session' ? view : { type: 'home' });
  function show() {
    S.view = parseHash();
    if (S.view.type !== 'session') closeTerminal();
    link.send('ui:focus', focusOf(S.view));
    render(true);
  }
  // Opened from a pairing code? It's in the address after #p=. It's taken out of the address
  // (and the history) at once: it's a one-time key to this phone's access.
  function takeCode() {
    if (!location.hash.startsWith('#p=')) return null;
    const code = location.hash.slice(3);
    history.replaceState(null, '', `${location.pathname}#/`);
    return code;
  }
  addEventListener('hashchange', () => {
    // Scanning a code while the app is already open only changes the address: pair with it.
    const code = takeCode();
    if (!code) { show(); return; }
    S.data = null;
    S.view = { type: 'home' };
    closeTerminal();
    render(true);
    link.pair(code).catch(e => link.set('refused', `This browser can’t keep the pairing: ${e.message}`));
  });

  // --- rendering: each part is replaced only when its markup changed ---
  const drawn = new WeakMap();
  function setHtml(el, markup) {
    if (!el || drawn.get(el) === markup) return;
    drawn.set(el, markup);
    el.innerHTML = markup;
  }

  function render(fresh = false) {
    const view = $('#view');
    const state = link.state;
    document.body.dataset.link = state;
    setHtml($('#bar'), barHtml());
    setHtml($('#banner'), bannerHtml());
    setHtml($('#getapp'), getAppHtml());
    if (state === 'unpaired') { setHtml(view, unpairedHtml()); return; }
    if (state === 'refused') { setHtml(view, refusedHtml()); return; }
    if (!S.data) { setHtml(view, waitingHtml()); return; }
    if (fresh) { drawn.delete(view); view.scrollTop = 0; }
    view.className = S.view.type;
    if (S.view.type === 'run') renderRun(view);
    else if (S.view.type === 'workflow') renderWorkflow(view, fresh);
    else if (S.view.type === 'session') renderSession(view);
    else if (S.view.type === 'new') renderNew(view, fresh);
    else renderHome(view);
  }

  function barHtml() {
    const back = S.view.type !== 'home' && S.data ? '<button class="back" data-act="back" aria-label="Back">‹</button>' : '';
    const title = S.view.type === 'run' ? esc(run(S.view.id)?.title || 'Run') : S.view.type === 'workflow' ? esc(workflow(S.view.id)?.name || 'Workflow')
      : S.view.type === 'session' ? esc(session(S.view.id)?.title || 'Session') : S.view.type === 'new' ? 'New session' : 'Stroll';
    const where = S.view.type === 'home' && link.computer ? `<span class="where">${esc(computer())}</span>` : '';
    return `${back}<h1>${title}</h1>${where}<i class="conn ${esc(link.state)}" aria-label="${esc(link.state)}"></i>`;
  }

  // With something on screen already, a lost connection is a line at the top, not a blank page.
  // In a browser on Android, the app is worth having: full screen, and notifications open it.
  const inApp = matchMedia('(display-mode: standalone)').matches || document.referrer.startsWith('android-app://');
  const isAndroid = /Android/.test(navigator.userAgent);
  const offerApp = !inApp && !/iPhone|iPad|iPod/.test(navigator.userAgent); // nothing to offer an iPhone yet
  function getAppHtml() {
    let declined = false;
    try { declined = localStorage.getItem('stroll.noAppPrompt') === '1'; } catch (_) { /* no storage: ask */ }
    if (!offerApp || !isAndroid || declined) return '';
    return `<div class="getapp"><p><b>Get the Stroll app.</b> Full screen, and its notifications open straight into what needs you.</p>
      <div class="actions"><a class="btn primary link" href="stroll.apk" download>Download</a><button class="btn" data-act="no-app">Not now</button></div></div>`;
  }

  function bannerHtml() {
    if (!S.data || link.state === 'online' || link.state === 'refused' || link.state === 'unpaired') return '';
    return link.state === 'offline'
      ? `<p><b>${esc(computer())} isn’t reachable.</b> It has to be on, awake and running Stroll. What’s below is how things were.</p>`
      : '<p>Reconnecting…</p>';
  }

  const unpairedHtml = () => `<section class="center">
      <h2>Stroll on your phone</h2>
      <p>This is remote access to the Stroll running on your computer. Nothing runs here: the computer has to be on and awake.</p>
      <ol><li>On the computer, open Stroll › Settings › Phone access and turn it on.</li>
        <li>Press <b>Pair a phone</b>.</li>
        <li>Scan the code with this phone’s camera.</li></ol>
      ${offerApp ? '<a class="btn link" href="stroll.apk" download>Get the Android app</a>' : ''}
    </section>`;

  const refusedHtml = () => `<section class="center">
      <h2>Not connected</h2>
      <p>${esc(link.reason || 'The computer refused the connection.')}</p>
      <p>To pair this phone, press <b>Pair a phone</b> in Stroll › Settings › Phone access on the computer and scan the code.</p>
      ${link.computer ? '<button class="btn" data-act="forget">Forget this computer</button>' : ''}
    </section>`;

  const waitingHtml = () => `<section class="center">
      ${link.state === 'offline'
    ? `<h2>${esc(computer())} isn’t reachable</h2><p>It has to be on, awake and running Stroll with phone access on. This page connects by itself when it is.</p>`
    : `<h2>Connecting…</h2><p>${link.state === 'online' ? `Getting what’s on ${esc(computer())}.` : link.stage === 'computer' ? `Waiting for ${esc(computer())} to answer.` : 'Reaching the relay.'}</p>
      ${link.attempt >= 2 ? `<p>This is taking longer than it should. ${esc(computer())} has to be on, awake and running Stroll with phone access on. If it is, pairing again from its Settings usually sorts it out.</p>
        <button class="btn" data-act="retry">Try again</button><button class="linkish" data-act="forget">Forget this computer</button>` : ''}`}
    </section>`;

  // --- home ---
  const row = (kind, id, mark, title, sub, extra = '') => `<li><button class="row" data-open="${kind}" data-id="${esc(id)}">${mark}
      <span class="main"><span class="title">${esc(title)}</span><span class="sub">${esc(sub)}</span></span>${extra}</button></li>`;
  const runRow = r => row('run', r.id, dot(runDot(r)), r.title,
    r.pendingApproval ? `Needs your OK: ${r.pendingApproval.detail}` : r.status === 'running' ? (r.lastActivity || 'Running') : `${RUN_LABEL[r.status] || r.status} · ${agoText(r.finishedAt || r.startedAt)}`,
    '<span class="chev">›</span>');
  const sessionRow = s => row('session', s.id, dot(sessionDot(s)), s.title || 'Untitled session', s.preview || SESSION_LABEL[sessionDot(s)] || SESSION_LABEL[s.status] || '', '<span class="chev">›</span>');
  const workflowRow = w => row('workflow', w.id, dot(w.due && !w.due.runId ? 'waiting' : 'none'), w.name, workflowStatus(w), '<span class="go">Start</span>');
  const todoRow = t => `<li><div class="row"><button class="check ${t.status === 'done' ? 'on' : ''}" data-act="todo-toggle" data-id="${esc(t.id)}" aria-label="${t.status === 'done' ? 'Reopen' : 'Mark done'}"></button>
      <span class="main"><span class="title">${esc(t.title)}</span>${t.notes ? `<span class="sub">${esc(t.notes.split('\n')[0])}</span>` : ''}</span></div></li>`;
  const section = (id, title, rows, hint = '') => `<section id="${id}"><h3>${title}${hint ? `<small>${hint}</small>` : ''}</h3><ul class="list">${rows}</ul></section>`;

  function renderHome(view) {
    if (!view.querySelector('#home')) {
      setHtml(view, `<div id="home"><div id="h-needs"></div><div id="h-progress"></div>
        <section id="h-todos"><h3>To-dos</h3>
          <form id="todo-add" autocomplete="off"><input name="title" placeholder="Add a to-do" enterkeyhint="done"><button class="btn" type="submit">Add</button></form>
          <ul class="list" id="todo-list"></ul></section>
        <div id="h-workflows"></div><div id="h-sessions"></div>
        <button class="btn wide" data-open="new">New session</button>
        <div id="h-runs"></div>
        <footer id="foot"></footer></div>`);
      $('#todo-add').addEventListener('submit', async e => {
        e.preventDefault();
        const input = e.target.elements.title;
        const title = input.value.trim();
        if (!title) return;
        input.value = '';
        try { await ask('todo:add', { title }); } catch (_) { input.value = title; }
      });
    }
    const d = S.data;
    const live = d.sessions.filter(s => s.live);
    const needs = [
      ...live.filter(s => sessionDot(s) === 'waiting').map(sessionRow),
      ...d.runs.filter(r => ['idle', 'waiting'].includes(runDot(r))).map(runRow),
      ...(d.workflows || []).filter(w => w.due && !w.due.runId).map(workflowRow),
      ...live.filter(s => sessionDot(s) === 'idle').map(sessionRow),
    ];
    const progress = [
      ...live.filter(s => ['working', 'bg'].includes(sessionDot(s)) || s.status === 'starting').map(sessionRow),
      ...d.runs.filter(r => r.status === 'running' && !r.pendingApproval).map(runRow),
    ];
    setHtml($('#h-needs'), section('needs', 'Needs you', needs.join('') || '<li class="empty">Nothing is waiting on you.</li>'));
    setHtml($('#h-progress'), progress.length ? section('progress', 'In progress', progress.join('')) : '');
    const open = d.todos.filter(t => t.status === 'open').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    setHtml($('#todo-list'), open.map(todoRow).join('') || '<li class="empty">Nothing open.</li>');
    const flows = d.workflows || [];
    setHtml($('#h-workflows'), flows.length ? section('workflows', 'Workflows', flows.map(workflowRow).join('')) : '');
    const quiet = live.filter(s => sessionDot(s) === 'none' && s.status !== 'starting');
    setHtml($('#h-sessions'), quiet.length ? section('sessions', 'Open sessions', quiet.map(sessionRow).join('')) : '');
    const recent = d.runs.filter(r => r.status !== 'running' && !['idle', 'waiting'].includes(runDot(r)))
      .sort((a, b) => (b.finishedAt || b.startedAt || '').localeCompare(a.finishedAt || a.startedAt || '')).slice(0, 6);
    setHtml($('#h-runs'), recent.length ? section('runs', 'Recent runs', recent.map(runRow).join('')) : '');
    const notes = { on: '<p>This phone is notified when something needs you. <button class="linkish" data-act="notify-off">Turn off</button></p>',
      off: '<button class="btn wide" data-act="notify-on">Notify me when something needs me</button>',
      blocked: '<p>Notifications are blocked for Stroll in this phone’s settings.</p>' }[S.notify] || '';
    setHtml($('#foot'), `${notes}${offerApp ? '<a class="btn wide link" href="stroll.apk" download>Get the Android app</a>' : ''}<p>Remote access to ${esc(computer())}${link.ready?.version ? `, Stroll ${esc(link.ready.version)}` : ''}. It has to be on and awake.</p>
      <button class="linkish" data-act="forget">Forget this computer</button>`);
  }

  // --- a background run: what it asks for, what it found ---
  function renderRun(view) {
    const r = run(S.view.id);
    if (!r) { setHtml(view, '<section class="center"><h2>That run is gone</h2><p>It was removed on the computer.</p></section>'); return; }
    const a = r.pendingApproval;
    const failed = ['failed', 'interrupted', 'cancelled'].includes(r.status);
    const body = r.result || r.error || (r.status === 'interrupted' ? 'Stroll was closed while this run was going.' : 'No result.');
    const pill = a ? 'waiting' : r.status === 'running' ? 'working' : failed ? 'failed' : r.status === 'ready' && r.unseen ? 'idle' : 'neutral';
    const busy = S.busy.has(r.id) ? 'disabled' : '';
    setHtml(view, `<div class="detail">
      <p class="meta"><span class="pill ${pill}">${a ? 'Needs your OK' : RUN_LABEL[r.status] || esc(r.status)}</span> ${esc(shortDir(r.cwd))} · started ${agoText(r.startedAt)}${r.allowAll ? ' · allows everything' : ''}</p>
      ${a ? `<div class="approval"><h3>${esc(a.summary)}</h3><pre>${esc(a.detail)}</pre>
        <div class="actions"><button class="btn primary" data-act="ap-allow" ${busy}>Allow once</button><button class="btn danger" data-act="ap-deny" ${busy}>Deny</button></div>
        <button class="linkish" data-act="ap-all" ${busy}>Allow everything this run asks for</button>
        <p class="hint">Asked ${agoText(a.requestedAt)}. No answer in 15 minutes counts as Deny. Edits, pushes and sending messages stay blocked either way.</p></div>` : ''}
      ${r.status === 'running'
    ? `<p class="working">${a ? 'Paused until you answer.' : `Working… ${esc(r.lastActivity || '')}`}</p>`
    : `<div class="result ${failed ? 'failed' : ''}"><div class="md">${lightMarkdown(body)}</div>
        ${r.permissionDenials?.length ? `<p class="hint">Blocked tools: ${esc([...new Set(r.permissionDenials)].join(', '))}</p>` : ''}</div>`}
      <div class="actions bottom">
        ${r.status === 'running' ? `<button class="btn danger" data-act="run-cancel" ${busy}>Cancel run</button>` : ''}
        ${['ready', 'failed'].includes(r.status) ? `<button class="btn primary" data-act="run-reviewed" ${busy}>Mark reviewed</button>` : ''}
      </div></div>`);
  }

  // --- starting a workflow: its blanks, with last time's values ---
  let form = null; // { id, fields, values }
  async function renderWorkflow(view, fresh) {
    const w = workflow(S.view.id);
    if (!w) { setHtml(view, '<section class="center"><h2>That workflow is gone</h2></section>'); return; }
    if (!fresh && form?.id === w.id) return; // typing isn't interrupted by state pushes
    form = { id: w.id, fields: null, values: { ...w.values } };
    setHtml(view, '<section class="center"><p>Loading…</p></section>');
    let fields;
    try { ({ fields } = await ask('workflow:render', w.template, w.values)); } catch (_) { return; }
    if (S.view.type !== 'workflow' || S.view.id !== w.id) return;
    form.fields = fields;
    setHtml(view, `<form class="detail" id="wf-form" autocomplete="off">
      <p class="meta">${w.mode === 'run' ? 'Runs in the background' : 'Opens a session'} on ${esc(computer())}, in ${esc(shortDir(w.cwd || S.data.config?.defaultCwd || ''))}</p>
      ${fields.map(f => (f.kind === 'switch'
    ? `<label class="switch"><input type="checkbox" name="${esc(f.key)}" ${form.values[f.key] ? 'checked' : ''}><span>${esc(f.label)}<small>Adds ${esc(f.text)}</small></span></label>`
    : `<label class="field"><span>${esc(f.label)}</span><input type="text" name="${esc(f.key)}" value="${esc(form.values[f.key] ?? '')}" placeholder="${esc(f.default)}" autocapitalize="off" spellcheck="false"></label>`)).join('')}
      <div class="field"><span>${w.mode === 'run' ? 'Prompt' : 'First message'}</span><pre id="wf-preview"></pre></div>
      <div class="actions bottom"><button class="btn primary" type="submit">Start</button></div>
    </form>`);
    const el = $('#wf-form');
    const read = () => {
      for (const f of fields) form.values[f.key] = f.kind === 'switch' ? el.elements[f.key].checked : el.elements[f.key].value.trim();
      return form.values;
    };
    const preview = async () => {
      try { $('#wf-preview').textContent = (await link.invoke('workflow:render', w.template, read())).text || 'Empty. Add a first message in the workflow’s Setup, on the computer.'; } catch (_) { /* shown when it connects again */ }
    };
    el.addEventListener('input', preview);
    preview();
    el.addEventListener('submit', async e => {
      e.preventDefault();
      const button = el.querySelector('[type=submit]');
      button.disabled = true;
      try {
        const started = await ask('workflow:start', w.id, read());
        form = null;
        if (started?.type === 'run') { location.replace(`#/run/${started.id}`); return; }
        toast(`Started on ${computer()}`);
        history.back();
      } catch (_) { button.disabled = false; }
    });
  }

  // --- a session: its terminal as it is on the computer, and a way to answer ---
  // The terminal isn't typed into (a phone keyboard has no Esc or arrows, and tapping to
  // scroll would keep opening it): a message goes through the box below, a prompt is answered
  // with the row of keys.
  const THEME = {
    background: '#0e1116', foreground: '#e6edf3', cursor: '#e6edf3', cursorAccent: '#0e1116', selectionBackground: '#2f3b4d',
    black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
    brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
  };
  const KEYS = [['Esc', '\x1b'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['⏎', '\r'], ['1', '1'], ['2', '2'], ['3', '3'], ['Tab', '\t'], ['⇧Tab', '\x1b[Z'], ['^C', '\x03']];
  let T = null; // the open terminal: { id, term, fit, own, lastSeq, ready, queue, observer }

  function closeTerminal() {
    if (!T) return;
    T.observer.disconnect();
    T.term.dispose();
    T = null;
  }

  // A session's terminal has one size. Opening it here gives it this screen's; when the
  // computer takes it back (someone is at the window), the terminal here follows that size and
  // can be panned, until "Fit this screen".
  function takeSize() {
    if (!T) return;
    T.own = true;
    try { T.fit.fit(); } catch (_) { /* not laid out yet */ }
    link.send('session:resize', T.id, T.term.cols, T.term.rows);
    renderSizeNote();
  }
  function renderSizeNote() {
    $('#term')?.classList.toggle('wide', Boolean(T && !T.own));
    setHtml($('#s-size'), T && !T.own ? '<p>Sized for the computer’s window right now. <button class="linkish" data-act="fit-here">Fit this screen</button></p>' : '');
  }

  async function loadBuffer() {
    const t = T;
    if (!t) return;
    t.ready = false;
    t.queue = [];
    let buf;
    try { buf = await link.invoke('session:buffer', t.id); } catch (_) { return; } // retried when it connects again
    if (T !== t) return;
    t.term.reset();
    t.term.write(`${buf.data || ''}${buf.modes || ''}`, () => {
      t.lastSeq = buf.seq;
      t.ready = true;
      for (const [seq, data] of t.queue) if (seq > t.lastSeq) { t.term.write(data); t.lastSeq = seq; }
      t.queue = [];
    });
  }

  function openTerminal(id) {
    const el = $('#term');
    const term = new self.Terminal({ fontFamily: 'ui-monospace, "Roboto Mono", Menlo, monospace', fontSize: 12, scrollback: 3000, theme: THEME, disableStdin: true, cursorBlink: false, allowProposedApi: true });
    const fit = new self.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new self.Unicode11Addon.Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.open(el);
    T = { id, term, fit, own: true, lastSeq: 0, ready: false, queue: [] };
    // The screen changes size when the keyboard opens or the phone turns.
    let settle = null;
    T.observer = new ResizeObserver(() => { clearTimeout(settle); settle = setTimeout(() => { if (T?.own && T.id === id) takeSize(); }, 150); });
    T.observer.observe(el);
    // A finger scrolls back through the output. Claude Code draws the whole screen itself and
    // keeps no scrollback in the terminal: it scrolls when it's told the mouse wheel turned, so
    // that's what a drag sends it. A terminal with its own scrollback is scrolled directly.
    let lastY = null;
    let carry = 0;
    el.addEventListener('touchstart', e => { lastY = e.touches[0].clientY; carry = 0; }, { passive: true });
    el.addEventListener('touchmove', e => {
      if (lastY === null || e.touches.length !== 1) return;
      const screen = term.element?.querySelector('.xterm-screen');
      const box = (screen || el).getBoundingClientRect();
      const cell = box.height / term.rows || 16;
      const wheel = term.modes.mouseTrackingMode !== 'none';
      const step = wheel ? cell * 2 : cell; // an app moves a few lines per turn of the wheel
      carry += lastY - e.touches[0].clientY;
      lastY = e.touches[0].clientY;
      const steps = Math.trunc(carry / step);
      if (!steps) return;
      carry -= steps * step;
      if (!wheel) { term.scrollLines(steps); return; }
      // Wheel down (65) or up (64) at the cell under the finger, as the terminal would report it.
      const col = Math.min(term.cols, Math.max(1, Math.floor((e.touches[0].clientX - box.left) / (box.width / term.cols)) + 1));
      const line = Math.min(term.rows, Math.max(1, Math.floor((e.touches[0].clientY - box.top) / cell) + 1));
      link.send('session:write', id, `\x1b[<${steps > 0 ? 65 : 64};${col};${line}M`.repeat(Math.min(Math.abs(steps), 6)));
    }, { passive: true });
    takeSize();
    loadBuffer();
  }

  function sessionStatus(s) {
    if (!s.live) return ['neutral', 'Ended'];
    const d = sessionDot(s);
    if (d === 'working') return ['working', 'Working'];
    if (d === 'waiting') return ['waiting', 'Needs you'];
    if (d === 'bg') return ['neutral', 'Your turn · still running in the background'];
    return [d === 'idle' ? 'idle' : 'neutral', s.status === 'starting' ? 'Starting' : 'Your turn'];
  }

  function renderSession(view) {
    const s = session(S.view.id);
    if (!s) { closeTerminal(); setHtml(view, '<section class="center"><h2>That session is gone</h2><p>It was removed on the computer.</p></section>'); return; }
    if (!T || T.id !== s.id || !view.querySelector('#term')) {
      closeTerminal();
      drawn.delete(view);
      setHtml(view, `<div class="session">
        <p class="meta" id="s-status"></p>
        <div id="s-size"></div>
        <div id="term"></div>
        <div id="keys">${KEYS.map(([label], i) => `<button type="button" data-key="${i}">${label}</button>`).join('')}</div>
        <form id="say" autocomplete="off"><textarea name="text" rows="1" placeholder="Message Claude" enterkeyhint="send"></textarea><button class="btn primary" type="submit">Send</button></form>
      </div>`);
      $('#keys').addEventListener('click', e => {
        const key = KEYS[e.target.closest('[data-key]')?.dataset.key];
        if (!key || !T) return;
        if (key[0] === 'Esc') link.send('session:interrupt', T.id);
        link.send('session:write', T.id, key[1]);
      });
      const box = $('#say').elements.text;
      box.addEventListener('input', () => { box.rows = Math.min(5, Math.max(1, box.value.split('\n').length)); });
      $('#say').addEventListener('submit', e => {
        e.preventDefault();
        const text = box.value.replace(/\s+$/, '');
        if (!text || !T || link.state !== 'online') return;
        // Several lines go in as one paste, so they stay one message; Enter follows once the
        // terminal has taken them.
        link.send('session:write', T.id, text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
        const id = T.id;
        setTimeout(() => link.send('session:write', id, '\r'), 120);
        box.value = '';
        box.rows = 1;
        T.term.scrollToBottom();
      });
      openTerminal(s.id);
    }
    const [tone, label] = sessionStatus(s);
    setHtml($('#s-status'), `<span class="pill ${tone}">${label}</span> ${esc(shortDir(s.cwd))}`);
    $('#say').classList.toggle('off', !s.live);
    renderSizeNote();
  }

  // --- a new session, started from here ---
  function renderNew(view, fresh) {
    if (!fresh && view.querySelector('#new-form')) return;
    const dirs = [...new Set([...(S.data.recentDirs || []), S.data.config?.defaultCwd].filter(Boolean))];
    setHtml(view, `<form class="detail" id="new-form" autocomplete="off">
      <p class="meta">Starts Claude Code on ${esc(computer())}. It keeps going there whether or not this phone stays connected.</p>
      <label class="field"><span>Folder</span><select name="cwd">${dirs.map(d => `<option value="${esc(d)}">${esc(shortDir(d))}</option>`).join('')}</select></label>
      <label class="field"><span>First message</span><textarea name="text" rows="5" placeholder="What should Claude do?"></textarea></label>
      <div class="actions bottom"><button class="btn primary" type="submit">Start session</button></div>
    </form>`);
    $('#new-form').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target.elements;
      const text = f.text.value.trim();
      const button = e.target.querySelector('[type=submit]');
      button.disabled = true;
      try {
        const id = await ask('session:create', { cwd: f.cwd.value, firstMessage: text || null, title: text ? text.split('\n')[0].slice(0, 60) : null });
        location.replace(`#/session/${id}`);
      } catch (_) { button.disabled = false; }
    });
  }

  // --- notifications: the computer pushes to this phone when something needs you ---
  // They come through the browser's push service, encrypted so that only this phone reads
  // them. The phone subscribes with the computer's public key, so nobody else can push here.
  const canNotify = 'serviceWorker' in navigator && 'PushManager' in self && 'Notification' in self;
  if (canNotify) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // A tapped notification opens the screen it's about.
    navigator.serviceWorker.addEventListener('message', e => { if (typeof e.data?.hash === 'string' && /^#\/[\w/-]*$/.test(e.data.hash)) location.hash = e.data.hash; });
  }
  async function subscription() {
    const reg = await navigator.serviceWorker.ready;
    return { reg, sub: await reg.pushManager.getSubscription() };
  }
  async function refreshNotify() {
    let state = 'unsupported';
    if (canNotify && link.ready?.push) {
      state = Notification.permission === 'denied' ? 'blocked' : 'off';
      if (Notification.permission === 'granted' && (await subscription()).sub) state = 'on';
    }
    if (S.notify !== state) { S.notify = state; render(); }
  }
  // Subscribes (or reuses the subscription) and tells the computer where to push.
  async function subscribe() {
    const key = link.ready?.push;
    if (!key) throw new Error('Update Stroll on the computer to get notifications.');
    let { reg, sub } = await subscription();
    // One made for another computer's key can't be used by this one.
    if (sub && C.b64u(sub.options.applicationServerKey) !== key) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: C.unb64u(key) });
    await link.invoke('push:subscribe', sub.toJSON());
  }
  async function unsubscribe(tellComputer = true) {
    if (!canNotify) return;
    const { sub } = await subscription();
    if (sub) await sub.unsubscribe();
    if (tellComputer && link.state === 'online') await link.invoke('push:subscribe', null).catch(() => {});
  }
  // The computer doesn't notify a phone that has Stroll on screen.
  const tellVisible = () => link.send('ui:visible', document.visibilityState === 'visible');
  document.addEventListener('visibilitychange', tellVisible);
  setInterval(tellVisible, 20000); // and keeps saying so: a phone that goes quiet counts as away

  // --- taps ---
  async function withBusy(id, fn) {
    if (S.busy.has(id)) return;
    S.busy.add(id);
    render();
    try { await fn(); } catch (_) { /* ask() said why */ } finally { S.busy.delete(id); render(); }
  }
  document.addEventListener('click', async e => {
    const open = e.target.closest('[data-open]');
    if (open) { go({ type: open.dataset.open, id: open.dataset.id }); return; }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const r = S.view.type === 'run' ? run(S.view.id) : null;
    if (act === 'back') { if (history.length > 1) history.back(); else go({ type: 'home' }); }
    else if (act === 'retry') link.wake(true);
    else if (act === 'no-app') { try { localStorage.setItem('stroll.noAppPrompt', '1'); } catch (_) { /* asked again next time */ } render(); }
    else if (act === 'fit-here') takeSize();
    else if (act === 'notify-on') {
      try {
        if (await Notification.requestPermission() !== 'granted') { toast('Notifications are blocked for Stroll on this phone', true); return; }
        await subscribe();
        toast('You’ll be notified here');
      } catch (err) { toast(`Couldn’t turn notifications on: ${err.message}`, true); }
      refreshNotify();
    } else if (act === 'notify-off') {
      await unsubscribe().catch(() => {});
      refreshNotify();
    }
    else if (act === 'todo-toggle') {
      const t = S.data.todos.find(x => x.id === el.dataset.id);
      if (t) ask('todo:update', t.id, { status: t.status === 'done' ? 'open' : 'done' }).then(() => toast('Done')).catch(() => {});
    } else if (act === 'forget') {
      if (await confirmSheet({ title: 'Forget this computer?', body: 'This phone stops being able to reach it. To use it again, pair it from Stroll on the computer.', confirm: 'Forget', danger: true })) {
        S.data = null;
        await unsubscribe().catch(() => {});
        await link.forget();
        go({ type: 'home' });
      }
    } else if (r && (act === 'ap-allow' || act === 'ap-deny') && r.pendingApproval) {
      const a = r.pendingApproval;
      withBusy(r.id, async () => { await ask('run:decide', a.id, act === 'ap-allow' ? 'allow' : 'deny', null); toast(act === 'ap-allow' ? 'Allowed once' : 'Denied'); });
    } else if (r && act === 'ap-all') {
      if (await confirmSheet({ title: 'Allow everything?', body: 'This run stops asking: it runs scripts, fetches and other tools on your computer without your OK. Edits, pushes and sending messages stay blocked.', confirm: 'Allow everything' })) {
        withBusy(r.id, async () => { await ask('run:allowAll', r.id, true); toast('Allowing everything this run asks for'); });
      }
    } else if (r && act === 'run-reviewed') {
      withBusy(r.id, async () => { await ask('run:reviewed', r.id); toast('Marked reviewed'); history.back(); });
    } else if (r && act === 'run-cancel') {
      if (await confirmSheet({ title: 'Cancel this run?', body: 'It stops where it is. What it found so far is lost.', confirm: 'Cancel run', danger: true })) {
        withBusy(r.id, async () => { await ask('run:cancel', r.id); toast('Cancelled'); });
      }
    }
  });

  // --- the connection drives everything ---
  link.on('link', async state => {
    if (state === 'online') {
      render();
      try {
        // Everything on screen comes from this; a reply that got lost is asked for again.
        for (let i = 0; ; i += 1) {
          try { S.data = await link.invoke('state:get'); break; } catch (e) { if (i >= 2 || link.state !== 'online') throw e; }
        }
        link.send('ui:focus', focusOf(S.view));
        tellVisible();
        // Already notified here: make sure the computer still knows where to push.
        if (canNotify && Notification.permission === 'granted' && (await subscription()).sub) subscribe().catch(() => {});
        refreshNotify();
      } catch (_) {
        if (link.state === 'online' && !S.data) link.wake(true); // connected but mute: start a new connection
      }
    }
    render();
    // Back after a drop with a session open: what was printed meanwhile is in its scrollback.
    if (state === 'online' && T) { if (T.own) takeSize(); loadBuffer(); }
  });
  link.on('state:changed', snapshot => { if (S.data) { S.data = { ...S.data, ...snapshot }; render(); } });
  link.on('session:data', (id, seq, data) => {
    if (!T || T.id !== id) return;
    if (!T.ready) T.queue.push([seq, data]);
    else if (seq > T.lastSeq) { T.term.write(data); T.lastSeq = seq; }
  });
  link.on('session:size', (id, cols, rows) => {
    if (!T || T.id !== id) return;
    // Our own size coming back means it's ours; any other means the computer took it.
    T.own = cols === T.term.cols && rows === T.term.rows;
    if (!T.own) T.term.resize(cols, rows);
    renderSizeNote();
  });
  link.on('ui:error', message => toast(message, true));
  setInterval(() => { if (S.data && document.visibilityState === 'visible') render(); }, 30000); // "5m ago" keeps moving

  // Opened from a pairing code? It's in the address after #p=. Take it out of the address
  // (and the history) before anything else: it's a one-time key to this phone's access.
  const code = takeCode();
  S.view = parseHash();
  render();
  link.start(code).catch(e => { link.set('refused', `This browser can’t keep the pairing: ${e.message}`); });
}());
