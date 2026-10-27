const crypto = require('crypto');
const fs = require('fs');
const pty = require('node-pty');
const { EventEmitter } = require('events');
const { childEnv } = require('./config');
const { summarizeInput } = require('./runs');
const { transcriptFor } = require('./recent');

const BUFFER_LIMIT = 2 * 1024 * 1024; // chars of scrollback kept for replay when a view (re)attaches
const TRANSCRIPT_TAIL = 512 * 1024;
const QUICK_EXIT_MS = 6000;
const SILENT_WORKING_MS = 12000; // Claude's TUI animates while it works; this long without output means it isn't
const INTERRUPT_SETTLE_MS = 2500;

const oneLine = s => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, 200) : '');
const stripAnsi = s => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '');

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

function todoContext(todos) {
  if (!todos.length) return null;
  const lines = todos.map(t => `- ${t.title}${t.notes ? `\n  Notes: ${t.notes.replace(/\n/g, '\n  ')}` : ''}`);
  return [
    "This session was started from Stroll, the user's session manager, for these to-dos from their list:",
    ...lines,
    "The `stroll` MCP tools read and update the user's to-do list. When the work is finished, ask the user whether to mark the to-do done; do not mark it done on your own.",
  ].join('\n');
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

  create({ cwd, title, todoIds = [], resumeId = null, firstMessage = null, cols = 120, rows = 34 }) {
    if (!this.config.claudePath) {
      throw new Error('Claude Code (`claude`) was not found on your PATH. Install it from https://claude.com/claude-code, then restart Stroll.');
    }
    const id = resumeId || crypto.randomUUID();
    if (this.live.has(id)) return id;
    const existing = this.store.session(id);
    const dir = cwd && fs.existsSync(cwd) ? cwd : (existing?.cwd && fs.existsSync(existing.cwd) ? existing.cwd : this.config.defaultCwd);
    const allTodoIds = Array.from(new Set([...(existing?.todoIds || []), ...todoIds]));
    const todos = allTodoIds.map(t => this.store.todo(t)).filter(Boolean);

    // After /clear (or /resume inside the TUI) Claude continues under a new session id; resume
    // that one. A session that never got a message has no transcript and starts fresh instead.
    const resumable = resumeId ? [existing?.claudeSessionId, id].filter(Boolean).find(c => transcriptFor(c)) : null;

    // --mcp-config is variadic, so it goes first; `--` keeps a first message that starts with
    // "-" from being parsed as an option.
    const args = ['--mcp-config', this.paths.mcpConfig, '--settings', this.paths.hookSettings];
    args.push(...(resumable ? ['--resume', resumable] : ['--session-id', id]));
    if (!resumable && (title || existing?.title)) args.push('--name', title || existing.title);
    const context = todoContext(todos);
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
          STROLL_SESSION: id,
          STROLL_PORT: String(this.server.port),
          STROLL_TOKEN: this.server.token,
        }),
      });
    } catch (e) {
      throw new Error(`Couldn't start Claude Code: ${e.message}`);
    }
    const now = Date.now();
    const entry = { proc, chunks: [], size: 0, seq: 0, modes: new Map(), startedAt: now, lastDataAt: now, lastHookAt: 0, gotHook: false };
    this.live.set(id, entry);

    this.store.upsertSession({
      id,
      claudeSessionId: resumable || id,
      title: title || existing?.title || (todos[0]?.title) || null,
      cwd: dir,
      live: true,
      status: 'starting',
      statusDetail: null,
      unseen: false,
      restorable: false,
      lastActivityAt: new Date().toISOString(),
      todoIds: allTodoIds,
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
      this.emit('data', id, entry.seq, data);
    });
    proc.onExit(({ exitCode }) => {
      this.live.delete(id);
      let detail = null;
      // Died before Claude Code even started (bad flags, auth, missing node…): say why.
      if (!entry.gotHook && Date.now() - entry.startedAt < QUICK_EXIT_MS) {
        const tail = stripAnsi(entry.chunks.join('')).split('\n').map(l => l.trim()).filter(Boolean).slice(-3).join(' · ');
        detail = `Claude Code exited right away (code ${exitCode})${tail ? `: ${tail.slice(0, 300)}` : ''}`;
        this.emit('failed', id, detail);
      } else if (exitCode) {
        detail = `exited with code ${exitCode}`;
      }
      this.store.patchSession(id, { live: false, status: 'closed', statusDetail: detail });
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

  busyCount() {
    return [...this.live.keys()].filter(id => this.store.session(id)?.status === 'working').length;
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

  // Safety net for interrupts the hint misses: "working" with no output and no hooks for a
  // while means the turn is over.
  settleSilentSessions() {
    const t = Date.now();
    for (const [id, e] of this.live) {
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
        // A compaction happens mid-turn: Claude is still working.
        if (payload.source !== 'compact') patch.status = 'idle';
        if (payload.source === 'resume') patch.preview = previewFromText(lastAssistantText(transcriptPath)) || s.preview || null;
        if (payload.source === 'clear') patch.preview = null;
        this.store.patchSession(id, patch);
        break;
      }
      case 'UserPromptSubmit': {
        const prompt = oneLine(payload.prompt);
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

module.exports = { Sessions, previewFromText };
