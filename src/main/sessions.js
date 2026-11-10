const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const { EventEmitter } = require('events');
const { childEnv } = require('./config');
const { summarizeInput } = require('./runs');
const { transcriptFor } = require('./recent');
const { BackgroundTracker, endedIds } = require('./background');

const BUFFER_LIMIT = 2 * 1024 * 1024; // chars of scrollback kept for replay when a view (re)attaches
const TRANSCRIPT_TAIL = 512 * 1024;
const QUICK_EXIT_MS = 6000;
const SILENT_WORKING_MS = 12000; // Claude's TUI animates while it works; this long without output means it isn't
const INTERRUPT_SETTLE_MS = 2500;
const TRUST_WINDOW_MS = 30000;
const TRUST_QUIET_MS = 700;

const oneLine = s => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, 200) : '');
const stripAnsi = s => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '');

// The TUI draws spaces as cursor moves, so text is compared with whitespace removed. "No, exit"
// is selected first and one arrow down is "Yes, I trust this folder". The dialog can redraw
// (resetting the choice) right after it appears, so each key waits for the screen to go quiet,
// and Enter only goes out while "Yes" is the one selected; otherwise it gives up and the user
// answers as usual.
function watchTrustPrompt(entry, data) {
  const tr = entry.trust;
  const send = keys => { try { entry.proc.write(keys); } catch (_) { entry.trust = null; } };
  clearTimeout(tr.timer);
  tr.text = (tr.text + stripAnsi(data).replace(/\s+/g, '')).slice(-4000);
  if (Date.now() - entry.startedAt > TRUST_WINDOW_MS || tr.tries > 3) { entry.trust = null; return; }
  const yes = tr.text.lastIndexOf('❯Yes,Itrustthisfolder');
  const no = tr.text.lastIndexOf('❯No,exit');
  if (tr.moved && yes > no) {
    tr.timer = setTimeout(() => { entry.trust = null; send('\r'); }, TRUST_QUIET_MS);
  } else if (no >= 0 && tr.text.includes('Accessingworkspace') && tr.text.indexOf('Yes,Itrustthisfolder', no) > no) {
    tr.timer = setTimeout(() => { tr.moved = true; tr.tries += 1; tr.text = ''; send('\x1b[B'); }, TRUST_QUIET_MS);
  }
}

// One line for the sidebar: the closing question if the reply ends with one, otherwise its
// first non-heading line (replies tend to lead with the answer).
function previewFromText(text) {
  const lines = String(text || '').split('\n')
    .map(raw => ({
      heading: /^\s*#/.test(raw),
      text: raw.replace(/^(\s*([>#*|-]|\d+[.)])\s*)+/, '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim(),
    }))
    .filter(l => l.text && !/^[-|:\s]+$/.test(l.text));
  if (!lines.length) return null;
  const last = lines[lines.length - 1].text;
  if (/\?$/.test(last)) return last.slice(0, 160);
  return (lines.find(l => !l.heading) || lines[0]).text.slice(0, 160);
}

// Text of the last assistant message in a transcript, reading only its tail.
function lastAssistantText(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const len = Math.min(size, TRANSCRIPT_TAIL);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].includes('"assistant"')) continue;
      let d;
      try { d = JSON.parse(lines[i]); } catch (_) { continue; }
      if (d.type !== 'assistant' || d.isSidechain) continue;
      const text = (d.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
      if (text) return text;
    }
  } catch (_) { /* unreadable transcript: no preview */ }
  return null;
}

const words = s => (String(s || '').match(/\S+/g) || []).length;
const THIN_NOTES_WORDS = 15;

// What a session on a trail is told: the trail's notes, and how to keep them useful for the
// next session (suggest, the user accepts; write directly only when the user asks).
function trailContext(trail) {
  const notes = String(trail.notes || '').trim();
  const lines = [
    `This session is on the trail "${trail.title}": a line of sessions about the same piece of work that share the trail's notes. The notes as of when this session started (\`trail_get\` returns the latest, plus the trail's to-dos, sessions and background runs):`,
    notes ? notes.split('\n').map(l => `  ${l}`).join('\n') : '  (empty)',
  ];
  if (words(notes) < THIN_NOTES_WORDS) {
    lines.push('The notes are still thin. Early on, ask the user for what a future session would need to know (the goal, the repos and folders involved, the ticket or epic, constraints) and suggest it with `trail_suggest`.');
  }
  lines.push(
    'Keep the notes useful for the next session: when you learn something it would otherwise have to rediscover (a decision and why, where something lives, a gotcha, who owns what), suggest it with `trail_suggest`, one or two lines each, a few per session at most, usually when a piece of work is done. Say in one line what you suggested; the user accepts or dismisses it in Stroll. No progress updates, and nothing the code, git history or tickets already say. Facts about this trail go in the trail rather than in your own memory files.',
    'When the user explicitly asks you to add something to the trail\'s notes, use `trail_note_add`, which writes it right away.',
  );
  return lines.join('\n');
}

function todoContext(todos) {
  const lines = todos.map(t => `- ${t.title}${t.notes ? `\n  Notes: ${t.notes.replace(/\n/g, '\n  ')}` : ''}`);
  return [
    "It was started for these to-dos from the user's list:",
    ...lines,
    "The `stroll` MCP tools read and update the user's to-do list. When the work is finished, ask the user whether to mark the to-do done; do not mark it done on your own.",
  ].join('\n');
}

// Appended to the system prompt when the session starts (and again on every resume, so a
// resumed session gets the notes as they are now).
function sessionContext(trail, todos) {
  if (!trail && !todos.length) return null;
  return [
    "This session was started from Stroll, the user's session manager.",
    trail ? trailContext(trail) : null,
    todos.length ? todoContext(todos) : null,
  ].filter(Boolean).join('\n\n');
}

// Private terminal modes (bracketed paste, focus reporting, cursor…) set by the TUI. The
// replay buffer only keeps the tail of a long session, so these are re-applied on replay.
const MODE_RE = /\x1b\[\?([\d;]+)([hl])/g;
const NO_REPLAY_MODES = new Set(['47', '1047', '1049']); // alternate screen would hide the replay

// Live Claude Code sessions, each a real `claude` process in a PTY. Status comes from Claude
// Code hooks (see hook-settings.json) that report back to Stroll's local server.
class Sessions extends EventEmitter {
  constructor({ store, config, paths, server }) {
    super();
    this.store = store;
    this.config = config;
    this.paths = paths;
    this.server = server;
    this.live = new Map(); // id -> { proc, chunks, size, seq, modes, startedAt, lastDataAt, lastHookAt, gotHook }
    this.watchdog = setInterval(() => this.settleSilentSessions(), 4000);
  }

  isLive(id) { return this.live.has(id); }

  // trailId: undefined keeps the session's trail (or takes its to-dos'); null means none.
  create({ cwd, title, todoIds = [], trailId, resumeId = null, firstMessage = null, workflowId = null, cols = 120, rows = 34 }) {
    if (!this.config.claudePath) {
      throw new Error('Claude Code (`claude`) was not found on your PATH. Install it from https://claude.com/claude-code, then restart Stroll.');
    }
    const id = resumeId || crypto.randomUUID();
    if (this.live.has(id)) return id;
    const existing = this.store.session(id);
    const allTodoIds = Array.from(new Set([...(existing?.todoIds || []), ...todoIds]));
    const todos = allTodoIds.map(t => this.store.todo(t)).filter(Boolean);
    // A session keeps its trail; a new one (or one from before trails) takes its to-dos' trail,
    // and a background run continued as a session keeps the run's.
    const wantedTrail = trailId !== undefined ? trailId
      : existing && existing.trailId !== undefined ? existing.trailId
        : (this.store.run(id)?.trailId || todos.map(t => t.trailId).find(Boolean));
    const trail = this.store.trail(wantedTrail) || null;
    const dir = cwd && fs.existsSync(cwd) ? cwd
      : existing?.cwd && fs.existsSync(existing.cwd) ? existing.cwd
        : trail?.cwd && fs.existsSync(trail.cwd) ? trail.cwd : this.config.defaultCwd;

    // After /clear (or /resume inside the TUI) Claude continues under a new session id; resume
    // that one. A session that never got a message has no transcript and starts fresh instead.
    const resumable = resumeId ? [existing?.claudeSessionId, id].filter(Boolean).find(c => transcriptFor(c)) : null;

    // --mcp-config is variadic, so it goes first; `--` keeps a first message that starts with
    // "-" from being parsed as an option.
    const args = ['--mcp-config', this.paths.mcpConfig, '--settings', this.paths.hookSettings];
    args.push(...(resumable ? ['--resume', resumable] : ['--session-id', id]));
    if (!resumable && (title || existing?.title)) args.push('--name', title || existing.title);
    const context = sessionContext(trail, todos);
    if (context) args.push('--append-system-prompt', context);
    if (firstMessage && firstMessage.trim()) args.push('--', firstMessage.trim());

    let proc;
    try {
      proc = pty.spawn(this.config.claudePath, args, {
        name: 'xterm-256color',
        cols, rows, cwd: dir,
        env: childEnv(this.config, {
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          // xterm.js renders OSC 8 hyperlinks, but Claude can't detect that from TERM alone.
          FORCE_HYPERLINK: '1',
          STROLL_SESSION: id,
          STROLL_PORT: String(this.server.port),
          STROLL_TOKEN: this.server.token,
        }),
      });
    } catch (e) {
      throw new Error(`Couldn't start Claude Code: ${e.message}`);
    }
    const now = Date.now();
    const entry = { proc, chunks: [], size: 0, seq: 0, modes: new Map(), startedAt: now, lastDataAt: now, lastHookAt: 0, gotHook: false, bg: new BackgroundTracker() };
    // Claude Code never remembers trust for the home folder ("home trust is session-only"), so
    // every session there, resumed ones too, opens on its "Accessing workspace" prompt. Answer
    // it: in HOME, the folder's project settings are the user's own settings.
    if (path.resolve(dir) === os.homedir()) entry.trust = { text: '', moved: false, tries: 0, timer: null };
    this.live.set(id, entry);

    this.store.upsertSession({
      id,
      claudeSessionId: resumable || id,
      title: title || existing?.title || (todos[0]?.title) || null,
      cwd: dir,
      live: true,
      status: 'starting',
      statusDetail: null,
      background: [],
      unseen: false,
      restorable: false,
      lastActivityAt: new Date().toISOString(),
      todoIds: allTodoIds,
      trailId: trail?.id || null,
      firstMessage: existing?.firstMessage || (firstMessage && firstMessage.trim()) || null,
      workflowId: workflowId || existing?.workflowId || null,
    });
    for (const t of allTodoIds) this.store.linkSession(id, t, false);
    this.store.rememberDir(dir);

    proc.onData(data => {
      entry.seq += 1;
      entry.lastDataAt = Date.now();
      entry.chunks.push(data);
      entry.size += data.length;
      while (entry.size > BUFFER_LIMIT && entry.chunks.length > 1) entry.size -= entry.chunks.shift().length;
      for (const m of data.matchAll(MODE_RE)) for (const n of m[1].split(';')) entry.modes.set(n, m[2]);
      if (entry.trust) watchTrustPrompt(entry, data);
      this.emit('data', id, entry.seq, data);
    });
    proc.onExit(({ exitCode }) => {
      this.live.delete(id);
      if (entry.trust) clearTimeout(entry.trust.timer);
      let detail = null;
      // Died before Claude Code even started (bad flags, auth, missing node…): say why.
      if (!entry.gotHook && Date.now() - entry.startedAt < QUICK_EXIT_MS) {
        const tail = stripAnsi(entry.chunks.join('')).split('\n').map(l => l.trim()).filter(Boolean).slice(-3).join(' · ');
        detail = `Claude Code exited right away (code ${exitCode})${tail ? `: ${tail.slice(0, 300)}` : ''}`;
        this.emit('failed', id, detail);
      } else if (exitCode) {
        detail = `exited with code ${exitCode}`;
      }
      this.store.patchSession(id, { live: false, status: 'closed', statusDetail: detail, background: [] });
      this.emit('exit', id, exitCode);
    });
    return id;
  }

  buffer(id) {
    const e = this.live.get(id);
    if (!e) return { data: '', seq: 0, modes: '' };
    const modes = [...e.modes].filter(([n]) => !NO_REPLAY_MODES.has(n)).map(([n, v]) => `\x1b[?${n}${v}`).join('');
    return { data: e.chunks.join(''), seq: e.seq, modes };
  }

  write(id, data) { this.live.get(id)?.proc.write(data); }

  resize(id, cols, rows) {
    const e = this.live.get(id);
    if (e && cols > 0 && rows > 0) { try { e.proc.resize(cols, rows); } catch (_) { /* process gone */ } }
  }

  kill(id) { this.live.get(id)?.proc.kill(); }

  killAll() { for (const e of this.live.values()) { try { e.proc.kill(); } catch (_) { /* ignore */ } } }

  stop() { clearInterval(this.watchdog); }

  // Working, or running something in the background: quitting would stop it.
  busyCount() {
    return [...this.live.keys()].filter(id => {
      const s = this.store.session(id);
      return s?.status === 'working' || s?.background?.length;
    }).length;
  }

  // Re-reads the transcript's new lines for background work started or finished.
  syncBackground(id) {
    const e = this.live.get(id);
    if (e && e.bg.scan()) this.store.patchSession(id, { background: e.bg.list() });
  }

  // Claude Code sends no hook when a turn is interrupted (Esc), so the user pressing Esc is a
  // hint: if no hook follows shortly, the turn ended and it's the user's turn again.
  interruptHint(id) {
    const e = this.live.get(id);
    const s = this.store.session(id);
    if (!e || !s || !['working', 'waiting'].includes(s.status)) return;
    const hintAt = Date.now();
    setTimeout(() => {
      const cur = this.store.session(id);
      if (this.live.get(id) === e && e.lastHookAt < hintAt && ['working', 'waiting'].includes(cur?.status)) {
        this.store.patchSession(id, { status: 'idle', unseen: false });
      }
    }, INTERRUPT_SETTLE_MS);
  }

  // Runs every few seconds: picks up background work that started or ended (no hook says so),
  // and is the safety net for interrupts the hint misses: "working" with no output and no hooks
  // for a while means the turn is over.
  settleSilentSessions() {
    const t = Date.now();
    for (const [id, e] of this.live) {
      this.syncBackground(id);
      if (this.store.session(id)?.status !== 'working') continue;
      if (t - e.lastDataAt > SILENT_WORKING_MS && t - e.lastHookAt > SILENT_WORKING_MS) {
        this.store.patchSession(id, { status: 'idle', unseen: false });
      }
    }
  }

  // Claude Code hook event → session status and one-line preview.
  // `unseen` marks a finished turn the user hasn't looked at yet; main.js clears it on view.
  handleHook(id, event, payload = {}) {
    const s = this.store.session(id);
    if (!s) return;
    const e = this.live.get(id);
    if (e) { e.lastHookAt = Date.now(); e.gotHook = true; }
    const at = new Date().toISOString();
    switch (event) {
      case 'SessionStart': {
        const transcriptPath = payload.transcript_path || s.transcriptPath;
        const patch = { transcriptPath, lastActivityAt: at };
        if (payload.session_id) patch.claudeSessionId = payload.session_id;
        if (e && e.bg.follow(transcriptPath)) patch.background = [];
        // A compaction happens mid-turn: Claude is still working.
        if (payload.source !== 'compact') patch.status = 'idle';
        if (payload.source === 'resume') patch.preview = previewFromText(lastAssistantText(transcriptPath)) || s.preview || null;
        if (payload.source === 'clear') patch.preview = null;
        this.store.patchSession(id, patch);
        break;
      }
      case 'UserPromptSubmit': {
        // A background task that ended (or a monitor event) starts a turn as a "prompt" too.
        const raw = String(payload.prompt || '');
        if (raw.trimStart().startsWith('<task-notification>')) {
          // The hook can run before the transcript has the notification: end it from here too.
          if (e) { for (const t of endedIds(raw)) e.bg.end(t); this.store.patchSession(id, { background: e.bg.list() }); }
          this.syncBackground(id);
          const summary = oneLine(raw.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]).replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
          this.store.patchSession(id, { status: 'working', unseen: false, lastActivityAt: at, preview: `↻ ${summary || 'Background task finished'}` });
          break;
        }
        const prompt = oneLine(raw);
        const patch = { status: 'working', unseen: false, lastActivityAt: at, preview: prompt ? `› ${prompt}` : s.preview };
        if (!s.title && prompt) patch.title = prompt.slice(0, 80);
        this.store.patchSession(id, patch);
        break;
      }
      case 'PreToolUse': {
        // Only registered for tools that stop and wait on the user (see server.js).
        const question = payload.tool_name === 'ExitPlanMode'
          ? 'Plan ready for your approval'
          : oneLine(payload.tool_input?.questions?.[0]?.question) || 'Claude has a question for you';
        this.store.patchSession(id, { status: 'waiting', preview: question, lastActivityAt: at });
        this.emit('attention', id, question, 'needsYou');
        break;
      }
      case 'PostToolUse': {
        const step = `${payload.tool_name || 'Tool'} ${summarizeInput(payload.tool_input)}`.trim();
        this.store.patchSession(id, { status: 'working', preview: step.slice(0, 160), lastActivityAt: at });
        break;
      }
      case 'Notification': {
        // idle_prompt is Claude's "still waiting for your input" nudge after a finished turn,
        // and auth_success is informational: neither is a new request.
        if (payload.notification_type === 'idle_prompt' || payload.notification_type === 'auth_success') break;
        const message = oneLine(payload.message) || 'Needs your input';
        this.store.patchSession(id, { status: 'waiting', preview: message, lastActivityAt: at });
        this.emit('attention', id, message, 'needsYou');
        break;
      }
      case 'Stop': {
        this.syncBackground(id);
        const text = payload.last_assistant_message || lastAssistantText(payload.transcript_path || s.transcriptPath);
        const preview = previewFromText(text);
        this.store.patchSession(id, { status: 'idle', unseen: true, preview: preview || s.preview, lastActivityAt: at });
        this.emit('attention', id, preview || 'Finished — your turn', 'finishedTurns');
        break;
      }
      case 'SessionEnd':
        this.store.patchSession(id, { status: 'closed', lastActivityAt: at });
        break;
      default:
        break;
    }
  }
}

module.exports = { Sessions, previewFromText, sessionContext };
