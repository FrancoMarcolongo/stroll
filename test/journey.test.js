// The journey's layout (src/renderer/journey.js): for many map sizes and numbers of trails, each
// clearing's path wanders from its clearing to the loop round the hub without a bend sharper than
// the limit, without going off the map or through another clearing, and without crossing itself.
// Paths may cross each other on the way; that's wanted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Just enough of a browser for the file to load; plan() draws nothing.
const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ctx), set: (t, k, v) => { t[k] = v; return true; } });
global.window = { devicePixelRatio: 1 };
global.document = { fonts: null, createElement: () => ({ getContext: () => ctx, width: 0, height: 0 }) };
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'journey.js'), 'utf8'), { filename: 'journey.js' });
const { plan, fits } = window.Journey;

const MIN_RADIUS = 12; // journey.js aims for 14 and accepts a little under it
const listOf = (n, tag = '') => [...Array.from({ length: n - 1 }, (_, i) => ({ key: `trail-${i}${tag}`, title: `Trail ${i}` })), { key: `camp${tag}`, title: 'Base camp' }];
function* layouts() {
  for (const aw of [180, 230, 300, 360, 420, 520, 640]) {
    for (const ah of [280, 340, 420, 520]) {
      for (let n = 1; n <= 16; n += 1) if (fits(aw, ah, n)) yield { where: `${aw}x${ah}, ${n} clearings`, aw, ah, world: plan(aw, ah, listOf(n)) };
    }
  }
}
// The tightest bend's radius, in art pixels.
function tightest(pts) {
  let r = Infinity;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const [ax, ay] = pts[i - 1]; const [bx, by] = pts[i]; const [cx, cy] = pts[i + 1];
    let turn = Math.abs(Math.atan2(cy - by, cx - bx) - Math.atan2(by - ay, bx - ax));
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn > 1e-9) r = Math.min(r, (Math.hypot(bx - ax, by - ay) + Math.hypot(cx - bx, cy - by)) / 2 / turn);
  }
  return r;
}

test('each path runs from its clearing to the loop, on the map and clear of the other clearings', () => {
  let count = 0;
  for (const { where, aw, ah, world } of layouts()) {
    const { hx, hy, hub, clearings } = world;
    for (const c of clearings) {
      const pts = c.paths[0];
      const [e0, e1] = c.top ? hub.entries.top : hub.entries.bottom;
      assert.deepEqual(pts[0], [c.cx, c.top ? c.cy + c.ry - 3 : c.cy - c.ry + 3], `${where}: ${c.title} starts at its clearing`);
      const [lx, ly] = pts[pts.length - 1];
      assert.ok(Math.abs(ly - (hy + (c.top ? hub.top : hub.bot))) < 0.01 && lx >= hx + e0 && lx <= hx + e1, `${where}: ${c.title} ends on the loop`);
      for (const [x, y] of pts) {
        assert.ok(x >= 0 && x <= aw && y >= 0 && y <= ah, `${where}: ${c.title} goes off the map at (${x}, ${y})`);
        for (const o of clearings) {
          if (o !== c) assert.ok(((x - o.cx) / o.rx) ** 2 + ((y - o.cy) / o.ry) ** 2 >= 1, `${where}: ${c.title} goes through ${o.title}`);
        }
      }
      count += 1;
    }
  }
  assert.ok(count > 500, `checked ${count} paths`);
});

test('no bend is sharper than the limit, and no path jumps', () => {
  for (const { where, world } of layouts()) {
    for (const c of world.clearings) {
      const pts = c.paths[0];
      const r = tightest(pts);
      assert.ok(r >= MIN_RADIUS, `${where}: ${c.title} bends as tight as ${r.toFixed(1)}`);
      for (let i = 1; i < pts.length; i += 1) assert.ok(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) <= 4, `${where}: ${c.title} jumps`);
    }
  }
});

test('a path may swing aside or detour, but never crosses itself', () => {
  const crosses = ([ax, ay], [bx, by], [cx, cy], [dx, dy]) => {
    const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
    if (!d) return false;
    const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d;
    const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
    return t > 0 && t < 1 && u > 0 && u < 1;
  };
  for (const { where, world } of layouts()) {
    for (const c of world.clearings) {
      const pts = c.paths[0];
      for (let i = 0; i < pts.length - 1; i += 1) {
        for (let j = i + 2; j < pts.length - 1; j += 1) assert.ok(!crosses(pts[i], pts[i + 1], pts[j], pts[j + 1]), `${where}: ${c.title} crosses itself`);
      }
    }
  }
});

test('the same trails get the same paths; other trails, other paths', () => {
  const a = plan(420, 420, listOf(5));
  assert.deepEqual(plan(420, 420, listOf(5)), a);
  assert.notDeepEqual(plan(420, 420, listOf(5, '-other')).clearings.map(c => c.paths), a.clearings.map(c => c.paths));
});
