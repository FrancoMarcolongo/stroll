const fs = require('fs');

// Work a Claude Code session left running in the background: shells (Bash with
// run_in_background, or one the user sent there), async agents, monitors, workflows, and MCP
// calls Claude Code moved to the background after a while. No hook fires when one of them ends,
// but the session's transcript records both ends: the launch in the tool's result, and a
// <task-notification> with a status, queued the moment the task ends (mid-turn or not).
// TaskStop/KillShell results end one too. The transcript is read incrementally from where the
// last scan stopped.

const CHUNK = 4 * 1024 * 1024;
const MAX_TOOLS = 500;
const TOOL_KIND = { Bash: 'shell', PowerShell: 'shell', Agent: 'agent', Task: 'agent', Monitor: 'monitor', Workflow: 'workflow' };
const TASKID_TOOLS = new Set(['Monitor', 'Workflow']); // tools whose result `taskId` is a running task
const STOP_TOOLS = new Set(['TaskStop', 'KillShell', 'KillBash']);
const MCP_BG_RE = /^MCP tool "([^"]+)" is still running after [^\n]*? moved to the background as task ([\w-]+)/;
const NOTICE_RE = /<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g;

const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 100);

function labelFor(name, input = {}) {
  const text = input.description || input.command || input.prompt || input.name;
  if (text) return oneLine(text);
  return oneLine(String(name || '').replace(/^mcp__/, '').replace(/__/g, ' '));
}

function resultText(block) {
  if (!block) return '';
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
  return '';
}

// Task ids that ended in a notification: a <status> (completed, failed, killed, stopped), or a
// monitor's "[Monitor expired …]" event. Other monitor events carry no status and don't end it.
// The status is read from the header only: a notification's <result> can quote anything.
function endedIds(text) {
  const ids = [];
  for (const m of String(text).matchAll(NOTICE_RE)) {
    const head = m[1].split(/<summary>|<result>/)[0];
    const id = head.match(/<task-id>([^<]+)<\/task-id>/)?.[1];
    const event = m[1].match(/<event>([^<]*)/)?.[1] || '';
    if (id && (/<status>[^<]+<\/status>/.test(head) || /^\s*\[Monitor (expired|stopped|ended)\b/.test(event))) ids.push(id.trim());
  }
  return ids;
}

// The notification text, only where Claude Code itself queued or delivered one: never an
// assistant message or a tool result that happens to quote one.
function noticeText(d) {
  const starts = v => typeof v === 'string' && v.trimStart().startsWith('<task-notification>');
  if (d.type === 'queue-operation' && d.operation === 'enqueue' && starts(d.content)) return d.content;
  if (d.type === 'user' && !d.isSidechain && starts(d.message?.content)) return d.message.content;
  if (d.type === 'attachment' && d.attachment?.type === 'queued_command' && starts(d.attachment.prompt)) return d.attachment.prompt;
  return null;
}

class BackgroundTracker {
  constructor() {
    this.file = null;
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    this.tools = new Map(); // tool_use id -> { name, label }, until its result shows up
    this.tasks = new Map(); // task id -> { id, kind, label, startedAt }
    this.ended = new Set(); // ended ids, in case an end is read before its launch
  }

  // A new transcript (session start, /clear, /resume) is a new process or conversation: what
  // ran before is gone or no longer this conversation's, and its history is not re-read.
  follow(file) {
    if (!file || file === this.file) return false;
    const had = this.tasks.size > 0;
    this.file = file;
    this.partial = Buffer.alloc(0);
    this.tools.clear();
    this.tasks.clear();
    this.ended.clear();
    try { this.offset = fs.statSync(file).size; } catch (_) { this.offset = 0; }
    return had;
  }

  list() { return [...this.tasks.values()]; }

  // Reads what was appended since the last scan. Returns true if the task list changed.
  scan() {
    if (!this.file) return false;
    let size;
    try { size = fs.statSync(this.file).size; } catch (_) { return false; }
    if (size < this.offset) { this.offset = 0; this.partial = Buffer.alloc(0); }
    if (size === this.offset) return false;
    const before = [...this.tasks.keys()].join('\n');
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      while (this.offset < size) {
        const len = Math.min(CHUNK, size - this.offset);
        const buf = Buffer.alloc(len);
        const got = fs.readSync(fd, buf, 0, len, this.offset);
        if (got <= 0) break;
        this.offset += got;
        const data = this.partial.length ? Buffer.concat([this.partial, buf.subarray(0, got)]) : buf.subarray(0, got);
        const cut = data.lastIndexOf(0x0a);
        if (cut < 0) { this.partial = Buffer.from(data); continue; }
        this.partial = Buffer.from(data.subarray(cut + 1));
        for (const line of data.subarray(0, cut).toString('utf8').split('\n')) this.line(line);
      }
    } catch (_) { /* unreadable right now: try again next scan */ } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
    return [...this.tasks.keys()].join('\n') !== before;
  }

  line(line) {
    if (!line || line.startsWith('{"type":"api-request')) return;
    const relevant = line.includes('"tool_use"') || line.includes('"toolUseResult"') || line.includes('<task-notification>');
    if (!relevant) return;
    let d;
    try { d = JSON.parse(line); } catch (_) { return; }
    this.apply(d);
  }

  apply(d) {
    if (!d || typeof d !== 'object') return;
    const notice = noticeText(d);
    if (notice) { for (const id of endedIds(notice)) this.end(id); return; }
    if (d.isSidechain) return;
    if (d.type === 'assistant') {
      for (const c of d.message?.content || []) {
        if (c?.type !== 'tool_use' || !c.id) continue;
        this.tools.set(c.id, { name: c.name, label: labelFor(c.name, c.input) });
        if (this.tools.size > MAX_TOOLS) this.tools.delete(this.tools.keys().next().value);
      }
      return;
    }
    if (d.type !== 'user' || d.toolUseResult === undefined) return;
    const block = (Array.isArray(d.message?.content) ? d.message.content : []).find(c => c?.type === 'tool_result');
    const tool = block ? this.tools.get(block.tool_use_id) : null;
    if (block) this.tools.delete(block.tool_use_id);
    const r = d.toolUseResult;
    const at = d.timestamp || new Date().toISOString();
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      if (tool && STOP_TOOLS.has(tool.name)) { if (r.task_id || r.shell_id) this.end(String(r.task_id || r.shell_id)); return; }
      if (r.backgroundTaskId) return this.start(r.backgroundTaskId, 'shell', tool, at);
      if (r.status === 'async_launched' && r.agentId) return this.start(r.agentId, 'agent', tool, at);
      if (r.taskId && tool && TASKID_TOOLS.has(tool.name)) return this.start(r.taskId, TOOL_KIND[tool.name], tool, at);
    }
    const m = resultText(block).match(MCP_BG_RE);
    if (m) this.start(m[2], 'task', { label: oneLine(m[1].split(':').pop()) }, at); // "plugin:x:server/tool" -> "server/tool"
  }

  start(id, kind, tool, startedAt) {
    id = String(id);
    if (this.ended.has(id)) return;
    this.tasks.set(id, { id, kind, label: tool?.label || kind, startedAt });
  }

  end(id) {
    this.ended.add(id);
    if (this.ended.size > MAX_TOOLS) this.ended.delete(this.ended.values().next().value);
    this.tasks.delete(id);
  }
}

module.exports = { BackgroundTracker, endedIds };
