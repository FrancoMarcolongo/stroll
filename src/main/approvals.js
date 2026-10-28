const crypto = require('crypto');
const { EventEmitter } = require('events');
const { saveOverrides } = require('./config');
const { summarizeInput } = require('./runs');

const TIMEOUT_MS = 15 * 60 * 1000;
const NO_ANSWER = 'Nobody answered within 15 minutes. Skip this step and list it under "Needs you".';
const SAID_NO = 'The user said no. Skip this step and list it under "Needs you".';

const INTERPRETERS = new Set(['python', 'python3', 'node', 'bash', 'sh', 'zsh', 'ruby', 'perl', 'deno', 'bun', 'npx', 'osascript']);

// What a run is asking for, in words, plus the allow rule "Always allow" would save. No rule
// for compound commands (a prefix rule never matches them) or for an interpreter running
// inline code (`python3 -c …` would allow any code); a script path is fine.
function suggestRule(command) {
  if (!command || /[|;&<>`\n]|\$\(/.test(command)) return null;
  const [first, second] = command.split(/\s+/);
  if (INTERPRETERS.has(first)) return second && !/^[-"']/.test(second) ? `Bash(${first} ${second}:*)` : null;
  return `Bash(${second && !/^[-"']/.test(second) ? `${first} ${second}` : first}:*)`;
}

function describeRequest(toolName, input = {}) {
  if (toolName === 'Bash') {
    const command = String(input.command || '').trim();
    return { summary: 'Run a command', detail: command, rule: suggestRule(command) };
  }
  const detail = summarizeInput(input) || JSON.stringify(input).slice(0, 300);
  return { summary: `Use ${toolName.replace(/^mcp__/, '').replace(/__/g, ' › ')}`, detail, rule: toolName };
}

// Permission requests from background runs (via stroll-mcp.js's permission prompt tool). The
// run waits on `get(id)` until the user answers in Stroll, or the request times out.
class Approvals extends EventEmitter {
  constructor({ store, config, timeoutMs = TIMEOUT_MS }) {
    super();
    this.store = store;
    this.config = config;
    this.timeoutMs = timeoutMs;
    this.items = new Map();
  }

  request({ runId, toolName, input }) {
    const run = runId && this.store.run(runId);
    if (!run || run.status !== 'running') return { status: 'deny', message: 'No running background run to approve this for.' };
    const id = crypto.randomUUID();
    const d = describeRequest(toolName, input);
    const item = { id, runId, toolName, ...d, status: 'pending', message: null };
    item.timer = setTimeout(() => this.decide(id, 'deny', null, NO_ANSWER), this.timeoutMs);
    this.items.set(id, item);
    this.store.patchRun(runId, {
      pendingApproval: { id, toolName, summary: d.summary, detail: d.detail, rule: d.rule, requestedAt: new Date().toISOString() },
      lastActivity: `Waiting for your OK: ${d.detail.slice(0, 100)}`,
    });
    this.emit('requested', run, item);
    return { id, status: 'pending' };
  }

  get(id) {
    const a = this.items.get(id);
    return a ? { status: a.status, message: a.message } : null;
  }

  decide(id, decision, rule = null, message = null) {
    const a = this.items.get(id);
    if (!a || a.status !== 'pending') return false;
    clearTimeout(a.timer);
    a.status = decision === 'allow' ? 'allow' : 'deny';
    a.message = a.status === 'deny' ? (message || SAID_NO) : null;
    if (a.status === 'allow' && rule) {
      // "Always allow": future runs get the rule without asking (a run's list is fixed at start).
      const extra = [...new Set([...(this.config.background.extraAllowedTools || []), rule])];
      saveOverrides({ background: { extraAllowedTools: extra } });
      this.config.background.extraAllowedTools = extra;
      this.emit('config');
    }
    if (this.store.run(a.runId)?.pendingApproval?.id === id) {
      this.store.patchRun(a.runId, { pendingApproval: null, lastActivity: `${a.status === 'allow' ? 'Approved' : 'Denied'}: ${a.detail.slice(0, 100)}` });
    }
    // The run polls for the answer; keep it around long enough to be read.
    setTimeout(() => this.items.delete(id), 120000).unref?.();
    return true;
  }

  // A run that ends or is cancelled while asking has nobody left to answer.
  denyAllFor(runId, message) {
    for (const a of this.items.values()) if (a.runId === runId && a.status === 'pending') this.decide(a.id, 'deny', null, message);
    if (this.store.run(runId)?.pendingApproval) this.store.patchRun(runId, { pendingApproval: null });
  }
}

module.exports = { Approvals, describeRequest };
