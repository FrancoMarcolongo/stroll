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
    voiceDrop();
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
    const dictation = Recognition ? `<p>Dictation in ${esc(voiceLangs().map(langName).join(', '))}. <button class="linkish" data-act="mic-langs">Change</button></p>` : '';
    setHtml($('#foot'), `${notes}${dictation}${offerApp ? '<a class="btn wide link" href="stroll.apk" download>Get the Android app</a>' : ''}<p>Remote access to ${esc(computer())}${link.ready?.version ? `, Stroll ${esc(link.ready.version)}` : ''}. It has to be on and awake.</p>
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
    T.scroll.stop();
    T.term.dispose();
    T = null;
  }

  // --- a finger on the terminal ---
  // It scrolls like a page on a phone: the text follows the finger to the pixel and glides on
  // when it's let go. A terminal only moves by whole rows, so the part of a row left over is
  // made up by shifting the rows on the screen.
  // A terminal with its own scrollback is scrolled right here. Claude Code in full-screen mode
  // keeps the scrollback itself and moves when it's told the mouse wheel turned: the turns go
  // to the computer and the rows are shifted here at once, ahead of the redraw. Each redraw is
  // then compared with the screen before it to see how far the text really moved (the app
  // decides that: fast turns move more than a row each, and at either end nothing moves), and
  // the shift shrinks by that much.
  const SLOP = 6; // px a finger travels before it's scrolling
  const GLIDE_MS = 400; // a flick fades out over about this long
  const LEAD_ROWS = 6; // the rows are shifted at most this far ahead of the computer's redraw
  const FLIGHT_ROWS = 10; // wheel turns sent and not seen back yet, at most
  const STALL_MS = 450; // asked, and nothing moved for this long: there's no more that way
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  function fingerScroll(el, term, id) {
    // Everything counts the same way: positive is towards older output (the text moves down).
    let want = 0; // px: where the finger and the glide have put the text
    let done = 0; // rows the text has moved, as drawn
    let sent = 0; // rows asked of the app, as wheel turns
    let queued = 0; // rows scrolled here and not drawn yet
    let velocity = 0; // px/ms of the glide
    let dir = 0; // which way it was last pushed
    let back = 0; // px the finger has gone the other way since
    let edge = 0; // the way that had no more, last time (the app's history; a terminal here knows its ends)
    let wheel = false; // the app scrolls itself, by the mouse wheel
    let touch = null;
    let frame = 0;
    let last = 0;
    let cell = 14;
    let shifted = false;
    let snap = null; // the rows as last drawn, to tell how far a redraw moved them
    let unsure = 0;
    const fixed = { top: 0, bottom: 0 }; // rows the app keeps in place: its input box, its status line
    const known = { top: false, bottom: false };
    const doubt = { top: null, bottom: null };
    const at = { col: 1, line: 1 }; // where the wheel is reported to be
    let lastSend = 0;
    let lastMove = 0;
    let asked = 0;
    let rtt = 150;

    const rowsNow = () => {
      const b = term.buffer.active;
      const out = [];
      for (let y = 0; y < term.rows; y += 1) out.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
      return out;
    };
    function rest() { want = 0; done = 0; sent = 0; queued = 0; velocity = 0; snap = null; unsure = 0; }

    // The rows are drawn where the finger has them: shifted by what hasn't been scrolled yet.
    // The app's own rows stay put, over the ones sliding under them.
    function paint() {
      const rows = term.element?.querySelector('.xterm-rows');
      if (!rows) return;
      let off = clamp(want - done * cell, -LEAD_ROWS * cell, LEAD_ROWS * cell);
      // Until the app's first redraw has shown which rows it keeps in place, nothing is shifted:
      // its input box would be dragged along.
      if (Math.abs(off) < 0.5 || (wheel && !known.bottom)) off = 0;
      if (!off && !shifted) return;
      shifted = Boolean(off);
      rows.style.transform = off ? `translateY(${off.toFixed(1)}px)` : '';
      const held = off ? `translateY(${(-off).toFixed(1)}px)` : '';
      const n = rows.childElementCount;
      for (let y = 0; y < n; y += 1) {
        const row = rows.children[y];
        const hold = Boolean(off) && wheel && (y < fixed.top || y >= n - fixed.bottom);
        if (row.classList.contains('held') !== hold) row.classList.toggle('held', hold);
        if (row.style.transform !== (hold ? held : '')) row.style.transform = hold ? held : '';
      }
    }

    // How many rows the text moved between two screens, or null when it can't be told (half a
    // redraw, or another screen altogether). Of two answers as good, the one closer to what
    // was asked for.
    function movedBy(before, after, expected) {
      const n = after.length;
      const top = fixed.top;
      const bottom = n - fixed.bottom;
      const span = Math.max(0, Math.min(bottom - top - 3, FLIGHT_ROWS * 2 + 4));
      let best = null;
      for (let d = -span; d <= span; d += 1) {
        let same = 0;
        let could = 0;
        for (let y = Math.max(top, top + d); y < Math.min(bottom, bottom + d); y += 1) {
          const line = before[y - d];
          if (!line.trim()) continue;
          could += 1;
          if (line === after[y]) same += 1;
        }
        if (!best || same > best.same || (same === best.same && Math.abs(d - expected) < Math.abs(best.d - expected))) best = { d, same, could };
      }
      if (!best || best.same < 3 || best.same < 0.55 * best.could) return null;
      // The rows that came along, over the whole screen: what's beyond them is the app's own.
      best.lo = n;
      best.hi = -1;
      for (let y = Math.max(0, best.d); y < Math.min(n, n + best.d); y += 1) {
        if (before[y - best.d].trim() && before[y - best.d] === after[y]) { best.lo = Math.min(best.lo, y); best.hi = y; }
      }
      return best;
    }
    // Fewer rows of the app's own are believed at once, more only when seen three times running:
    // a blank line that moved looks just like one that stayed.
    function learn(side, count) {
      if (!known[side] || count <= fixed[side]) { fixed[side] = count; known[side] = true; doubt[side] = null; return; }
      const d = doubt[side] || { n: 0, least: count };
      doubt[side] = d;
      d.n += 1;
      d.least = Math.min(d.least, count);
      if (d.n >= 3) { fixed[side] = d.least; doubt[side] = null; }
    }

    const rendered = term.onRender(() => {
      if (!wheel) { // rows scrolled here are on screen now: the shift gives way to them
        if (queued) { done += queued; queued = 0; paint(); }
        return;
      }
      if (!snap) return; // nobody is scrolling
      const now = rowsNow();
      const t = performance.now();
      const flight = sent - done;
      const m = snap.length === now.length ? movedBy(snap, now, flight) : { d: 0 };
      if (!m) { // wait for the rest of the redraw before deciding
        if (!unsure) unsure = t;
        if (t - unsure > 250) { snap = now; unsure = 0; }
        return;
      }
      unsure = 0;
      snap = now;
      if (!m.d) return;
      if (flight && Math.sign(m.d) === Math.sign(flight)) {
        done += m.d;
        if ((done - sent) * m.d > 0) sent = done; // it moved further than it was asked to
        rtt = 0.7 * rtt + 0.3 * (t - asked);
        asked = t;
        lastMove = t;
        edge = 0;
        if (m.d > 0) learn('bottom', now.length - 1 - m.hi); else learn('top', m.lo);
        paint();
      } else if (Math.sign(m.d) === -edge) edge = 0; // something else moved it away from that end
    });

    // The app's history: wheel turns for the rows the finger is ahead by, a few at a time.
    function turn(now) {
      let flight = sent - done;
      if (flight && now - Math.max(lastSend, lastMove) > Math.max(STALL_MS, 3 * rtt)) {
        edge = Math.sign(flight); // nothing came of it: that's the end, or the line is very slow
        sent = done;
        velocity = 0;
        flight = 0;
      }
      want = clamp(want, (done - FLIGHT_ROWS) * cell, (done + FLIGHT_ROWS) * cell); // never far from what's on screen
      let need = Math.round(want / cell) - sent;
      if (need && Math.sign(need) !== dir) need = 0; // the app went further than asked: the wheel isn't turned back for it
      if (need && Math.sign(need) === edge && !touch) need = 0; // let go at the end: nothing more to ask for
      need = Math.sign(need) * Math.min(Math.abs(need), Math.max(0, FLIGHT_ROWS - Math.abs(flight)), 8);
      if (!need || now - lastSend < 30 || link.state !== 'online') return Boolean(flight) || (Boolean(need) && link.state === 'online');
      if (!flight) asked = now;
      // Wheel up (64) or down (65) at the cell under the finger, as the terminal would report it.
      link.send('session:write', id, `\x1b[<${need > 0 ? 64 : 65};${at.col};${at.line}M`.repeat(Math.abs(need)));
      sent += need;
      lastSend = now;
      return true;
    }
    // A terminal with its own scrollback: its rows are scrolled as the finger passes them.
    function scrollHere(now) {
      if (queued && now - lastMove > 120) { done += queued; queued = 0; } // not drawn (out of sight): don't wait for it
      const b = term.buffer.active;
      const here = done + queued;
      const least = (here - (b.baseY - b.viewportY)) * cell;
      const most = (here + b.viewportY) * cell;
      if (want < least || want > most) { want = clamp(want, least, most); velocity = 0; } // the top or the bottom of what there is
      const n = Math.round(want / cell) - here;
      if (n) { term.scrollLines(-n); queued += n; lastMove = now; }
      return queued !== 0;
    }

    function tick(now) {
      frame = 0;
      const dt = clamp(now - last, 0, 50);
      last = now;
      if (!touch && velocity) {
        want += velocity * dt;
        velocity *= Math.exp(-dt / GLIDE_MS);
        if (Math.abs(velocity) < 0.02) velocity = 0;
      }
      const busy = wheel ? turn(now) : scrollHere(now);
      let again = Boolean(velocity) || busy;
      if (!touch && !velocity && !busy) { // let go, and nothing on its way: come to rest on whole rows
        const gap = want - done * cell;
        if (Math.abs(gap) < 0.5) rest();
        else { want = done * cell + gap * Math.exp(-dt / 60); again = true; }
      }
      paint();
      if (again) frame = requestAnimationFrame(tick);
    }
    function run() {
      if (frame) return;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }

    el.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) { touch = null; return; }
      const p = e.touches[0];
      const mode = term.modes.mouseTrackingMode !== 'none';
      if (mode !== wheel) { rest(); edge = 0; wheel = mode; }
      const box = (term.element?.querySelector('.xterm-screen') || el).getBoundingClientRect();
      cell = box.height / term.rows || 14;
      at.col = clamp(Math.floor((p.clientX - box.left) / (box.width / term.cols)) + 1, 1, term.cols);
      at.line = clamp(Math.floor((p.clientY - box.top) / cell) + 1, fixed.top + 1, Math.max(fixed.top + 1, term.rows - fixed.bottom));
      velocity = 0; // a touch stops the glide where it is
      if (wheel && !snap) snap = rowsNow();
      touch = { y: p.clientY, moved: false, samples: [[e.timeStamp, p.clientY]] };
    }, { passive: true });
    el.addEventListener('touchmove', e => {
      if (!touch || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      if (!touch.moved) {
        if (Math.abs(y - touch.y) < SLOP) return;
        touch.moved = true; // the scroll starts from here: no jump
        touch.y = y;
        touch.samples = [[e.timeStamp, y]];
        return;
      }
      const dy = y - touch.y;
      touch.y = y;
      touch.samples.push([e.timeStamp, y]);
      while (touch.samples.length > 2 && e.timeStamp - touch.samples[0][0] > 100) touch.samples.shift();
      if (!dy) return;
      // A finger trembles: it has turned round only once it has gone a little way back.
      if (!dir || Math.sign(dy) === dir) { dir = Math.sign(dy); back = 0; } else { back += Math.abs(dy); if (back > 4) { dir = Math.sign(dy); back = 0; } }
      want += dy * (wheel && edge === Math.sign(dy) ? 0.3 : 1); // against an end it gives a little, no more
      run();
    }, { passive: true });
    const lift = e => {
      if (!touch) return;
      const t = touch;
      touch = null;
      if (t.moved && e.type === 'touchend') {
        const [t0, y0] = t.samples[0];
        const [t1, y1] = t.samples[t.samples.length - 1];
        const v = t1 > t0 && e.timeStamp - t1 < 80 ? (y1 - y0) / (t1 - t0) : 0; // a finger that stopped first doesn't flick
        if (Math.abs(v) >= 0.15 && !(wheel && edge === Math.sign(v))) { velocity = clamp(v, -4, 4); dir = Math.sign(v); back = 0; }
      }
      run();
    };
    el.addEventListener('touchend', lift, { passive: true });
    el.addEventListener('touchcancel', lift, { passive: true });

    return {
      stop() { cancelAnimationFrame(frame); rendered.dispose(); },
      // The screen was replaced (reconnected, another size): start over from what's there.
      reset() { rest(); edge = 0; paint(); },
    };
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
    t.scroll.reset();
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
    T.scroll = fingerScroll(el, term, id);
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
        <form id="say" autocomplete="off"><textarea name="text" rows="1" placeholder="Message Claude" enterkeyhint="send"></textarea>${micButton()}<button class="btn primary" type="submit">Send</button></form>
      </div>`);
      $('#keys').addEventListener('click', e => {
        const key = KEYS[e.target.closest('[data-key]')?.dataset.key];
        if (!key || !T) return;
        if (key[0] === 'Esc') link.send('session:interrupt', T.id);
        link.send('session:write', T.id, key[1]);
      });
      const box = $('#say').elements.text;
      // The box grows with what's in it, typed or spoken, up to five lines; the end stays in view.
      const fitBox = () => { box.style.height = 'auto'; box.style.height = `${Math.min(box.scrollHeight + 2, 132)}px`; box.scrollTop = box.scrollHeight; };
      box.addEventListener('input', fitBox);
      $('#say').addEventListener('submit', e => {
        e.preventDefault();
        voiceDrop(); // what was heard so far is in the box
        const text = box.value.replace(/\s+$/, '');
        if (!text || !T || link.state !== 'online') return;
        // Several lines go in as one paste, so they stay one message; Enter follows once the
        // terminal has taken them.
        link.send('session:write', T.id, text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
        const id = T.id;
        setTimeout(() => link.send('session:write', id, '\r'), 120);
        box.value = '';
        fitBox();
        T.term.scrollToBottom();
      });
      openTerminal(s.id);
    }
    const [tone, label] = sessionStatus(s);
    setHtml($('#s-status'), `<span class="pill ${tone}">${label}</span> ${esc(shortDir(s.cwd))}`);
    $('#say').classList.toggle('off', !s.live);
    renderSizeNote();
  }

  // --- dictation: a message can be spoken instead of typed ---
  // The words are recognised by this phone's browser, not by Stroll: in Chrome the audio goes
  // to Google's speech service. Only the text that comes back is put in the box, and it goes
  // to the computer when it's sent, like anything typed. The first time, the phone says so.
  const Recognition = self.SpeechRecognition || self.webkitSpeechRecognition;
  const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-5a3.5 3.5 0 0 0-7 0v5A3.5 3.5 0 0 0 12 15Zm6-3.5a6 6 0 0 1-12 0H4.5a7.5 7.5 0 0 0 6.75 7.46V21.5h1.5v-2.54a7.5 7.5 0 0 0 6.75-7.46H18Z"/></svg>';
  const micButton = () => (Recognition ? `<button type="button" class="mic" data-act="mic" aria-label="Dictate" aria-pressed="false">${MIC}<span class="tag">${esc(langCode(voiceLang()))}</span></button>` : '');
  const stored = (key, value) => {
    try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch (_) { /* no storage: asked again next time */ }
    return null;
  };
  // A recogniser hears one language at a time and can't tell which is being spoken, so the
  // languages are the user's to choose (kept on this phone), and one tap switches between them.
  // What's offered: the ones Chrome's recogniser knows that people are likeliest to want.
  const LANGS = ['en-US', 'en-GB', 'en-AU', 'en-CA', 'en-IN', 'en-IE', 'en-NZ', 'en-ZA', 'es-AR', 'es-BO', 'es-CL', 'es-CO', 'es-CR', 'es-EC', 'es-ES', 'es-MX', 'es-PE', 'es-PY', 'es-US', 'es-UY', 'es-VE',
    'pt-BR', 'pt-PT', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT', 'nl-NL', 'ca-ES', 'eu-ES', 'gl-ES', 'sv-SE', 'nb-NO', 'da-DK', 'fi-FI', 'pl-PL', 'cs-CZ', 'sk-SK', 'hu-HU', 'ro-RO', 'bg-BG', 'hr-HR', 'sr-RS', 'sl-SI',
    'el-GR', 'tr-TR', 'ru-RU', 'uk-UA', 'he-IL', 'ar-SA', 'ar-EG', 'hi-IN', 'bn-IN', 'id-ID', 'ms-MY', 'vi-VN', 'th-TH', 'fil-PH', 'ja-JP', 'ko-KR', 'zh-CN', 'zh-TW', 'zh-HK'];
  const isLang = tag => typeof tag === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag);
  // The languages this phone is set to, one of each, the most exact form of it ("es-AR", "en-US").
  function phoneLangs() {
    const found = new Map();
    for (const tag of (navigator.languages?.length ? navigator.languages : [navigator.language || 'en-US'])) {
      const base = tag.split('-')[0];
      if (!found.has(base) || (!found.get(base).includes('-') && tag.includes('-'))) found.set(base, tag);
    }
    return [...found.values()];
  }
  // The languages to dictate in: the ones chosen here, or the phone's own until some are.
  function voiceLangs() {
    try {
      const chosen = JSON.parse(stored('stroll.dictateLangs') || 'null');
      if (Array.isArray(chosen) && chosen.length && chosen.every(isLang)) return chosen;
    } catch (_) { /* not a list: the phone's */ }
    return phoneLangs();
  }
  // The one it listens in now: the last one used.
  function voiceLang() {
    const langs = voiceLangs();
    return langs.includes(stored('stroll.dictateLang')) ? stored('stroll.dictateLang') : langs[0];
  }
  function langName(tag) {
    try { return new Intl.DisplayNames(['en'], { type: 'language', languageDisplay: 'standard' }).of(tag); } catch (_) { return tag; }
  }
  const langCode = tag => tag.split('-')[0].toUpperCase();
  // The microphones on screen, and the home page's line, say the language as it is now.
  function showLang() {
    for (const tag of document.querySelectorAll('.mic .tag')) tag.textContent = langCode(voiceLang());
    if (S.data && S.view.type === 'home') render();
  }
  function langSheet() {
    return new Promise(resolve => {
      const el = $('#sheet');
      const chosen = voiceLangs();
      const first = [...new Set([...chosen, ...phoneLangs()])]; // the chosen ones and the phone's own lead the list
      const rest = LANGS.filter(t => !first.includes(t)).sort((a, b) => langName(a).localeCompare(langName(b)));
      el.innerHTML = `<div class="sheet-card tall"><h2>Dictation languages</h2>
        <p>Tick the ones you speak. The microphone listens in one at a time; the line above the message box switches between them.</p>
        <div class="field"><input type="search" class="lang-find" placeholder="Search" aria-label="Search languages" autocapitalize="off" autocomplete="off" enterkeyhint="search"></div>
        <div class="lang-list">${[...first, ...rest].map(t => `<label class="switch"><input type="checkbox" value="${esc(t)}" ${chosen.includes(t) ? 'checked' : ''}><span>${esc(langName(t))}</span></label>`).join('')}</div>
        <div class="actions"><button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Done</button></div></div>`;
      el.className = 'show';
      const done = answer => { el.className = ''; el.innerHTML = ''; resolve(answer); };
      el.querySelector('.lang-find').oninput = e => {
        const q = e.target.value.trim().toLowerCase();
        for (const row of el.querySelectorAll('.lang-list label')) row.hidden = Boolean(q) && !row.textContent.toLowerCase().includes(q);
      };
      el.querySelector('[data-yes]').onclick = () => { const picked = [...el.querySelectorAll('.lang-list input:checked')].map(i => i.value); done(picked.length ? picked : null); };
      el.querySelector('[data-no]').onclick = () => done(null);
      el.onclick = e => { if (e.target === el) done(null); };
    });
  }
  const VOICE_ERRORS = {
    'not-allowed': 'The microphone is blocked for Stroll in this phone’s settings.',
    'service-not-allowed': 'This phone doesn’t let its browser dictate.',
    'audio-capture': 'This phone has no microphone to listen with.',
    network: 'Dictation needs this phone to be online.',
  };
  let V = null; // dictation going on: the recogniser, the box it writes in, what was there before and what has been said

  // What has been said, from the recogniser's list of results. Browsers fill that list in two
  // ways. Chrome on a computer gives settled sentences followed by the pieces it's still
  // hearing. Chrome on Android gives every guess at the sentence as a result of its own,
  // marked final with no confidence, each one the whole sentence again: only the last counts.
  function spoken(results) {
    const plain = t => t.toLowerCase().normalize('NFD').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
    const join = (a, b) => (a && b && !/\s$/.test(a) && !/^\s/.test(b) ? `${a} ${b}` : a + b);
    let settled = '';
    let guess = '';
    let hearing = '';
    for (let i = 0; i < results.length; i += 1) {
      const text = results[i][0].transcript;
      if (!results[i].isFinal) hearing += text;
      else if (!results[i][0].confidence) guess = text;
      else { settled = plain(settled) && plain(text).startsWith(plain(settled)) ? text : join(settled, text); guess = ''; }
    }
    return join(join(settled, guess), hearing).trim();
  }
  function voiceNote(v) {
    const langs = voiceLangs();
    const next = langs[(langs.indexOf(v.lang) + 1) % langs.length];
    v.note.innerHTML = `Listening in ${esc(langName(v.lang))}. ${langs.length > 1 && next !== v.lang
      ? `<button type="button" class="linkish" data-act="mic-lang">Switch to ${esc(langName(next))}</button> · <button type="button" class="linkish" data-act="mic-langs">Languages</button>`
      : '<button type="button" class="linkish" data-act="mic-langs">Change language</button>'}`;
  }
  // Puts everything back as it was, at once. The text heard so far stays in the box.
  function voiceDrop(error) {
    const v = V;
    if (!v) return;
    V = null;
    clearTimeout(v.giveUp);
    v.rec.onresult = null; v.rec.onerror = null; v.rec.onend = null;
    try { v.rec.abort(); } catch (_) { /* already over */ }
    v.button.classList.remove('on');
    v.button.setAttribute('aria-pressed', 'false');
    v.box.readOnly = false;
    v.box.placeholder = v.placeholder;
    v.note.remove();
    if (error === 'no-speech') toast('Didn’t hear anything');
    else if (error === 'language-not-supported') toast(`This phone can’t dictate in ${langName(v.lang)}.`, true);
    else if (error && error !== 'aborted') toast(VOICE_ERRORS[error] || 'Dictation stopped working on this phone.', true);
  }
  // Done talking: the recogniser gets a moment to finish the last words.
  function voiceStop() {
    const v = V;
    if (!v) return;
    v.wanted = false;
    v.button.classList.remove('on');
    try { v.rec.stop(); } catch (_) { voiceDrop(); return; }
    v.giveUp = setTimeout(() => { if (V === v) voiceDrop(); }, 1500);
  }
  function voiceListen(button) {
    const form = button.closest('form');
    const box = form.elements.text;
    const lang = voiceLang();
    const rec = new Recognition();
    rec.lang = lang;
    rec.interimResults = true; // the words show as they're said
    rec.continuous = true; // a pause doesn't end it, where the phone allows
    rec.maxAlternatives = 1;
    const note = document.createElement('p');
    note.className = 'voice-note';
    const v = { rec, form, box, button, note, lang, placeholder: box.placeholder, base: box.value.replace(/\s+$/, ''), said: '', error: null, wanted: true, startedAt: Date.now(), starts: 1, giveUp: null };
    V = v;
    rec.onresult = e => {
      if (V !== v) return;
      v.said = spoken(e.results);
      box.value = [v.base, v.said].filter(Boolean).join(' ');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    };
    rec.onerror = e => { v.error = e.error; };
    rec.onend = () => {
      if (V !== v) return;
      // Many phones stop listening at every pause. While the button is on and the last stretch
      // heard something, it listens again; silence, an error or the button end it.
      const heard = Boolean(v.said);
      if (v.wanted && !v.error && heard && Date.now() - v.startedAt > 800 && v.starts < 40) {
        v.base = box.value.replace(/\s+$/, '');
        v.said = '';
        v.startedAt = Date.now();
        v.starts += 1;
        try { rec.start(); return; } catch (_) { /* ends below */ }
      }
      // Silence after something was said just ends it; silence from the start is worth a word.
      const silent = v.error === 'no-speech' || (!v.error && !heard);
      voiceDrop(silent ? (v.wanted && v.starts === 1 ? 'no-speech' : null) : v.error);
    };
    button.classList.add('on');
    button.setAttribute('aria-pressed', 'true');
    box.readOnly = true; // the box is being written by voice: no keyboard over it meanwhile
    box.placeholder = 'Listening…';
    const anchor = button.parentElement === form ? form.firstChild : button.parentElement;
    anchor.parentElement.insertBefore(note, anchor);
    voiceNote(v);
    try { rec.start(); } catch (_) { voiceDrop('start'); }
  }
  async function voiceToggle(button) {
    if (V) {
      const same = V.button === button;
      if (same && V.wanted) { voiceStop(); return; }
      voiceDrop();
      if (same) return;
    }
    if (stored('stroll.dictateOk') !== '1') {
      const yes = await confirmSheet({ title: 'Dictate with this phone’s microphone?',
        body: `This phone’s browser turns what you say into text. In Chrome that means the audio goes to Google’s speech service; Stroll doesn’t record or keep it. The text is put in the box, and nothing goes to Claude until you send it. It listens in ${langName(voiceLang())}; the line above the box changes that.`,
        confirm: 'Dictate' });
      if (!yes) return;
      stored('stroll.dictateOk', '1');
    }
    if (button.isConnected) voiceListen(button);
  }
  function voiceNextLang() {
    const v = V;
    if (!v) return;
    const langs = voiceLangs();
    stored('stroll.dictateLang', langs[(langs.indexOf(v.lang) + 1) % langs.length]);
    voiceDrop();
    showLang();
    voiceListen(v.button);
  }
  // Choosing the languages, from the line above the box or from the home page. A microphone
  // that was listening goes on listening after, in the language just added if there is one.
  async function voiceChooseLangs() {
    const button = V?.button;
    voiceDrop();
    const before = voiceLangs();
    const picked = await langSheet();
    if (picked) {
      stored('stroll.dictateLangs', JSON.stringify(picked));
      const added = picked.filter(t => !before.includes(t));
      if (added.length === 1) stored('stroll.dictateLang', added[0]);
      showLang();
    }
    if (button?.isConnected) voiceListen(button);
  }
  // Leaving the screen, or the app, ends it.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') voiceDrop(); });

  // --- a new session, started from here ---
  function renderNew(view, fresh) {
    if (!fresh && view.querySelector('#new-form')) return;
    const dirs = [...new Set([...(S.data.recentDirs || []), S.data.config?.defaultCwd].filter(Boolean))];
    setHtml(view, `<form class="detail" id="new-form" autocomplete="off">
      <p class="meta">Starts Claude Code on ${esc(computer())}. It keeps going there whether or not this phone stays connected.</p>
      <label class="field"><span>Folder</span><select name="cwd">${dirs.map(d => `<option value="${esc(d)}">${esc(shortDir(d))}</option>`).join('')}</select></label>
      <label class="field"><span>First message</span><textarea name="text" rows="5" placeholder="What should Claude do?"></textarea></label>
      <div class="actions bottom">${micButton()}<button class="btn primary" type="submit">Start session</button></div>
    </form>`);
    $('#new-form').addEventListener('submit', async e => {
      e.preventDefault();
      voiceDrop();
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
    else if (act === 'mic') voiceToggle(el);
    else if (act === 'mic-lang') voiceNextLang();
    else if (act === 'mic-langs') voiceChooseLangs();
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
