// Claude Code sessions running outside Stroll ("Running elsewhere" on the Overview), from Claude
// Code's list of its live processes, ~/.claude/sessions/<pid>.json. HOME points at a scratch
// folder before recent.js reads it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stroll-home-'));
process.env.HOME = home;
const { runningElsewhere } = require('../src/main/recent');

const running = path.join(home, '.claude', 'sessions');
const projects = path.join(home, '.claude', 'projects', '-Users-someone-work');
fs.mkdirSync(running, { recursive: true });
fs.mkdirSync(projects, { recursive: true });
const proc = (pid, fields) => fs.writeFileSync(path.join(running, `${pid}.json`), JSON.stringify({
  pid, kind: 'interactive', cwd: '/Users/someone/work', startedAt: Date.parse('2026-11-25T10:00:00Z'), status: 'idle', ...fields,
}));
const deadPid = 999999; // no such process

// This test's own process stands in for a live Claude Code.
proc(process.pid, { sessionId: 'aaa', name: 'work', nameSource: 'derived', status: 'busy', statusUpdatedAt: Date.parse('2026-11-25T10:30:00Z') });
fs.writeFileSync(path.join(projects, 'aaa.jsonl'), `${JSON.stringify({ type: 'user', cwd: '/Users/someone/work', message: { content: 'Fix the importer' } })}\n`);
proc(deadPid, { sessionId: 'gone' });

test('lists live interactive sessions Stroll doesn’t know, titled from their transcript', () => {
  const list = runningElsewhere(new Set());
  assert.equal(list.length, 1);
  assert.deepEqual(
    { id: list[0].id, title: list[0].title, busy: list[0].busy, cwd: list[0].cwd, updatedAt: list[0].updatedAt },
    { id: 'aaa', title: 'Fix the importer', busy: true, cwd: '/Users/someone/work', updatedAt: '2026-11-25T10:30:00.000Z' },
  );
});

test('leaves out sessions Stroll started', () => {
  assert.deepEqual(runningElsewhere(new Set(['aaa'])), []);
});

test('a name the user gave beats the transcript', () => {
  proc(process.pid, { sessionId: 'aaa', name: 'Importer fix', nameSource: 'user' });
  assert.equal(runningElsewhere(new Set())[0].title, 'Importer fix');
});

test('skips other kinds of process and files it can’t read', () => {
  proc(process.pid, { sessionId: 'aaa', kind: 'print' });
  fs.writeFileSync(path.join(running, '12345.json'), '{ not json');
  assert.deepEqual(runningElsewhere(new Set()), []);
});
