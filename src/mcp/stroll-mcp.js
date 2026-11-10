// stdio MCP server for Stroll, a thin client of the app's local API (the app owns the data).
// Sessions get the to-do tools; background runs get only the permission prompt tool.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const PORT = process.env.STROLL_PORT;
const TOKEN = process.env.STROLL_TOKEN;
const SESSION = process.env.STROLL_SESSION || null;
const MODE = process.env.STROLL_MCP_MODE || 'sessions';

async function api(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Stroll-Token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Stroll API ${res.status}`);
  return data;
}

const text = obj => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = err => ({ isError: true, content: [{ type: 'text', text: `Stroll is not reachable or refused the call: ${err.message}` }] });

const server = new McpServer({ name: 'stroll', version: '0.8.0' });

function registerSessionTools() {
  server.registerTool('todo_list', {
    description: "List the user's to-dos from Stroll. status: 'open' (default), 'done' or 'all'. Each to-do shows linked sessions and background runs.",
    inputSchema: { status: z.enum(['open', 'done', 'all']).optional() },
  }, async ({ status }) => {
    try { return text(await api('GET', `/api/todos?status=${status || 'open'}`)); } catch (e) { return fail(e); }
  });

  server.registerTool('todo_add', {
    description: "Add a to-do to the user's list in Stroll. Only add what the user asked for. It is linked to the current session, and lands in the session's trail unless trail_id says otherwise (null for none). remind_at is an ISO 8601 date-time.",
    inputSchema: {
      title: z.string().min(1),
      notes: z.string().optional(),
      remind_at: z.string().optional(),
      cwd: z.string().optional().describe('Working directory for sessions started from this to-do'),
      trail_id: z.string().nullable().optional().describe("Trail to put it in; defaults to this session's trail"),
    },
  }, async ({ title, notes, remind_at, cwd, trail_id }) => {
    try {
      const body = { title, notes: notes || '', remindAt: remind_at || null, cwd: cwd || null, sessionId: SESSION };
      if (trail_id !== undefined) body.trailId = trail_id;
      return text(await api('POST', '/api/todos', body));
    } catch (e) { return fail(e); }
  });

  server.registerTool('todo_update', {
    description: 'Update a to-do (title, notes, reminder, working directory, trail). Use todo_complete to mark it done.',
    inputSchema: {
      id: z.string(),
      title: z.string().optional(),
      notes: z.string().optional(),
      remind_at: z.string().nullable().optional(),
      cwd: z.string().nullable().optional(),
      trail_id: z.string().nullable().optional().describe('Move it to this trail (null: no trail)'),
    },
  }, async ({ id, title, notes, remind_at, cwd, trail_id }) => {
    const patch = {};
    if (title !== undefined) patch.title = title;
    if (notes !== undefined) patch.notes = notes;
    if (remind_at !== undefined) patch.remindAt = remind_at;
    if (cwd !== undefined) patch.cwd = cwd;
    if (trail_id !== undefined) patch.trailId = trail_id;
    try { return text(await api('PATCH', `/api/todos/${id}`, patch)); } catch (e) { return fail(e); }
  });

  server.registerTool('todo_complete', {
    description: 'Mark a to-do done (or reopen it with done=false). Only after the user confirms the work is finished.',
    inputSchema: { id: z.string(), done: z.boolean().optional() },
  }, async ({ id, done }) => {
    try { return text(await api('PATCH', `/api/todos/${id}`, { status: done === false ? 'open' : 'done' })); } catch (e) { return fail(e); }
  });

  server.registerTool('todo_handoff', {
    description: 'Hand a to-do off to a read-only background Claude run in Stroll. It investigates and drafts, never changes anything, and reports back for the user to review. Use when the user asks to hand something off.',
    inputSchema: {
      id: z.string(),
      instructions: z.string().optional().describe('Extra instructions for the background run'),
      cwd: z.string().optional(),
    },
  }, async ({ id, instructions, cwd }) => {
    try { return text(await api('POST', `/api/todos/${id}/handoff`, { instructions: instructions || '', cwd: cwd || null })); } catch (e) { return fail(e); }
  });

  server.registerTool('runs_list', {
    description: "List Stroll's background runs: running, ready (finished, waiting for the user's review), failed or reviewed.",
    inputSchema: { status: z.string().optional() },
  }, async ({ status }) => {
    try { return text(await api('GET', `/api/runs${status ? `?status=${encodeURIComponent(status)}` : ''}`)); } catch (e) { return fail(e); }
  });

  server.registerTool('trail_list', {
    description: "List the user's active trails in Stroll. A trail is a line of sessions about the same piece of work that share the trail's notes.",
    inputSchema: {},
  }, async () => {
    try { return text(await api('GET', '/api/trails')); } catch (e) { return fail(e); }
  });

  server.registerTool('trail_get', {
    description: "Get a trail's current notes and its to-dos, sessions and background runs (with their results). Defaults to this session's trail.",
    inputSchema: { trail_id: z.string().optional() },
  }, async ({ trail_id }) => {
    const path = trail_id ? `/api/trails/${encodeURIComponent(trail_id)}` : `/api/trails/current?session=${encodeURIComponent(SESSION || '')}`;
    try { return text(await api('GET', path)); } catch (e) { return fail(e); }
  });

  server.registerTool('trail_suggest', {
    description: "Suggest an addition to the trail's notes, the context every future session on the trail starts with. For durable facts a later session would otherwise rediscover: a decision and why, where something lives, a gotcha, who owns what. One or two lines; not progress updates. It waits for the user to accept, edit or dismiss it in Stroll. Defaults to this session's trail.",
    inputSchema: { text: z.string().min(1), trail_id: z.string().optional() },
  }, async ({ text: note, trail_id }) => {
    try { return text(await api('POST', '/api/trails/suggest', { text: note, trailId: trail_id || null, sessionId: SESSION })); } catch (e) { return fail(e); }
  });

  server.registerTool('trail_note_add', {
    description: "Add a line to the trail's notes right away. Only when the user explicitly asked to add something to the trail's notes; otherwise use trail_suggest. Defaults to this session's trail.",
    inputSchema: { text: z.string().min(1), trail_id: z.string().optional() },
  }, async ({ text: note, trail_id }) => {
    try { return text(await api('POST', '/api/trails/note', { text: note, trailId: trail_id || null, sessionId: SESSION })); } catch (e) { return fail(e); }
  });

  server.registerTool('sessions_list', {
    description: 'List Claude sessions managed by Stroll and their status (working, waiting for the user, idle, closed).',
    inputSchema: {},
  }, async () => {
    try { return text(await api('GET', '/api/sessions')); } catch (e) { return fail(e); }
  });
}

// Claude Code's permission prompt tool for background runs (`--permission-prompt-tool`): it
// is called when a run wants something outside its allow-list. Stroll shows the request to
// the user, and this waits for the answer, polling so no request stays open for minutes.
function registerRunTools() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  server.registerTool('permission_prompt', {
    description: 'Internal to Stroll background runs: asks the user to approve a tool call.',
    inputSchema: {
      tool_name: z.string(),
      input: z.record(z.string(), z.unknown()).optional(),
      tool_use_id: z.string().optional(),
    },
  }, async ({ tool_name, input }) => {
    const answer = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
    const deny = message => answer({ behavior: 'deny', message });
    try {
      const req = await api('POST', '/api/approvals', { runId: process.env.STROLL_RUN || null, toolName: tool_name, input: input || {} });
      if (req.status === 'deny') return deny(req.message);
      if (req.status === 'allow') return answer({ behavior: 'allow', updatedInput: input || {} });
      for (;;) {
        await sleep(1000);
        const a = await api('GET', `/api/approvals/${req.id}`);
        if (a.status === 'allow') return answer({ behavior: 'allow', updatedInput: input || {} });
        if (a.status === 'deny') return deny(a.message || 'The user said no. Skip this step and list it under "Needs you".');
      }
    } catch (e) {
      return deny(`Couldn't ask the user (${e.message}). Skip this step and list it under "Needs you".`);
    }
  });
}

if (MODE === 'runs') registerRunTools();
else registerSessionTools();

server.connect(new StdioServerTransport());
