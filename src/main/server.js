const http = require('http');
const crypto = require('crypto');
const { writePrivate } = require('./config');

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
// PreToolUse only for tools that stop and wait on the user, so the dot can turn yellow.
const MATCHERS = { PreToolUse: 'AskUserQuestion|ExitPlanMode', PostToolUse: '*' };
// PostToolUse payloads carry the tool's whole output, which Stroll never reads; only the
// head (tool name and input) is sent.
const BODY_CAP = { PostToolUse: 16 * 1024 };
const DEFAULT_CAP = 256 * 1024;

function hookCommand(event) {
  // Only Stroll-spawned sessions carry STROLL_SESSION; the hook must never block or fail Claude.
  const cap = BODY_CAP[event] || DEFAULT_CAP;
  return `[ -n "$STROLL_SESSION" ] && head -c ${cap} | curl -s -m 2 -X POST -H 'Content-Type: application/json' -H "X-Stroll-Token: $STROLL_TOKEN" --data-binary @- "http://127.0.0.1:$STROLL_PORT/hook/$STROLL_SESSION/${event}" >/dev/null 2>&1; true`;
}

function writeHookSettings(file) {
  const hooks = {};
  for (const ev of HOOK_EVENTS) {
    const entry = { hooks: [{ type: 'command', command: hookCommand(ev), timeout: 5 }] };
    if (MATCHERS[ev]) entry.matcher = MATCHERS[ev];
    hooks[ev] = [entry];
  }
  writePrivate(file, JSON.stringify({ hooks }, null, 2));
}

function writeMcpConfig(file, { serverScript, port, token }) {
  const config = {
    mcpServers: {
      stroll: {
        command: process.execPath,
        args: [serverScript],
        env: { ELECTRON_RUN_AS_NODE: '1', STROLL_PORT: String(port), STROLL_TOKEN: token },
      },
    },
  };
  writePrivate(file, JSON.stringify(config, null, 2));
}

// A capped hook body can be cut mid-JSON; recover what the status logic needs from it.
const unescape = s => { try { return JSON.parse(`"${s}"`); } catch (_) { return s; } };
function parseLoose(raw) {
  try { return raw ? JSON.parse(raw) : {}; } catch (_) { /* truncated */ }
  const pick = key => raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){0,400})`))?.[1];
  const out = {};
  for (const k of ['hook_event_name', 'session_id', 'transcript_path', 'tool_name', 'source', 'message', 'notification_type']) {
    const v = pick(k);
    if (v !== undefined) out[k] = unescape(v);
  }
  const input = {};
  for (const k of ['command', 'file_path', 'pattern', 'path', 'url', 'query', 'description', 'prompt']) {
    const v = pick(k);
    if (v !== undefined) { input[k] = unescape(v); break; }
  }
  out.tool_input = input;
  return out;
}

function readBody(req, max = 5e6) {
  return new Promise(resolve => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', c => { data += c; if (data.length > max) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

const sameToken = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Local-only HTTP endpoint: Claude Code hooks report session status here, and the stroll
// MCP server reads/writes to-dos through here so the app stays the only writer of state.
class Server {
  constructor() {
    this.token = crypto.randomBytes(24).toString('hex');
    this.port = null;
    this.handlers = null;
  }

  start(handlers) {
    this.handlers = handlers;
    this.http = http.createServer((req, res) => this.handle(req, res).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }));
    return new Promise(resolve => {
      this.http.listen(0, '127.0.0.1', () => {
        this.port = this.http.address().port;
        resolve(this.port);
      });
    });
  }

  async handle(req, res) {
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!sameToken(req.headers['x-stroll-token'], this.token)) return json(401, { error: 'bad token' });
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    const h = this.handlers;
    const body = async () => { try { return JSON.parse((await readBody(req)) || '{}'); } catch (_) { return {}; } };

    if (req.method === 'POST' && parts[0] === 'hook' && parts.length === 3) {
      h.onHook(parts[1], parts[2], parseLoose(await readBody(req)));
      return json(200, { ok: true });
    }
    if (parts[0] !== 'api') return json(404, { error: 'not found' });

    if (parts[1] === 'todos' && parts.length === 2) {
      if (req.method === 'GET') return json(200, h.listTodos(url.searchParams.get('status') || 'open'));
      if (req.method === 'POST') {
        const b = await body();
        if (!b.title || !String(b.title).trim()) return json(400, { error: 'title is required' });
        return json(200, h.addTodo(b));
      }
    }
    if (parts[1] === 'todos' && parts.length >= 3) {
      const id = parts[2];
      if (parts[3] === 'handoff' && req.method === 'POST') {
        const result = h.handoffTodo(id, await body());
        return result.error ? json(400, result) : json(200, result);
      }
      if (req.method === 'PATCH') {
        const t = h.updateTodo(id, await body());
        return t ? json(200, t) : json(404, { error: 'no such to-do' });
      }
    }
    if (parts[1] === 'runs' && req.method === 'GET') return json(200, h.listRuns(url.searchParams.get('status')));
    if (parts[1] === 'sessions' && req.method === 'GET') return json(200, h.listSessions());
    return json(404, { error: 'not found' });
  }

  stop() { this.http?.close(); }
}

module.exports = { Server, writeHookSettings, writeMcpConfig, parseLoose };
