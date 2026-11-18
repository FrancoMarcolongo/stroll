const fs = require('fs');
const os = require('os');
const path = require('path');

// Claude Code's tools that change files. Background runs can't use them, except the runs of a
// workflow inside the folders that workflow names: where the work keeps its own records (a
// digest's archive, a "last run" file), so a scheduled run can finish without anyone.
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const isEditRule = rule => EDIT_TOOLS.includes(String(rule).split('(')[0].trim());

// Folders as typed in a workflow's setup, as absolute paths. A relative one is dropped, and so
// is the home folder or anything above it: that would be every file the user has.
function cleanWriteDirs(list, home = os.homedir()) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    let dir = String(raw || '').trim();
    if (dir === '~' || dir.startsWith('~/')) dir = path.join(home, dir.slice(1));
    if (!path.isAbsolute(dir)) continue;
    dir = path.resolve(dir);
    if (dir === home || home.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep) || out.includes(dir)) continue;
    out.push(dir);
  }
  return out;
}

// Where a path really is, though it may not exist yet: its nearest existing ancestor with
// symlinks resolved, plus the rest. So a link inside a writable folder can't lead out of it.
function realTarget(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch (_) { /* not there yet: try its parent */ }
    const up = path.dirname(cur);
    if (up === cur) return path.join(cur, ...rest);
    rest.unshift(path.basename(cur));
    cur = up;
  }
}

// Is this file inside one of the folders? No for a relative path, and for one with `..` in it:
// past a symlink, the system and a tidied-up path can disagree on where that leads.
function isWritable(file, dirs = []) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) return false;
  const target = realTarget(file);
  return dirs.some(dir => target.startsWith(realTarget(dir) + path.sep));
}

module.exports = { EDIT_TOOLS, isEditRule, cleanWriteDirs, isWritable };
