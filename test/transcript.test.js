// What Stroll reads from Claude Code's transcripts: the last message's time (the order and age
// of sessions) and the last reply (the line under a session's title).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { previewFromText, lastAssistantText, lastMessageAt } = require('../src/main/transcript');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stroll-test-'));
const transcript = (name, lines) => {
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
};
const say = (type, at, text, extra = {}) => ({
  type, timestamp: at, ...extra,
  message: { role: type, content: type === 'assistant' ? [{ type: 'text', text }] : text },
});

test('lastMessageAt: the last message, yours or Claude’s', () => {
  const file = transcript('plain', [
    say('user', '2026-11-20T10:00:00.000Z', 'look into it'),
    say('assistant', '2026-11-20T10:05:00.000Z', 'Here is what I found.'),
  ]);
  assert.equal(lastMessageAt(file), '2026-11-20T10:05:00.000Z');
});

test('lastMessageAt: what a resume writes after the last message doesn’t count', () => {
  const file = transcript('resumed', [
    say('user', '2026-11-20T10:00:00.000Z', 'look into it'),
    say('assistant', '2026-11-20T10:05:00.000Z', 'Done.'),
    { type: 'custom-title', customTitle: 'Renamed' },
    { type: 'summary', summary: 'A summary', timestamp: '2026-11-25T09:00:00.000Z' },
  ]);
  assert.equal(lastMessageAt(file), '2026-11-20T10:05:00.000Z');
});

test('lastMessageAt: a subagent’s messages (sidechain) don’t count', () => {
  const file = transcript('sidechain', [
    say('user', '2026-11-20T10:00:00.000Z', 'look into it'),
    say('assistant', '2026-11-21T08:00:00.000Z', 'subagent work', { isSidechain: true }),
  ]);
  assert.equal(lastMessageAt(file), '2026-11-20T10:00:00.000Z');
});

test('lastMessageAt: a cut or broken line is skipped', () => {
  const file = transcript('broken', [
    say('assistant', '2026-11-20T10:05:00.000Z', 'Done.'),
    '{"type":"user","timestamp":"2026-11-2', // cut mid-write
  ]);
  assert.equal(lastMessageAt(file), '2026-11-20T10:05:00.000Z');
});

test('lastMessageAt: no file or no messages gives null', () => {
  assert.equal(lastMessageAt(path.join(dir, 'missing.jsonl')), null);
  assert.equal(lastMessageAt(null), null);
  assert.equal(lastMessageAt(transcript('empty', [{ type: 'custom-title', customTitle: 'x' }])), null);
});

test('lastAssistantText: the last reply with text, not a subagent’s', () => {
  const file = transcript('replies', [
    say('assistant', '2026-11-20T10:01:00.000Z', 'First reply.'),
    say('assistant', '2026-11-20T10:02:00.000Z', 'Second reply.'),
    say('assistant', '2026-11-20T10:03:00.000Z', 'From a subagent.', { isSidechain: true }),
    { type: 'assistant', timestamp: '2026-11-20T10:04:00.000Z', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
  ]);
  assert.equal(lastAssistantText(file), 'Second reply.');
});

test('previewFromText: a closing question wins, else the first line that isn’t a heading', () => {
  assert.equal(previewFromText('## Result\nIt works now.\n\nWant me to push it?'), 'Want me to push it?');
  assert.equal(previewFromText('## Result\n- **It works** now.\n- More detail.'), 'It works now.');
  assert.equal(previewFromText(''), null);
  assert.equal(previewFromText('x'.repeat(400)).length, 160);
});
