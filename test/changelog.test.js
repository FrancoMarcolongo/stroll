// "What's new": parsing CHANGELOG.md, and which sections an update shows. The last test checks
// the real files, so a release can't go out without its section.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseChangelog, cmpVersion, unseenSections } = require('../src/main/changelog');

const sample = `# Changelog

Intro text.

## 0.3.0 — 2026-11-25

### New
- Three.

## 0.2.1

- Two and a bit.

## 0.2.0 — 2026-11-01

## 0.1.0 — 2026-10-01
- One.
`;

test('parseChangelog: one section per version with a body, newest first', () => {
  const s = parseChangelog(sample);
  assert.deepEqual(s.map(x => [x.version, x.date]), [['0.3.0', '2026-11-25'], ['0.2.1', null], ['0.1.0', '2026-10-01']]);
  assert.equal(s[0].body, '### New\n- Three.');
});

test('cmpVersion: numeric, not alphabetical', () => {
  assert.ok(cmpVersion('0.10.0', '0.9.9') > 0);
  assert.ok(cmpVersion('0.16.1', '0.17.0') < 0);
  assert.equal(cmpVersion('1.2.3', '1.2.3'), 0);
});

test('unseenSections: newer than last seen, up to the version running', () => {
  const s = parseChangelog(sample);
  assert.deepEqual(unseenSections(s, '0.1.0', '0.2.1').map(x => x.version), ['0.2.1']);
  assert.deepEqual(unseenSections(s, '0.1.0', '0.3.0').map(x => x.version), ['0.3.0', '0.2.1']);
  // State from before "What's new" existed: only the running version's.
  assert.deepEqual(unseenSections(s, null, '0.3.0').map(x => x.version), ['0.3.0']);
});

test('the real CHANGELOG.md has a section for the version in package.json, on top', () => {
  const root = path.join(__dirname, '..');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const sections = parseChangelog(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'));
  assert.equal(sections[0].version, version);
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
  assert.match(fs.readFileSync(path.join(root, 'src', 'mcp', 'stroll-mcp.js'), 'utf8'), new RegExp(`version: '${version.replace(/\./g, '\\.')}'`));
});
