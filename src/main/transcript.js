// Reading Claude Code's transcripts (~/.claude/projects/<folder>/<session id>.jsonl, one JSON
// object a line), only their tail: what a session last said, and when it last had a message.
// Kept apart from sessions.js so it can be tested without node-pty.
const fs = require('fs');

const TRANSCRIPT_TAIL = 512 * 1024;

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

// The last lines of a transcript, reading only its tail ([] when unreadable).
function transcriptTail(file) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const len = Math.min(size, TRANSCRIPT_TAIL);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n');
  } catch (_) { return []; }
}

// Text of the last assistant message in a transcript.
function lastAssistantText(file) {
  const lines = transcriptTail(file);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"assistant"')) continue;
    let d;
    try { d = JSON.parse(lines[i]); } catch (_) { continue; }
    if (d.type !== 'assistant' || d.isSidechain) continue;
    const text = (d.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    if (text) return text;
  }
  return null;
}

// When the last message (yours or Claude's) was written. The file's own time won't do: resuming
// a session touches it.
function lastMessageAt(file) {
  const lines = transcriptTail(file);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"timestamp"')) continue;
    let d;
    try { d = JSON.parse(lines[i]); } catch (_) { continue; }
    if ((d.type === 'user' || d.type === 'assistant') && !d.isSidechain && d.timestamp && !Number.isNaN(Date.parse(d.timestamp))) {
      return new Date(d.timestamp).toISOString();
    }
  }
  return null;
}

module.exports = { previewFromText, transcriptTail, lastAssistantText, lastMessageAt };
