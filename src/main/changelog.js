// "What's new": CHANGELOG.md, one "## <version>" (optionally "— <date>") section per release,
// newest first. Shown once, after an update, for the versions the user hasn't seen yet.

function parseChangelog(text) {
  const sections = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^## +v?(\d+\.\d+\.\d+)\s*(?:[—–-]+\s*(.+?))?\s*$/);
    if (m) {
      cur = { version: m[1], date: m[2] || null, lines: [] };
      sections.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return sections
    .map(({ lines, ...s }) => ({ ...s, body: lines.join('\n').trim() }))
    .filter(s => s.body);
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

// Newer than what the user last saw, up to the version running. With no last-seen version
// (state from before "What's new" existed) only the running version's notes.
function unseenSections(sections, lastSeen, current) {
  return sections.filter(s => cmpVersion(s.version, current) <= 0
    && (lastSeen ? cmpVersion(s.version, lastSeen) > 0 : cmpVersion(s.version, current) === 0));
}

module.exports = { parseChangelog, cmpVersion, unseenSections };
