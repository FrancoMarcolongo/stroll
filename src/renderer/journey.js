// The journey: every live session is a walker, and where they stand says what they're doing.
// In the middle is the hub, where the work happens; close around it, a clearing in the woods for
// each trail, its camp, there even with nobody out (and the base camp for sessions on no trail).
// A click on a camp's tent starts a new session on that trail. Each clearing's
// winding path comes into the hub from off to one side, so the trails' paths cross one another.
// Walkers live in their trail's clearing and walk to the hub to work, the shortest way along the
// paths:
//
//   thinking            wandering the paths, round the hub and over the crossings
//   reading, searching  at the map board, pointing
//   editing             sitting on the rock, writing in a notebook
//   running commands    at the campfire
//   with subagents      wandering with a pet for each subagent out
//   needs you           at the closed gate, with a "!"
//   in the background   fishing at the pond
//   your turn           resting on the deck in the hub, with a tick; once seen, a few
//                       minutes more with a hot drink, in case another message comes
//   nothing to do       back in their clearing, dozing by the tent
//
// A session's walker comes out of its tent when the session starts or is resumed, and goes back
// in when it ends.
//
// Subagents and agents running in the background are pets that follow their walker.
//
// Background runs (workflows, hand-offs) are wanderers: loaded with a big pack and a stick, they
// come out of the woods by their trail's clearing, work at the stations like anyone (at the gate
// when they need your OK), and when they're done they leave a bag in the clearing and go back
// into the woods. The bag stays until you open the run; a click on it does.
//
// Walkers who cross on the way stop to say hello, and a word each about their session; those at
// the same spot talk like that now and then too.
// The whole map always fits the panel: the hub takes
// the room there is, and the more clearings, the smaller it's all drawn. Everything is drawn in
// code at one art pixel per pixel, then blown up by a whole number of screen pixels so it stays
// sharp; names go on top at screen resolution. A walker's looks come from the session's id.
// Nothing here knows about Stroll's state: app.js hands it the people.
(function () {
  const MIN_CLEAR_W = 84; // a clearing needs this much width
  const MIN_DWELL = 3000; // ms at a work spot before walking to the next, so it doesn't dart about
  const LINGER = 3 * 60 * 1000; // how long someone who's finished stays in the hub once seen
  const HEAD_H = 22; // the strip: a head and shoulders per person

  // ---------- looks ----------
  const SKIN = ['#f3cfae', '#e6b48d', '#c98d66', '#a06a47', '#73492f'];
  const HAIR = ['#2b1d14', '#5a3825', '#a5662f', '#d9b46a', '#e3ddd1', '#9a3b2e', '#3a4357', '#1f2a44'];
  const SHIRT = ['#3f6fb5', '#b5523f', '#3f9b6f', '#8a5bb5', '#c79a3a', '#4a5568', '#b5407e', '#2f8f9d'];
  const PANTS = ['#3b4256', '#4a3f35', '#2f3a4a', '#5a5048', '#384a3a'];
  const HATC = ['#c0473a', '#d9a23b', '#3f7fb5', '#5c9b5a', '#e6e0d0', '#8a5bb5', '#d9783b'];
  const PACK = ['#8b5e3c', '#a0503c', '#4f6b3a', '#3c5a8b', '#7a6a4f', '#b07a2a'];
  const FUR = ['#c08a4f', '#e8dcc6', '#9aa0a8', '#a5662f', '#d9b46a', '#e0a060'];
  const HATS = ['cap', 'beanie', 'bucket', 'bandana', 'none', 'pony'];
  const CLOAK = ['#4f6b4a', '#4a5a7a', '#6a4a66', '#8a4f3a', '#3f6a6a', '#6b6a3f'];
  const LEATHER = ['#7a5534', '#8a6a3f', '#6b4a35'];
  const ROLL = ['#d8c9a0', '#b8574a', '#7f9fc0', '#9ab27a', '#d9a55a']; // bedrolls, lighter than the cloaks

  function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function looksOf(id) {
    const h = hash(String(id));
    const g = hash(`${id}~`);
    return {
      skin: SKIN[h % SKIN.length], hair: HAIR[(h >>> 3) % HAIR.length], shirt: SHIRT[(h >>> 7) % SHIRT.length],
      pants: PANTS[(h >>> 11) % PANTS.length], hat: HATS[(h >>> 14) % HATS.length], hatColor: HATC[(h >>> 17) % HATC.length],
      pack: PACK[(h >>> 20) % PACK.length], fur: g % FUR.length, phase: (g >>> 5) % 64, lap: (g >>> 11) % 2 ? 1 : -1,
    };
  }

  // A wanderer: the same face, under a hood, in a travelling cloak with a bedroll on the pack.
  function wandererLooks(id) {
    const h = hash(`${id}^`);
    return { ...looksOf(id), shirt: CLOAK[h % CLOAK.length], pack: LEATHER[(h >>> 8) % LEATHER.length], roll: ROLL[(h >>> 4) % ROLL.length] };
  }

  function shade(hex, f = 0.78) {
    const n = parseInt(hex.slice(1), 16);
    const d = v => Math.max(0, Math.min(255, Math.round(v * f)));
    return `rgb(${d(n >> 16)},${d((n >> 8) & 255)},${d(n & 255)})`;
  }
  const rgb = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };

  // What a walker is up to, from the session: its dot (as in the sidebar), its activity and
  // whether it has subagents out.
  function poseOf(p) {
    if (p.kind === 'run') {
      if (p.run !== 'running') return 'drop';
      if (p.dot === 'waiting') return 'waiting';
      return p.activity && p.activity !== 'agent' ? p.activity : 'think';
    }
    if (p.dot === 'waiting') return 'waiting';
    if (p.dot === 'idle') return 'done';
    if (p.dot === 'working') return p.subagents > 0 ? 'agent' : p.activity === 'agent' ? 'think' : p.activity || 'think';
    if (p.dot === 'bg') return 'bg';
    if (p.starting) return 'start';
    // Seen, but just finished: a while on the deck in case another message comes, then home.
    if (p.finishedAt && Date.now() - Date.parse(p.finishedAt) < LINGER) return 'linger';
    return 'rest';
  }
  const SPOT_OF = { waiting: 'gate', read: 'board', write: 'rock', run: 'fire', bg: 'pond', think: 'ring', agent: 'ring', done: 'lounge', linger: 'lounge', rest: 'rest', start: 'start', drop: 'drop' };
  const HUB_SPOTS = new Set(['gate', 'board', 'rock', 'fire', 'pond', 'lounge', 'ring']);
  const WORK = new Set(['ring', 'board', 'rock', 'fire']);

  // ---------- sprites: rows of letters, a letter per art pixel ----------
  // h hair, s skin, e eye, c shirt, C its shade, p trousers, o shoes, b backpack, B its shade.
  // Rows 0–13 are the body; hats may add rows -2 and -1 above. An outline is added around it.
  const BODY = {
    down: ['...hhhhhh...', '..hhhhhhhh..', '.hhhhhhhhhh.', '.hhhsssshhh.', '.hssssssssh.', '.hssessessh.', '..ssssssss..', '...ssssss...',
      '..CccccccC..', '.CccccccccC.', '.CccccccccC.', '.s.pppppp.s.'],
    up: ['...hhhhhh...', '..hhhhhhhh..', '.hhhhhhhhhh.', '.hhhhhhhhhh.', '.hhhhhhhhhh.', '.hhhhhhhhhh.', '..hhhhhhhh..', '...ssssss...',
      '..cbbbbbbc..', '.CcbbbbbbcC.', '.CcBBBBBBcC.', '.s.pppppp.s.'],
    right: ['...hhhhhh...', '..hhhhhhhh..', '.hhhhhhhhhh.', '.hhhhhhhsss.', '.hhhhssssss.', '.hhhssssess.', '..hhssssss..', '....sssss...',
      '..bbccccc...', '.bbbccCcc...', '.bbbccCcc...', '..b.ppsp....'],
  };
  const LEGS = {
    down: { stand: ['...pp..pp...', '...oo..oo...'], a: ['...pp..oo...', '...oo.......'], b: ['...oo..pp...', '.......oo...'], sit: ['..pppppppp..', '..oo....oo..'] },
    up: { stand: ['...pp..pp...', '...oo..oo...'], a: ['...pp..oo...', '...oo.......'], b: ['...oo..pp...', '.......oo...'], sit: ['..pppppppp..', '..oo....oo..'] },
    right: { stand: ['....pp......', '....ooo.....'], a: ['...p..p.....', '..oo...oo...'], b: ['....pp......', '....ooo.....'], sit: ['....pppppp..', '.........oo.'] },
  };
  // Hats and hair, laid over the head: row number → row.
  const HAT = {
    cap: { down: { 0: '...tttttt...', 1: '..tttttttt..', 2: '.tttttttttt.', 3: '.TTTTTTTTTT.' }, up: { 0: '...tttttt...', 1: '..tttttttt..', 2: '.tttttttttt.' }, right: { 0: '...tttttt...', 1: '..tttttttt..', 2: '.tttttttttTT' } },
    beanie: { all: { '-1': '.....TT.....', 0: '...tttttt...', 1: '..tttttttt..', 2: '.tTtTtTtTtT.' } },
    bucket: { all: { '-1': '....tttt....', 0: '...tttttt...', 1: '..tttttttt..', 2: 'TTTTTTTTTTTT' } },
    bandana: { down: { 1: '..tttttttt..', 2: '.tttttttttt.' }, up: { 1: '..tttttttt..', 2: '.tttttttttt.', 3: '.....tt.....' }, right: { 1: '..tttttttt..', 2: '.tttttttttt.', 3: 't...........', 4: 't...........' } },
    none: {},
    pony: { up: { 7: '.....hh.....', 8: '.....hh.....', 9: '.....hh.....' }, right: { 3: 'h...........', 4: 'h...........', 5: 'h...........', 6: 'h...........' } },
  };
  // Wanderers, 16 wide with rows -4..11 (the bedroll rides above the head), then their legs:
  // u hood, U its shade, k cloak, K its shade, x the pack's straps, b pack, B its shade,
  // r bedroll, R its shade, w the walking stick, m a pot hanging off the pack.
  const WANDER = {
    down: ['....rrrrrrrr....', '...rRrrrrrrRr...', '...RRRRRRRRRR...', '....bbbbbbbb....',
      '....buuuuuub....', '...buuuuuuuub...', '...uuuuuuuuuu.w.', '...uussssssuu.w.', '...ussssssssu.w.', '...ussessessu.w.',
      '..b.UssssssU.bw.', '..bbkksssskkbbw.', '..bkkxkkkkxkkbw.', '..bkkxkkkkxkkbw.', '...kkkkkkkkkksw.', '...s.pppppp...w.'],
    up: ['....rrrrrrrr....', '...rRrrrrrrRr...', '...RRRRRRRRRR...', '....bbbbbbbb....',
      '....buuuuuub....', '...buuuuuuuub...', '...uuuuuuuuuu.w.', '..bbbbbbbbbbbbw.', '..bBBBBBBBBBBbw.', '..bbbbbbbbbbbbw.',
      '..bbbmmbbbbbbbw.', '..bbbmmbbbbbbbw.', '..bbbbbbbbbbbbw.', '..BBBBBBBBBBBBw.', '...kkkkkkkkkksw.', '...s.pppppp...w.'],
    right: ['................', '..rrrr..........', '.rrRRrr.........', '..rrrr..........',
      '.bbbbuuuuuu.....', '.bbbuuuuuuuu....', 'bbbuuuuuuuuuu.w.', 'bbbuuuuuuusss.w.', 'bbbuuuussssss.w.', 'bbbuuussssess.w.',
      'bbbbuussssss..w.', 'bbbbbbsssss...w.', 'bbbbbbkkkkk...w.', 'BbbbbbkkKkkkksw.', 'BBBBBBkkKkk...w.', '.mm...pppp....w.'],
  };
  const WLEGS = {
    down: { stand: ['.....pp..pp...w.', '.....oo..oo...w.'], a: ['.....pp..oo...w.', '.....oo.......w.'], b: ['.....oo..pp...w.', '.........oo...w.'], sit: ['....pppppppp..w.', '....oo....oo..w.'] },
    right: { stand: ['......pp......w.', '......ooo.....w.'], a: ['.....p..p.....w.', '....oo...oo...w.'], b: ['......pp......w.', '......ooo.....w.'], sit: ['......pppppp..w.', '...........oo.w.'] },
  };
  WLEGS.up = WLEGS.down;
  // The bag a wanderer leaves: s sacking, S its light, D its shade, t the tie (red if it went wrong).
  const BAG = ['..ttt..', '...t...', '.sSss..', 'sSsssss', 'sssssDs', '.sDDDD.'];

  // Pets, facing right: d fur, D its shade, e eye, n nose.
  const PET = {
    dog: {
      stand: ['.......dd.', 'd.....dded', '.ddddddddn', '.Dddddddd.', '.d.d..d.d.'],
      a: ['.......dd.', '.d....dded', 'dddddddddn', '.Dddddddd.', 'd..d..d..d'],
      b: ['.......dd.', 'd.....dded', '.ddddddddn', '.Dddddddd.', '..dd..dd..'],
    },
    cat: {
      stand: ['d......d.d', 'd......ddd', '.d.....ded', '.dddddddd.', '.DdddddD..', '.d.d..d.d.'],
      a: ['.d.....d.d', 'd......ddd', 'd......ded', '.dddddddd.', '.DdddddD..', 'd..d..d..d'],
      b: ['d......d.d', 'd......ddd', '.d.....ded', '.dddddddd.', '.DdddddD..', '..dd..dd..'],
    },
  };
  const OUTLINE = '#15121c';

  const cache = new Map();
  function paint(rows, colors) {
    const w = Math.max(...rows.map(r => r.length)) + 2;
    const h = rows.length + 2;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    rows.forEach((row, j) => [...row].forEach((ch, i) => {
      const col = colors[ch];
      if (!col) return;
      g.fillStyle = col;
      g.fillRect(i + 1, j + 1, 1, 1);
    }));
    // A dark outline around whatever was painted.
    const img = g.getImageData(0, 0, w, h);
    const a = i => img.data[i * 4 + 3];
    g.fillStyle = OUTLINE;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        if (a(i)) continue;
        if ((x > 0 && a(i - 1)) || (x < w - 1 && a(i + 1)) || (y > 0 && a(i - w)) || (y < h - 1 && a(i + w))) g.fillRect(x, y, 1, 1);
      }
    }
    return cv;
  }
  function mirror(cv) {
    const m = document.createElement('canvas');
    m.width = cv.width; m.height = cv.height;
    const g = m.getContext('2d');
    g.scale(-1, 1);
    g.drawImage(cv, -cv.width, 0);
    return m;
  }

  // A walker's picture: dir is down, up, left or right; legs stand, a, b or sit.
  function walkerSprite(id, look, dir, legs, shut) {
    const key = `${id}|${dir}|${legs}|${shut ? 1 : 0}`;
    if (cache.has(key)) return cache.get(key);
    let out;
    if (dir === 'left') out = mirror(walkerSprite(id, look, 'right', legs, shut));
    else {
      const rows = [...BODY[dir], ...LEGS[dir][legs]];
      const grid = ['............', '............'].concat(rows); // rows -2 and -1 for tall hats
      const hat = HAT[look.hat][dir] || HAT[look.hat].all || {};
      for (const [r, line] of Object.entries(hat)) {
        const j = Number(r) + 2;
        grid[j] = [...grid[j]].map((ch, i) => (line[i] && line[i] !== '.' ? line[i] : ch)).join('');
      }
      const colors = {
        h: look.hair, s: look.skin, e: shut ? shade(look.skin, 0.7) : '#1b1b22',
        c: look.shirt, C: shade(look.shirt), p: look.pants, o: '#2a2320', b: look.pack, B: shade(look.pack), t: look.hatColor, T: shade(look.hatColor),
      };
      out = paint(grid, colors);
    }
    cache.set(key, out);
    return out;
  }
  // The canvas is 14×18: the feet's middle is at (7, 17).
  const FOOT_X = 7;
  const FOOT_Y = 17;

  // A wanderer's picture: 18×20, the feet's middle at (9, 19), the head two rows lower than a
  // walker's in it (`lift`).
  const W_FOOT_X = 9;
  const W_FOOT_Y = 19;
  const W_LIFT = 2;
  function wandererSprite(id, look, dir, legs, shut) {
    const key = `${id}|W|${dir}|${legs}|${shut ? 1 : 0}`;
    if (cache.has(key)) return cache.get(key);
    const out = dir === 'left' ? mirror(wandererSprite(id, look, 'right', legs, shut)) : paint([...WANDER[dir], ...WLEGS[dir][legs]], {
      u: look.shirt, U: shade(look.shirt), k: look.shirt, K: shade(look.shirt), x: shade(look.pack, 0.6), b: look.pack, B: shade(look.pack),
      r: look.roll, R: shade(look.roll), w: '#8a6a44', m: '#9aa0a6', s: look.skin, e: shut ? shade(look.skin, 0.7) : '#1b1b22', p: look.pants, o: '#2a2320',
    });
    cache.set(key, out);
    return out;
  }
  const bagCache = new Map();
  function bagSprite(failed) {
    if (!bagCache.has(failed)) bagCache.set(failed, paint(BAG, { t: failed ? '#c0473a' : '#5b3d24', s: '#c4a06a', S: '#e3c99a', D: '#9a7a4c' }));
    return bagCache.get(failed);
  }

  function petSprite(id, kind, color, legs, left) {
    const key = `pet|${id}|${kind}|${color}|${legs}|${left ? 1 : 0}`;
    if (cache.has(key)) return cache.get(key);
    const out = left ? mirror(petSprite(id, kind, color, legs, false)) : paint(PET[kind][legs], { d: color, D: shade(color), e: '#1b1b22', n: '#1b1b22' });
    cache.set(key, out);
    return out;
  }

  // ---------- the map ----------
  // A calm palette: greens low in saturation, warm sand and wood, soft teal water, light coming
  // from the top left.
  const P = {
    forest: ['#20352a', '#243a2d', '#29402f'], grass: ['#3a5b3d', '#41653f', '#4a7043'],
    tuft: '#5a8448', tuftL: '#7aa25a', path: '#a88d64', pathD: '#8f7653', pathL: '#bda373', pathEdge: '#6b7148',
    plaza: '#9b815c', water: '#3a7686', waterS: '#4f909a', waterDeep: '#2c5f70', waterL: '#a3dcd4', sand: '#b3a074',
    treeO: '#142a1e', treeD: '#1f402b', tree: '#2e5a37', treeL: '#467946', treeH: '#6e9c57',
    pineD: '#163026', pine: '#22483a', pineL: '#376a4e', pineH: '#5b8f66', trunk: '#5c402c', trunkD: '#3d2a1c',
    wood: '#9a6b43', woodD: '#6b482e', woodL: '#c28c59', roof: '#7d4f36', roofL: '#9c6544',
    stone: '#8b9197', stoneD: '#62686f', stoneL: '#bcc1c6', moss: '#6f914f',
    tents: [['#d9775b', '#b25d46'], ['#5fa19a', '#477f79'], ['#dcae5a', '#b78c43'], ['#6f8cc2', '#56709e'], ['#c792b4', '#a17293'], ['#e3cb98', '#bfa677']],
    paper: '#efe3c3', ink: '#8a7552', red: '#d0503c', fire: ['#fff0b0', '#ffb347', '#e8663a'],
    flower: ['#f4d97f', '#f3a9a3', '#f7f2e6', '#acccf4', '#d1abec'], lily: '#5c9a5c', lilyD: '#45784a', bulbs: ['#ffd27a', '#f3a9a3', '#9fdcd4', '#d1abec'],
  };
  const GROUND = { FOREST: 0, MEADOW: 1, PATH: 2, PLAZA: 3, WATER: 4 };

  // The hub, in its own coordinates, for a given height: the loop of path round it, and its
  // spots, each place being where a walker's feet go, which way they face and whether they sit.
  // Inside the loop, the campfire and, below it, the deck where those who've finished rest. The
  // stations stand beside the loop, level with its sides, clear of the paths that come into it
  // from above and below: the board and the gate on the left, the rock and the pond on the right.
  // kiosk, rockAt and gateAt are where each one's drawing is moved to; pond is [x, y, rx, ry].
  function hubOf(hh) {
    const top = 42;
    const bot = hh - 44;
    const mx = HUB_W / 2;
    const fx = mx;
    const fy = top + Math.round((bot - top) * 0.34);
    const lx = mx;
    const ly = top + Math.round((bot - top) * 0.72);
    const kiosk = [-6, top + 4];
    const rockAt = [46, top - 4];
    const gs = bot - 34; // the gate's stub of path leaves the loop here
    const gateAt = [-8, gs - 3];
    const pond = [198, bot - 20, 20, 12];
    const [px, py, prx, pry] = pond;
    return {
      top, bot, fire: [fx, fy], lounge: [lx, ly], kiosk, rockAt, gateAt, gateStub: gs, pond,
      ring: [[54, top], [166, top], [172, top + 6], [172, bot - 6], [166, bot], [54, bot], [48, bot - 6], [48, top + 6]],
      places: {
        board: [[12, top + 39, 'up'], [24, top + 39, 'up'], [36, top + 40, 'up'], [6, top + 43, 'up']],
        rock: [[190, top + 24, 'down', 1], [203, top + 24, 'down', 1], [180, top + 33, 'up'], [213, top + 33, 'up']],
        fire: [[fx - 13, fy + 5, 'right', 1], [fx + 13, fy + 5, 'left', 1], [fx, fy - 6, 'down', 1], [fx, fy + 17, 'up', 1]],
        lounge: [[lx - 21, ly + 3, 'down', 1], [lx - 9, ly + 3, 'down', 1], [lx + 9, ly + 3, 'down', 1], [lx + 21, ly + 3, 'down', 1]],
        gate: [[22, gs + 12, 'down'], [10, gs + 10, 'down'], [34, gs + 10, 'down']],
        pond: [[px - 12, py - pry - 1, 'down', 1], [px, py - pry - 2, 'down', 1], [px + 11, py - pry - 1, 'down', 1], [px - prx - 5, py + 2, 'right', 1]],
      },
      focus: { board: [21, top + 20], rock: [196, top + 18], fire: [fx, fy], lounge: [lx, ly], gate: [22, gs + 22], pond: [px, py] },
      // What nobody stands on: [x, y, w, h].
      solid: [[2, top + 8, 38, 30], [178, top + 6, 37, 24], [fx - 8, fy - 5, 17, 11], [lx - 29, ly - 1, 58, 5], [2, gs + 12, 40, 18]],
      entries: { top: [74, 146], bottom: [78, 142] }, // where paths from above and below may join the loop
    };
  }
  const HUB_W = 220;
  const HUB_MIN = 190; // the hub's height grows with the room there is, between these
  const HUB_MAX = 290;
  const GAP = 24; // between a clearing and the hub's meadow
  const ROW_NEED = 86; // height a row of clearings needs
  const TWO_ROW_NEED = 138; // and two rows of them

  // Seeded randomness, so a trail's clearing looks the same every time.
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  }

  // Smooth noise for patches of lighter and darker grass, and a 4×4 dither to blend them.
  function noise(seed, scale) {
    const at = (i, j) => {
      let h = (seed ^ Math.imul(i, 374761393) ^ Math.imul(j, 668265263)) >>> 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    return (x, y) => {
      const gx = x / scale; const gy = y / scale;
      const i = Math.floor(gx); const j = Math.floor(gy);
      const fx = gx - i; const fy = gy - j;
      const sx = fx * fx * (3 - 2 * fx); const sy = fy * fy * (3 - 2 * fy);
      const a = at(i, j); const b = at(i + 1, j); const c = at(i, j + 1); const d = at(i + 1, j + 1);
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    };
  }
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  // The wind at a column of the map: a slow swell, and on it gusts that cross from the left.
  // 0 is still air, 1 the top of a gust. Crowns, grass and reeds lean a pixel when it blows.
  function gust(x, now) {
    const s = now / 1000;
    const swell = 0.5 + 0.5 * Math.sin(s * 0.21 - x * 0.007);
    const wave = 0.5 + 0.5 * Math.sin(s * 1.25 - x * 0.05);
    return swell * swell * wave;
  }

  // Trees, bushes and the like, lit from the top left, with a soft shadow to the bottom right.
  function blob(g, cx, cy, r, col) {
    g.fillStyle = col;
    for (let j = -r; j <= r; j += 1) { const w = Math.round(Math.sqrt(r * r - j * j + r * 0.6)); g.fillRect(cx - w, cy + j, w * 2 + 1, 1); }
  }
  function shadow(g, cx, cy, rx, ry) {
    g.fillStyle = 'rgba(8,20,14,0.3)';
    for (let j = -ry; j <= ry; j += 1) { const w = Math.round(rx * Math.sqrt(1 - (j / (ry + 0.5)) ** 2)); g.fillRect(cx - w, cy + j, w * 2 + 1, 1); }
  }
  function drawTree(g, x, y, size, rand, shade = true) {
    const r = [6, 7, 9][size];
    if (shade) shadow(g, x + 3, y, r, 2);
    g.fillStyle = P.trunkD; g.fillRect(x - 1, y - 6, 3, 6);
    g.fillStyle = P.trunk; g.fillRect(x - 1, y - 6, 2, 6);
    const cy = y - 5 - r;
    const lobes = [[0, 0, r], [-Math.round(r * 0.55), 2, Math.round(r * 0.7)], [Math.round(r * 0.55), 2, Math.round(r * 0.7)]];
    for (const [dx, dy, rr] of lobes) blob(g, x + dx, cy + dy, rr + 1, P.treeO);
    for (const [dx, dy, rr] of lobes) blob(g, x + dx, cy + dy, rr, P.treeD);
    for (const [dx, dy, rr] of lobes) blob(g, x + dx - 1, cy + dy - 1, rr - 1, P.tree);
    blob(g, x - Math.round(r * 0.3), cy - Math.round(r * 0.35), Math.max(2, Math.round(r * 0.5)), P.treeL);
    g.fillStyle = P.treeH;
    for (let i = 0; i < 4; i += 1) g.fillRect(x - Math.round(r * 0.6) + Math.floor(rand() * r * 0.7), cy - Math.round(r * 0.75) + Math.floor(rand() * r * 0.5), 1, 1);
  }
  function drawPine(g, x, y, shade = true) {
    if (shade) shadow(g, x + 2, y, 5, 2);
    g.fillStyle = P.trunkD; g.fillRect(x, y - 4, 2, 4);
    for (const [dy, w] of [[0, 7], [-5, 5], [-9, 3]]) {
      for (let j = 0; j < 7; j += 1) {
        const half = Math.max(1, Math.round((w * (j + 1)) / 7));
        const yy = y - 10 + dy + j;
        g.fillStyle = P.treeO; g.fillRect(x - half, yy, half * 2 + 2, 1);
        g.fillStyle = j === 6 ? P.pineD : P.pine; g.fillRect(x + 1 - half, yy, half * 2, 1);
        if (j < 6) { g.fillStyle = P.pineL; g.fillRect(x + 1 - half, yy, half, 1); }
      }
    }
    g.fillStyle = P.pineH; g.fillRect(x, y - 18, 1, 1); g.fillRect(x - 2, y - 9, 1, 1);
  }
  function drawBush(g, x, y, r, rand, berries, shade = true) {
    if (shade) shadow(g, x + 2, y + 1, r + 1, 1);
    blob(g, x, y - r, r + 1, P.treeO);
    blob(g, x, y - r, r, P.treeD);
    blob(g, x - 1, y - r - 1, r - 1, P.tree);
    blob(g, x - 2, y - r - 2, Math.max(1, r - 3), P.treeL);
    if (berries) { g.fillStyle = berries; for (let i = 0; i < 3; i += 1) g.fillRect(x - r + 1 + Math.floor(rand() * (2 * r - 1)), y - r - 1 + Math.floor(rand() * r), 1, 1); }
  }
  function drawShroom(g, x, y) {
    g.fillStyle = '#e9dcc4'; g.fillRect(x, y - 2, 1, 2);
    g.fillStyle = '#c4553f'; g.fillRect(x - 1, y - 3, 3, 1); g.fillRect(x, y - 4, 1, 1);
    g.fillStyle = '#f4ece0'; g.fillRect(x - 1, y - 3, 1, 1);
  }
  function drawLog(g, x, y, w) {
    g.fillStyle = P.woodD; g.fillRect(x, y, w, 4);
    g.fillStyle = P.wood; g.fillRect(x, y, w, 1);
    g.fillStyle = '#d2a87c'; g.fillRect(x + w - 3, y, 3, 4);
    g.fillStyle = P.woodD; g.fillRect(x + w - 2, y + 1, 1, 2);
    g.fillStyle = 'rgba(8,20,14,0.3)'; g.fillRect(x + 1, y + 4, w, 1);
  }

  // A winding path between two points, as a line of points about 3 art pixels apart.
  function winding(x0, y0, x1, y1, seed, most = 7) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const waves = len > 80 ? 2 : 1;
    const amp = Math.min(most, len / 8) * (seed % 2 ? 1 : -1);
    const n = Math.max(2, Math.ceil(len / 3));
    const pts = [];
    for (let i = 0; i <= n; i += 1) {
      const s = i / n;
      const e = s * s * (3 - 2 * s);
      pts.push([x0 + (x1 - x0) * e + amp * Math.sin(Math.PI * s) * Math.sin(Math.PI * waves * s), y0 + (y1 - y0) * s]);
    }
    return pts;
  }
  // Where each clearing's paths join the loop, by how many clearings share a side: for each
  // clearing, the points along the loop's side (0 its left end, 1 its right) its paths go to. Never
  // straight in front of it, so the trails' paths cross on the way in; two points make a fork.
  const ROUTES = {
    1: [[[0.2, 0.8]], [[0.05, 0.6]], [[0.4, 0.95]]],
    2: [[[0.8], [0.2]], [[0.65], [0.35]], [[0.9], [0.1, 0.55]], [[0.45, 0.95], [0.1]]],
    3: [[[0.9], [0.5], [0.1]], [[0.5], [0.9], [0.1]], [[0.65], [0.05, 0.95], [0.35]], [[0.9], [0.1], [0.5]]],
  };
  // More on a side: all to the far side (a star), turned round by half, or swapped in pairs.
  function routesFor(n, seed) {
    if (ROUTES[n]) return ROUTES[n][seed % ROUTES[n].length];
    const at = i => [(i + 0.5) / n];
    const ways = [
      Array.from({ length: n }, (_, i) => at(n - 1 - i)),
      Array.from({ length: n }, (_, i) => at((i + Math.floor(n / 2)) % n)),
      Array.from({ length: n }, (_, i) => at((i ^ 1) < n ? i ^ 1 : i)),
    ];
    return ways[seed % ways.length];
  }

  // ---------- where everything goes ----------
  // The hub in the middle, as big as the room allows; half the clearings just above it and the
  // rest just below, with woods beyond. A side's clearings sit in a row; when they don't fit in
  // one, a second row behind it fills the gaps, its paths coming down between the first row's.
  const rowMax = aw => Math.floor(aw / MIN_CLEAR_W);
  const rowFits = (aw, n) => n <= rowMax(aw);
  function need(aw, n) {
    if (!n) return 0;
    if (rowFits(aw, n)) return ROW_NEED;
    return rowMax(aw) >= 2 && n - rowMax(aw) <= rowMax(aw) - 1 ? TWO_ROW_NEED : Infinity;
  }
  function fits(aw, ah, n) {
    const nt = Math.ceil(n / 2);
    return aw >= HUB_W && ah >= HUB_MIN + need(aw, nt) + need(aw, n - nt) + 4;
  }
  function plan(aw, ah, list) {
    const nt = Math.ceil(list.length / 2);
    const nb = list.length - nt;
    const needT = need(aw, nt);
    const needB = need(aw, nb);
    const hh = Math.max(HUB_MIN, Math.min(HUB_MAX, ah - needT - needB - 4));
    const spare = ah - hh - needT - needB;
    const hy = !nt ? Math.floor((ah - hh) / 2) : needT + Math.floor(spare / 2);
    const hx = Math.floor((aw - HUB_W) / 2);
    const hub = hubOf(hh);
    const clearings = [];
    const side = (items, top) => {
      if (!items.length) return;
      const n = items.length;
      const seedAll = hash(items.map(i => i.key).join());
      const edge = top ? hy : hy + hh; // the hub meadow's edge on this side
      const toward = top ? -1 : 1; // away from the hub
      const ey = hy + (top ? hub.top : hub.bot);
      const [e0, e1] = top ? hub.entries.top : hub.entries.bottom;
      const entry = f => hx + Math.round(e0 + (e1 - e0) * f); // f: 0 the left end of the loop's side, 1 the right
      const exitY = (cy, ry) => cy - toward * (ry - 3); // where its paths leave the clearing, toward the hub
      const add = (it, cx, cy, rx, ry, paths) => clearings.push({ ...it, cx, cy, rx, ry, top, seed: hash(it.key), paths });
      if (rowFits(aw, n)) {
        const cw = aw / n;
        const room = top ? hy : ah - hy - hh;
        const ry = Math.max(26, Math.min(34, Math.floor((room - GAP - 10) / 2)));
        const routes = routesFor(n, seedAll);
        items.forEach((it, i) => {
          const rx = Math.max(30, Math.min(50, Math.floor(cw / 2) - 6));
          const cx = Math.round(cw * (i + 0.5));
          const cy = edge + toward * (GAP + ry);
          add(it, cx, cy, rx, ry, routes[i].map((f, j) => winding(cx, exitY(cy, ry), entry(f), ey, hash(it.key) + j)));
        });
        return;
      }
      // Two rows: the near one narrower, to leave gaps; the far one in the gaps, its paths coming
      // down through them and over to the other end of the loop's side, across the near ones'.
      const m = rowMax(aw);
      const far = n - m;
      const cw = aw / m;
      const ry = 27;
      const nearCy = edge + toward * (GAP + ry);
      const farCy = top ? Math.max(10 + ry, nearCy - 2 * ry - 6) : Math.min(ah - 10 - ry, nearCy + 2 * ry + 6);
      const pastY = nearCy - toward * (ry + 6);
      const near = items.slice(0, m);
      const nearRoutes = routesFor(m, seedAll);
      near.forEach((it, i) => {
        const cx = Math.round(cw * (i + 0.5));
        add(it, cx, nearCy, Math.max(28, Math.min(46, Math.floor(cw / 2) - 14)), ry, nearRoutes[i].map((f, j) => winding(cx, exitY(nearCy, ry), entry(f), ey, hash(it.key) + j)));
      });
      const gaps = far === 1 ? [Math.round(m / 2)] : Array.from({ length: far }, (_, k) => 1 + Math.round((k * (m - 2)) / (far - 1)));
      items.slice(m).forEach((it, k) => {
        const cx = Math.round(cw * gaps[k]);
        const seed = hash(it.key);
        add(it, cx, farCy, Math.max(28, Math.min(46, Math.floor(cw / 2) - 4)), ry,
          [winding(cx, exitY(farCy, ry), cx, pastY, seed, 2).concat(winding(cx, pastY, entry(1 - cx / aw), ey, seed + 1, 3).slice(1))]);
      });
    };
    side(list.slice(0, nt), true);
    side(list.slice(nt), false);
    return { hx, hy, hh, hub, clearings };
  }

  // A clearing's furniture and spots, around its middle.
  function clearingLayout(c) {
    const { cx, cy, rx, ry, top } = c;
    const sw = Math.min(2 * rx - 6, 88);
    const sign = { x: cx - Math.round(sw / 2), y: top ? cy - ry - 7 : cy + ry - 4, w: sw, h: 10 };
    const tent = { x: cx - 26, y: cy - 8, w: c.key === 'camp' ? 26 : 22, h: c.key === 'camp' ? 18 : 16 };
    const bench = { x: cx + 5, y: cy + 9, w: 24, h: 3 };
    const places = {
      rest: [[cx + 10, cy + 13, 'down', 1], [cx + 23, cy + 13, 'down', 1], [cx - 22, cy + 19, 'down', 1], [cx - 9, cy + 19, 'down', 1], [cx + 8, cy - 2, 'down', 1], [cx + 22, cy - 1, 'down', 1]],
      start: [[tent.x + Math.round(tent.w / 2), tent.y + tent.h + 3, 'down'], [tent.x + Math.round(tent.w / 2) + 10, tent.y + tent.h + 5, 'down']],
    };
    const solid = [[tent.x - 1, tent.y - 2, tent.w + 2, tent.h + 1], [bench.x, bench.y - 1, bench.w, bench.h + 2], [sign.x - 2, sign.y - 2, sign.w + 4, sign.h + 6]];
    return { sign, tent, bench, places, solid };
  }

  // ---------- the light through the day ----------
  // From the clock: [hour, tint, how much of it, how much lamps glow]. Golden in the late
  // afternoon, blue at night with the lamps lit; window.__journeyHour sets the hour by hand.
  const DAYLIGHT = [
    [0, '#222b57', 0.6, 1], [5, '#2f3866', 0.55, 0.9], [6.5, '#d98f7f', 0.3, 0.45], [8, '#f6d9b8', 0.12, 0],
    [12, '#ffffff', 0, 0], [16, '#ffd9a8', 0.14, 0], [18, '#f09454', 0.32, 0.25], [19.5, '#7d5f95', 0.42, 0.7],
    [21, '#222b57', 0.6, 1], [24, '#222b57', 0.6, 1],
  ];
  function daylight(hour) {
    let i = 0;
    while (i < DAYLIGHT.length - 2 && DAYLIGHT[i + 1][0] <= hour) i += 1;
    const [h0, c0, a0, l0] = DAYLIGHT[i];
    const [h1, c1, a1, l1] = DAYLIGHT[i + 1];
    const f = Math.max(0, Math.min(1, (hour - h0) / (h1 - h0 || 1)));
    const A = rgb(c0); const B = rgb(c1);
    return { tint: A.map((v, j) => Math.round(v + (B[j] - v) * f)), alpha: a0 + (a1 - a0) * f, lamps: l0 + (l1 - l0) * f };
  }
  function hourNow() {
    if (typeof window.__journeyHour === 'number') return window.__journeyHour;
    const d = new Date();
    return d.getHours() + d.getMinutes() / 60;
  }

  // ---------- the paths as a network ----------
  // Lines of path become a graph: wherever two cross, or one ends on another, or a spot hangs
  // off one, there's a node; between nodes, edges that follow the line. Walkers take the
  // shortest way through it.
  function crossing([ax, ay], [bx, by], [cx, cy], [dx, dy]) {
    const rx = bx - ax; const ry = by - ay; const sx = dx - cx; const sy = dy - cy;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
    const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
    return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6 ? [t, u] : null;
  }
  function network(lines, hooks) {
    const nodes = [];
    const node = (x, y, kind) => {
      let i = nodes.findIndex(n => Math.abs(n.x - x) < 2 && Math.abs(n.y - y) < 2);
      if (i < 0) { nodes.push({ x, y, kinds: new Set() }); i = nodes.length - 1; }
      if (kind) nodes[i].kinds.add(kind);
      return i;
    };
    const L = lines.map(l => ({ ...l, pts: l.closed ? [...l.pts, l.pts[0]] : l.pts, cuts: [] }));
    const at = (l, pos) => {
      const i = Math.min(Math.floor(pos), l.pts.length - 2);
      const t = pos - i;
      const [ax, ay] = l.pts[i];
      const [bx, by] = l.pts[i + 1];
      return [ax + (bx - ax) * t, ay + (by - ay) * t];
    };
    const project = (l, x, y) => {
      let best = { pos: 0, d: Infinity };
      for (let i = 0; i < l.pts.length - 1; i += 1) {
        const [ax, ay] = l.pts[i];
        const [bx, by] = l.pts[i + 1];
        const vx = bx - ax; const vy = by - ay;
        const f = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1)));
        const d = Math.hypot(ax + vx * f - x, ay + vy * f - y);
        if (d < best.d) best = { pos: i + f, d };
      }
      return best;
    };
    const cut = (l, pos, n) => {
      const [x, y] = at(l, pos);
      const id = n ?? node(x, y);
      nodes[id].kinds.add(l.kind);
      l.cuts.push({ pos, n: id });
      return id;
    };
    for (const l of L) { l.start = cut(l, 0); l.end = cut(l, l.pts.length - 1); }
    // An end lying on another line joins it there.
    for (const l of L) {
      for (const [k, end] of [[l.start, l.pts[0]], [l.end, l.pts[l.pts.length - 1]]]) {
        for (const m of L) {
          if (m === l) continue;
          const p = project(m, ...end);
          if (p.d < 1.5) cut(m, p.pos, k);
        }
      }
    }
    for (let a = 0; a < L.length; a += 1) {
      for (let b = a + 1; b < L.length; b += 1) {
        const A = L[a]; const B = L[b];
        for (let i = 0; i < A.pts.length - 1; i += 1) {
          for (let j = 0; j < B.pts.length - 1; j += 1) {
            const hit = crossing(A.pts[i], A.pts[i + 1], B.pts[j], B.pts[j + 1]);
            if (hit) cut(B, j + hit[1], cut(A, i + hit[0]));
          }
        }
      }
    }
    const hooked = hooks.map(h => cut(L[h.line], project(L[h.line], h.x, h.y).pos));
    const adj = nodes.map(() => []);
    for (const l of L) {
      const cuts = l.cuts.sort((p, q) => p.pos - q.pos);
      for (let c = 1; c < cuts.length; c += 1) {
        const a = cuts[c - 1];
        const b = cuts[c];
        if (a.n === b.n) continue;
        const pts = [at(l, a.pos)];
        for (let v = Math.floor(a.pos) + 1; v < b.pos; v += 1) pts.push(l.pts[v]);
        pts.push(at(l, b.pos));
        let len = 0;
        for (let k = 1; k < pts.length; k += 1) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
        adj[a.n].push({ to: b.n, pts, len });
        adj[b.n].push({ to: a.n, pts: [...pts].reverse(), len });
      }
    }
    return { nodes, adj, hooked, lines: L };
  }
  // The edges of the shortest way from one node to another.
  function shortest(net, from, to) {
    const n = net.nodes.length;
    const dist = new Array(n).fill(Infinity);
    const prev = new Array(n).fill(null);
    const done = new Uint8Array(n);
    dist[from] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i += 1) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || u === to) break;
      done[u] = 1;
      for (const e of net.adj[u]) if (dist[u] + e.len < dist[e.to]) { dist[e.to] = dist[u] + e.len; prev[e.to] = { e, from: u }; }
    }
    const out = [];
    for (let v = to; v !== from && prev[v]; v = prev[v].from) out.unshift(prev[v].e);
    return out;
  }

  // ---------- drawing the ground: once per layout ----------
  function buildWorld(aw, ah, list) {
    const { hx, hy, hh, hub, clearings } = plan(aw, ah, list);
    const kind = new Uint8Array(aw * ah);
    const blocked = new Uint8Array(aw * ah);
    const inside = (x, y) => x >= 0 && y >= 0 && x < aw && y < ah;
    const set = (x, y, k) => { if (inside(x, y)) kind[y * aw + x] = k; };
    const block = (x, y, w, h) => { for (let j = y; j < y + h; j += 1) for (let i = x; i < x + w; i += 1) if (inside(i, j)) blocked[j * aw + i] = 1; };
    const disc = (x, y, r, k) => {
      for (let j = -r; j <= r; j += 1) for (let i = -r; i <= r; i += 1) if (i * i + j * j <= r * r + r) set(Math.round(x + i), Math.round(y + j), k);
    };
    const rand = rng(hash(list.map(c => c.key).join()) + aw * 31 + ah);
    const [fx, fy] = hub.fire;
    const [lx, ly] = hub.lounge;

    // The paths, as lines: the loop round the hub and each clearing's paths to it.
    const ring = hub.ring.map(([x, y]) => [hx + x, hy + y]);
    const lines = [{ pts: ring, closed: true, kind: 'ring' }];
    for (const c of clearings) { c.line = lines.length; for (const pts of c.paths) lines.push({ pts, kind: 'spoke' }); }
    // Every place in the hub hangs off the loop.
    const hubPlaces = Object.fromEntries(Object.entries(hub.places).map(([spot, list2]) => [spot, list2.map(([x, y, f, s]) => [hx + x, hy + y, f, s])]));
    const hooks = [];
    for (const list2 of Object.values(hubPlaces)) for (const [x, y] of list2) hooks.push({ line: 0, x, y });
    const net = network(lines, hooks);
    let h = 0;
    // A place: [x, y, facing, sitting, aside, node it hangs off].
    for (const spot of Object.keys(hubPlaces)) hubPlaces[spot] = hubPlaces[spot].map(([x, y, f, s]) => [x, y, f, s || 0, 0, net.hooked[h++]]);
    for (const c of clearings) c.exit = net.lines[c.line].start;

    // Open ground: the hub's meadow, each clearing, the paths and the plaza round the fire.
    for (let y = hy - 4; y < hy + hh + 4; y += 1) {
      for (let x = hx - 6; x < hx + HUB_W + 6; x += 1) {
        const u = (x - hx - HUB_W / 2) / (HUB_W / 2 + 5);
        const v = (y - hy - hh / 2) / (hh / 2 + 4);
        if (u ** 4 + v ** 4 <= 1) set(x, y, GROUND.MEADOW);
      }
    }
    for (const c of clearings) {
      const wob = rng(c.seed);
      const bumps = Array.from({ length: 12 }, () => 0.9 + wob() * 0.18);
      for (let y = c.cy - c.ry - 6; y <= c.cy + c.ry + 6; y += 1) {
        for (let x = c.cx - c.rx - 6; x <= c.cx + c.rx + 6; x += 1) {
          const a = Math.atan2(y - c.cy, x - c.cx);
          const b = bumps[Math.floor(((a + Math.PI) / (2 * Math.PI)) * 12) % 12];
          if (((x - c.cx) / (c.rx * b)) ** 2 + ((y - c.cy) / (c.ry * b)) ** 2 <= 1) set(x, y, GROUND.MEADOW);
        }
      }
      Object.assign(c, clearingLayout(c));
      for (const spot of Object.keys(c.places)) c.places[spot] = c.places[spot].map(([x, y, f, s]) => [x, y, f, s || 0, 0, c.exit]);
    }
    for (let y = -18; y <= 18; y += 1) for (let x = -24; x <= 24; x += 1) if ((x / 24) ** 2 + (y / 18) ** 2 <= 1) set(hx + fx + x, hy + fy + y, GROUND.PLAZA);
    const stamp = (pts, r) => {
      for (let i = 1; i < pts.length; i += 1) {
        const [ax, ay] = pts[i - 1];
        const [bx, by] = pts[i];
        const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 1.5);
        for (let s = 0; s <= n; s += 1) disc(ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n, r, GROUND.PATH);
      }
    };
    stamp([...ring, ring[0]], 4);
    const gs = hub.gateStub;
    stamp([[hx + 48, hy + gs], [hx + 22, hy + gs], [hx + 22, hy + gs + 33]], 4);
    for (const l of net.lines.slice(1)) stamp(l.pts, 3);
    const [pondX, pondY, prx, pry] = [hx + hub.pond[0], hy + hub.pond[1], hub.pond[2], hub.pond[3]];
    const pond = (x, y) => ((x - pondX) / prx) ** 2 + ((y - pondY) / pry) ** 2 <= 1;
    for (let y = pondY - pry - 2; y < pondY + pry + 2; y += 1) for (let x = pondX - prx - 2; x < pondX + prx + 2; x += 1) if (pond(x, y)) set(x, y, GROUND.WATER);

    // Paint the ground a pixel at a time: patches of grass blended with a dither, the paths with
    // a ragged edge where the grass creeps in, the pond deeper in the middle.
    const cv = document.createElement('canvas');
    cv.width = aw; cv.height = ah;
    const g = cv.getContext('2d');
    const img = g.createImageData(aw, ah);
    const seed0 = hash(list.map(c => c.key).join());
    const big = noise(seed0 + 1, 11);
    const small = noise(seed0 + 2, 4);
    const C = {
      forest: P.forest.map(rgb), grass: P.grass.map(rgb), path: rgb(P.path), pathD: rgb(P.pathD), pathL: rgb(P.pathL), edge: rgb(P.pathEdge),
      plaza: rgb(P.plaza), water: rgb(P.water), waterS: rgb(P.waterS), deep: rgb(P.waterDeep), foam: rgb(P.waterL), sand: rgb(P.sand),
    };
    const k = (x, y) => (inside(x, y) ? kind[y * aw + x] : GROUND.FOREST);
    const dirt = n => n === GROUND.PATH || n === GROUND.PLAZA;
    const [px, py] = [pondX, pondY];
    for (let y = 0; y < ah; y += 1) {
      for (let x = 0; x < aw; x += 1) {
        const here = kind[y * aw + x];
        const r = rand();
        const v = big(x, y) * 0.75 + small(x, y) * 0.25 + (BAYER[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * 0.3;
        const tone = Math.max(0, Math.min(2, Math.floor(v * 3)));
        let col;
        if (here === GROUND.WATER) {
          const e = ((x - px) / prx) ** 2 + ((y - py) / pry) ** 2;
          col = k(x, y - 1) !== GROUND.WATER ? C.foam : e > 0.62 ? C.waterS : e > 0.25 ? C.water : C.deep;
        } else if (dirt(here)) {
          const edge = !dirt(k(x - 1, y)) || !dirt(k(x + 1, y)) || !dirt(k(x, y - 1)) || !dirt(k(x, y + 1));
          if (edge && r < 0.3) col = C.grass[tone];
          else if (edge) col = C.pathD;
          else col = r < 0.06 ? C.pathD : r < 0.13 ? C.pathL : here === GROUND.PLAZA ? C.plaza : C.path;
        } else if ([k(x - 1, y), k(x + 1, y), k(x, y - 1), k(x, y + 1)].some(dirt)) col = C.edge;
        else if ([k(x - 1, y), k(x + 1, y), k(x, y - 1), k(x, y + 2), k(x - 2, y), k(x + 2, y)].some(n => n === GROUND.WATER)) col = C.sand;
        else col = here === GROUND.MEADOW ? C.grass[tone] : C.forest[tone];
        const o = (y * aw + x) * 4;
        img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    const R = (x, y, w, hgt, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, hgt); };
    const H = (x, y, w, hgt, c) => R(hx + x, hy + y, w, hgt, c);
    const lights = []; // [x, y, radius, [r, g, b], flicker]
    const blooms = []; // flowers, where butterflies go

    // Grass tufts, thicker in the lighter patches, and flowers in little clusters. A tuft's
    // roots are painted here; its tips are drawn every frame, to bend with the wind.
    const tufts = [];
    for (let i = 0; i < (aw * ah) / 90; i += 1) {
      const x = Math.floor(rand() * aw); const y = Math.floor(rand() * ah);
      if (k(x, y) !== GROUND.MEADOW || k(x + 2, y + 2) !== GROUND.MEADOW || k(x - 1, y + 2) !== GROUND.MEADOW) continue;
      if (big(x, y) < 0.35 && rand() < 0.6) continue;
      const c = rand() < 0.35 ? P.tuftL : P.tuft;
      R(x, y + 1, 1, 1, c); R(x + 2, y + 1, 1, 1, c); R(x + 1, y, 1, 2, c);
      tufts.push([x, y, c]);
    }
    for (let i = 0; i < (aw * ah) / 1400; i += 1) {
      const x = Math.floor(rand() * aw); const y = Math.floor(rand() * ah);
      if (k(x, y) !== GROUND.MEADOW) continue;
      const c = P.flower[[0, 1, 3, 4][Math.floor(rand() * 4)]];
      const n = 3 + Math.floor(rand() * 4);
      for (let j = 0; j < n; j += 1) {
        const fx2 = x + Math.floor(rand() * 9) - 4; const fy2 = y + Math.floor(rand() * 7) - 3;
        if (k(fx2, fy2) !== GROUND.MEADOW || k(fx2, fy2 + 1) !== GROUND.MEADOW) continue;
        R(fx2, fy2 + 1, 1, 1, P.tuft); R(fx2 - 1, fy2, 3, 1, c); R(fx2, fy2 - 1, 1, 3, c); R(fx2, fy2, 1, 1, P.flower[0]);
      }
      blooms.push([x, y]);
    }
    // Pebbles on the paths.
    for (let i = 0; i < (aw * ah) / 500; i += 1) {
      const x = Math.floor(rand() * aw); const y = Math.floor(rand() * ah);
      if (k(x, y) === GROUND.PATH && k(x + 1, y) === GROUND.PATH && k(x, y + 1) === GROUND.PATH) { R(x, y, 2, 1, '#c9b38c'); R(x, y + 1, 2, 1, P.pathD); }
    }

    // The hub's furniture, each piece drawn where hubOf puts it. The trail kiosk: a map on two
    // posts, under a little roof;
    const K = (x, y, w, hgt, c) => H(x + hub.kiosk[0], y + hub.kiosk[1], w, hgt, c);
    K(13, 8, 2, 26, P.woodD); K(39, 8, 2, 26, P.woodD); K(13, 8, 1, 26, P.wood);
    K(10, 9, 34, 17, P.woodD); K(11, 10, 32, 15, P.paper);
    K(13, 12, 8, 4, '#a9c48c'); K(14, 19, 7, 4, '#a9c48c'); K(27, 15, 13, 6, '#93c3d6'); K(29, 16, 9, 1, '#b7dbe6');
    for (let i = 0; i < 14; i += 1) if (i % 2 === 0) K(13 + i * 2, 18 - Math.round(i * 0.35), 1, 1, '#b0563f'); // the trail, dotted
    K(11, 10, 32, 1, 'rgba(60,40,20,0.25)');
    for (let j = 0; j < 7; j += 1) {
      const half = Math.min(19, 5 + j * 3);
      K(27 - half, 2 + j, half * 2, 1, j === 6 ? P.woodD : j % 2 ? P.roof : P.roofL);
    }
    K(26, 1, 2, 1, P.roofL);
    // the rock: a mossy boulder with a flat top to sit on, and pebbles round it;
    const Rk = (x, y, w, hgt, c) => H(x + hub.rockAt[0], y + hub.rockAt[1], w, hgt, c);
    Rk(134, 31, 36, 3, 'rgba(8,20,14,0.3)');
    for (let j = -10; j <= 10; j += 1) {
      const w = Math.round(17 * Math.sqrt(1 - (j / 10.5) ** 2));
      Rk(150 - w, 21 + j, w * 2, 1, j > 4 ? P.stoneD : j < -5 ? P.stoneL : P.stone);
      if (j > -10 && j < 6) { Rk(150 - w, 21 + j, 1, 1, P.stoneD); }
    }
    for (let i = 0; i < 9; i += 1) Rk(140 + i * 2 + (i % 2), 11 + (i % 3 === 0 ? 0 : 1), 2, 1, P.moss);
    Rk(137, 13, 5, 1, '#d5d9dd'); Rk(158, 24, 6, 1, P.stoneD); Rk(143, 27, 4, 1, P.stoneD); Rk(152, 20, 1, 4, P.stoneD);
    for (const [x, y] of [[130, 30], [170, 28], [166, 33]]) { Rk(x, y, 3, 2, P.stone); Rk(x, y, 2, 1, P.stoneL); }
    // the campfire: crossed logs in a ring of stones, and two logs to sit on;
    for (let i = 0; i < 12; i += 1) {
      const t = (i / 12) * Math.PI * 2;
      const sx = Math.round(fx + Math.cos(t) * 8) - 1; const sy = Math.round(fy + Math.sin(t) * 5) - 1;
      H(sx, sy, 3, 2, i % 3 ? P.stone : P.stoneD); H(sx, sy, 2, 1, P.stoneL);
    }
    H(fx - 4, fy - 1, 9, 3, '#2a1f18');
    for (let i = 0; i < 7; i += 1) { H(fx - 3 + i, fy - 1 + Math.floor(i / 3), 1, 1, '#4a3222'); H(fx + 3 - i, fy - 1 + Math.floor(i / 3), 1, 1, '#4a3222'); }
    drawLog(g, hx + fx - 21, hy + fy + 4, 12); drawLog(g, hx + fx + 9, hy + fy + 4, 12);
    lights.push([hx + fx, hy + fy - 2, 34, [255, 170, 90], 1]);
    // the deck where those who've finished rest: planks, two benches, a lantern, and a string of
    // little lights between its corner posts;
    H(lx - 33, ly - 9, 66, 18, P.woodD);
    for (let j = ly - 8, row = 0; j < ly + 8; j += 3, row += 1) {
      H(lx - 32, j, 64, 2, P.wood);
      for (let x = (row % 2 ? 8 : 0); x < 64; x += 16) H(lx - 32 + x, j, 1, 2, P.woodD);
    }
    H(lx - 33, ly - 9, 66, 1, P.woodL); H(lx - 33, ly + 9, 66, 1, 'rgba(8,20,14,0.35)');
    for (const x of [lx - 33, lx + 31]) { H(x, ly - 16, 2, 8, P.woodD); H(x, ly - 16, 1, 8, P.wood); }
    for (const x of [lx - 28, lx + 4]) {
      H(x, ly - 3, 24, 2, P.woodD); H(x, ly - 3, 24, 1, P.wood); // the backs
      H(x, ly + 1, 24, 3, P.woodL); H(x, ly + 1, 24, 1, '#d8a674');
      H(x + 1, ly + 4, 2, 2, P.woodD); H(x + 21, ly + 4, 2, 2, P.woodD);
    }
    H(lx, ly - 16, 1, 15, '#3a3a40'); H(lx - 2, ly - 19, 5, 4, '#3a3a40'); H(lx - 1, ly - 18, 3, 2, '#ffd27a');
    lights.push([hx + lx, hy + ly - 17, 18, [255, 205, 120], 0]);
    const strand = (x0, y0, x1, y1) => {
      const n = Math.round(Math.abs(x1 - x0));
      for (let i = 0; i <= n; i += 1) {
        const s = i / n;
        const x = Math.round(x0 + (x1 - x0) * s);
        const y = Math.round(y0 + (y1 - y0) * s + Math.sin(Math.PI * s) * 3);
        H(x, y, 1, 1, '#3a3328');
        if (i % 4 === 2) {
          const c = P.bulbs[(i / 4 + (x0 < x1 ? 0 : 1)) % P.bulbs.length | 0];
          H(x, y + 1, 1, 1, c);
          lights.push([hx + x, hy + y + 1, 4, rgb(c), 0]);
        }
      }
    };
    strand(lx - 32, ly - 16, lx - 1, ly - 18); strand(lx + 1, ly - 18, lx + 31, ly - 16);
    // the fence across the stub of path, and the posts the gate hangs between (the gate moves);
    const G = (x, y, w, hgt, c) => H(x + hub.gateAt[0], y, w, hgt, c);
    const gb = hub.gateAt[1];
    for (const y of [gb + 21, gb + 26]) { G(12, y, 11, 2, P.wood); G(38, y, 11, 2, P.wood); G(12, y, 11, 1, P.woodL); G(38, y, 11, 1, P.woodL); }
    for (const x of [11, 47]) { G(x, gb + 17, 2, 14, P.woodD); G(x, gb + 17, 2, 1, P.woodL); }
    for (const x of [21, 37]) { G(x, gb + 15, 3, 17, P.woodD); G(x, gb + 15, 3, 1, P.woodL); }
    G(11, gb + 31, 38, 1, 'rgba(8,20,14,0.3)');
    for (const [x, y, c] of [[9, gb + 30, 1], [50, gb + 29, 3], [15, gb + 32, 4]]) { G(x - 1, y, 3, 1, P.flower[c]); G(x, y - 1, 1, 3, P.flower[c]); G(x, y, 1, 1, P.flower[0]); }
    // the pond: lily pads, one in flower, reeds and a few stones on the bank;
    const [pcx, pcy] = hub.pond;
    for (const [x, y, f] of [[pcx - 9, pcy - 2, 1], [pcx + 9, pcy + 5, 0], [pcx + 2, pcy + 8, 0]]) {
      H(x - 2, y, 5, 2, P.lily); H(x - 1, y - 1, 3, 1, P.lily); H(x, y, 1, 1, P.lilyD); H(x - 2, y + 1, 5, 1, P.lilyD);
      if (f) { H(x, y - 1, 1, 1, '#f6c3d6'); H(x - 1, y, 1, 1, '#f6c3d6'); H(x + 1, y, 1, 1, '#f6c3d6'); }
    }
    const reeds = [[-19, -7], [-17, -9], [-15, -6], [18, 4], [20, 2], [21, 5]].map(([x, y]) => [hx + pcx + x, hy + pcy + y]);
    for (const [x, y] of reeds) R(x, y + 3, 1, 3, '#5f8a3e'); // their tops sway (live)
    for (const [x, y] of [[pcx - 21, pcy + 2], [pcx + 21, pcy + 10], [pcx - 13, pcy + 11]]) { H(x, y, 3, 2, P.stone); H(x, y, 2, 1, P.stoneL); }
    // and a tree or two inside the loop when there's room (drawn with the woods, below).
    const hubTrees = ly - fy >= 44 ? [lx - 44, lx + 44].map(x => [hx + x, hy + Math.round((fy + ly) / 2) + 8, 0.6]) : [];

    // Each clearing: a tent in the trail's own colour with a lantern by it, a log to sit on, flowers
    // and the sign with the trail's name.
    for (const c of clearings) {
      const { tent, bench, sign } = c;
      const [light, dark] = c.key === 'camp' ? ['#e3cb98', '#bfa677'] : P.tents[c.seed % P.tents.length];
      const mid = tent.x + Math.round(tent.w / 2);
      R(tent.x - 1, tent.y + tent.h, tent.w + 4, 2, 'rgba(8,20,14,0.3)');
      for (let j = 0; j < tent.h; j += 1) {
        const w = Math.max(2, Math.round(((j + 1) / tent.h) * tent.w));
        const x0 = tent.x + Math.round((tent.w - w) / 2);
        R(x0, tent.y + j, Math.ceil(w / 2), 1, light);
        R(x0 + Math.ceil(w / 2), tent.y + j, Math.floor(w / 2), 1, dark);
        R(x0 - 1, tent.y + j, 1, 1, '#3a2e22'); R(x0 + w, tent.y + j, 1, 1, '#3a2e22');
      }
      const door = Math.round(tent.h * 0.55);
      for (let j = 0; j < door; j += 1) {
        const w = Math.max(1, Math.round(((j + 1) / door) * (tent.w / 3)));
        R(mid - Math.floor(w / 2), tent.y + tent.h - door + j, w, 1, '#2b2119');
      }
      R(mid, tent.y - 2, 1, 3, P.woodD);
      for (let i = 0; i < 4; i += 1) { R(tent.x - 1 - i, tent.y + 5 + i * 3, 1, 1, '#d6cdb8'); R(tent.x + tent.w + i, tent.y + 5 + i * 3, 1, 1, '#d6cdb8'); }
      if (c.key === 'camp') { R(mid, tent.y - 12, 1, 11, P.woodD); R(mid + 1, tent.y - 12, 7, 4, '#c0473a'); R(mid + 1, tent.y - 12, 7, 1, '#d8665a'); }
      // the lantern on its post, at the tent's left;
      const lpx = tent.x - 5;
      const lpy = tent.y + tent.h;
      R(lpx, lpy - 9, 1, 9, '#3a3a40'); R(lpx - 1, lpy - 12, 3, 3, '#3a3a40'); R(lpx, lpy - 11, 1, 1, '#ffd27a');
      lights.push([lpx, lpy - 11, 13, [255, 200, 110], 0]);
      drawLog(g, bench.x, bench.y - 1, bench.w);
      R(sign.x + 3, sign.y + sign.h, 2, 5, P.woodD); R(sign.x + sign.w - 5, sign.y + sign.h, 2, 5, P.woodD);
      R(sign.x, sign.y, sign.w, sign.h, P.woodD); R(sign.x + 1, sign.y + 1, sign.w - 2, sign.h - 2, P.wood); R(sign.x, sign.y, sign.w, 1, P.woodL);
      R(sign.x + 2, sign.y + 2, 1, 1, '#3a2a1c'); R(sign.x + sign.w - 3, sign.y + 2, 1, 1, '#3a2a1c');
      R(sign.x, sign.y + sign.h, sign.w, 1, 'rgba(8,20,14,0.3)');
      for (const s of c.solid) block(...s);
      block(lpx - 1, lpy - 6, 3, 7);
    }

    // The edge of the woods: bushes, some with berries, where the open ground meets the trees.
    const edgeOf = (x, y) => {
      if (k(x, y) !== GROUND.FOREST) return false;
      let meadow = false;
      for (let j = -4; j <= 5; j += 1) for (let i = -5; i <= 5; i += 1) { const n = k(x + i, y + j); if (dirt(n) || n === GROUND.WATER) return false; if (n === GROUND.MEADOW) meadow = true; }
      return meadow && !clearings.some(c => x > c.sign.x - 6 && x < c.sign.x + c.sign.w + 6 && y > c.sign.y - 4 && y < c.sign.y + c.sign.h + 10);
    };
    const bushes = [];
    for (let i = 0; i < (aw * ah) / 60; i += 1) {
      const x = Math.floor(rand() * aw); const y = Math.floor(rand() * ah);
      if (edgeOf(x, y) && !bushes.some(([bx, by]) => Math.abs(bx - x) < 7 && Math.abs(by - y) < 5)) bushes.push([x, y]);
    }

    // Trees wherever the ground is closed, back to front, with the bushes among them.
    const trees = [];
    const open = (x, y) => {
      for (let j = y - 19; j <= y + 2; j += 3) for (let i = x - 8; i <= x + 8; i += 4) if (k(i, j) !== GROUND.FOREST) return true;
      return clearings.some(c => x > c.sign.x - 10 && x < c.sign.x + c.sign.w + 10 && y > c.sign.y - 4 && y < c.sign.y + c.sign.h + 22);
    };
    for (let y = 4, r = 0; y < ah + 22; y += 10, r += 1) {
      for (let x = (r % 2 ? 6 : 0) - 4; x < aw + 10; x += 12) {
        const tx = x + Math.floor(rand() * 5) - 2;
        const ty = y + Math.floor(rand() * 4);
        if (!open(tx, ty)) trees.push([tx, ty, rand()]);
      }
    }
    // Each tree and bush is drawn once into an atlas, its shadow on the ground; the map draws them
    // every frame from there, back to front, so the top of a crown can lean when a gust goes by.
    // [x, y] is the foot; [ox, oy, w, h] its picture's box from there; `cut` the rows that lean.
    const flora = [];
    for (const [x, y, r] of [...trees, ...hubTrees]) {
      if (r < 0.33) { flora.push({ x, y, type: 'pine', ox: -9, oy: -21, w: 20, h: 22, cut: 10 }); continue; }
      const size = r > 0.75 ? 2 : r > 0.5 ? 1 : 0;
      const rr = [6, 7, 9][size];
      flora.push({ x, y, type: 'tree', size, ox: -15, oy: -(2 * rr + 8), w: 31, h: 2 * rr + 9, cut: rr + 3 });
    }
    for (const [x, y] of bushes) {
      const r = 3 + Math.floor(rand() * 2);
      flora.push({ x, y, type: 'bush', r, berries: rand() < 0.3 ? (rand() < 0.5 ? '#c4553f' : '#8a7bd0') : null, ox: -8, oy: -(2 * r + 3), w: 17, h: 2 * r + 5, cut: r });
    }
    flora.sort((a, b) => a.y - b.y);
    const atlas = document.createElement('canvas');
    let ax = 0; let ay = 0; let rowH = 0;
    for (const f of flora) {
      if (ax + f.w > 512) { ax = 0; ay += rowH; rowH = 0; }
      f.sx = ax; f.sy = ay; ax += f.w; rowH = Math.max(rowH, f.h);
      f.ph = Math.floor(rand() * 9); // not every crown in a column moves at once
    }
    atlas.width = 512; atlas.height = Math.max(1, ay + rowH);
    const ag = atlas.getContext('2d');
    for (const f of flora) {
      ag.save();
      ag.beginPath(); ag.rect(f.sx, f.sy, f.w, f.h); ag.clip();
      const x = f.sx - f.ox; const y = f.sy - f.oy;
      if (f.type === 'pine') { shadow(g, f.x + 2, f.y, 5, 2); drawPine(ag, x, y, false); }
      else if (f.type === 'tree') { shadow(g, f.x + 3, f.y, [6, 7, 9][f.size], 2); drawTree(ag, x, y, f.size, rand, false); }
      else { shadow(g, f.x + 2, f.y + 1, f.r + 1, 1); drawBush(ag, x, y, f.r, rand, f.berries, false); }
      ag.restore();
    }
    const shrooms = [];
    for (let i = 0; i < trees.length; i += 7) { const [x, y] = trees[i]; if (k(x + 4, y + 2) === GROUND.FOREST) shrooms.push([x + 4, y + 2]); }
    // Leaves come off the trees at the edge of the woods, where they can be seen drifting.
    const edgeTrees = trees.filter(([x, y]) => [k(x + 10, y + 4), k(x + 16, y + 10), k(x + 6, y + 12)].includes(GROUND.MEADOW));
    for (const [x, y] of trees) block(x - 7, y - 12, 15, 15);
    for (const [x, y] of bushes) block(x - 4, y - 4, 9, 6);
    for (const [x, y] of hubTrees) block(x - 7, y - 12, 15, 15);
    // A tuft's tips are drawn live only where nothing was painted over them since.
    const final = g.getImageData(0, 0, aw, ah).data;
    const bare = (x, y) => { if (!inside(x, y)) return false; const o = (y * aw + x) * 4; return final[o] === img.data[o] && final[o + 1] === img.data[o + 1] && final[o + 2] === img.data[o + 2]; };
    const tuftsBy = new Map();
    for (const [x, y, c] of tufts) {
      if (![[x, y], [x + 2, y], [x + 3, y], [x + 1, y - 1], [x + 2, y - 1]].every(([i, j]) => bare(i, j))) continue;
      if (!tuftsBy.has(c)) tuftsBy.set(c, []);
      tuftsBy.get(c).push([x, y]);
    }
    // Where fireflies drift at night: over the open ground, near the trees.
    const glades = [];
    for (let i = 0; i < 400 && glades.length < 18; i += 1) {
      const x = Math.floor(rand() * aw); const y = Math.floor(rand() * ah);
      if (k(x, y) === GROUND.MEADOW && [k(x - 9, y), k(x + 9, y), k(x, y - 9), k(x, y + 9)].includes(GROUND.FOREST)) glades.push([x, y, rand() * 6.28, 0.5 + rand()]);
    }

    for (let i = 0; i < aw * ah; i += 1) if (kind[i] === GROUND.WATER) blocked[i] = 1;
    for (const [x, y, w, hgt] of hub.solid) block(hx + x, hy + y, w, hgt);
    // Where those thinking wander: the loop, and the crossings and forks of the paths.
    const exits = new Set(clearings.map(c => c.exit));
    const stroll = net.nodes.map((n, i) => [n, i]).filter(([n, i]) => !exits.has(i) && (n.kinds.has('ring') || net.adj[i].length >= 3)).map(([, i]) => i);
    return {
      aw, ah, hx, hy, hh, hub, hubPlaces, net, stroll, clearings, kind, blocked, canvas: cv, lights, blooms, glades, pond: [pondX, pondY, prx, pry],
      flora, atlas, shrooms, edgeTrees, reeds, tufts: [...tuftsBy],
    };
  }

  function create(host, { mode = 'map', onOpen = () => {}, onCamp = () => {} } = {}) {
    const canvas = document.createElement('canvas');
    canvas.className = 'journey-canvas';
    const tip = document.createElement('div');
    tip.className = 'journey-tip';
    tip.hidden = true;
    host.append(canvas, tip);
    const ctx = canvas.getContext('2d');
    const art = document.createElement('canvas');
    const g = art.getContext('2d');

    let people = [];
    let world = null; // the ground, the paths and where everything is, for this size and these clearings
    let worldKey = '';
    let builtAt = 0;
    let geo = null;
    const walkers = new Map(); // session or run id → walker (or wanderer)
    const bags = new Map(); // run id → { x, y, home, p, at }: what a wanderer left
    const met = new Map(); // "a|b" → when they last said hello
    let timer = 0;
    let hover = null;
    let dirty = true;
    let lastIds = '';

    const homeOf = p => p.trailId || 'camp';
    let camps = []; // the trails, each with its camp: [{ key, title, order }]
    let hoverCamp = null; // the clearing whose tent is under the pointer
    // The clearings there should be: a trail's while it has live sessions, then the base camp.
    function clearingList() {
      const seen = new Map();
      for (const c of camps) seen.set(c.key, { key: c.key, title: c.title || 'Trail', order: c.order ?? 0 });
      if (camps.length || mode === 'map') seen.set('camp', { key: 'camp', title: 'Base camp', order: Infinity });
      // Someone out on a trail that has no camp any more (archived since) still has their clearing.
      for (const p of people) {
        const key = homeOf(p);
        if (!seen.has(key)) seen.set(key, { key, title: key === 'camp' ? 'Base camp' : p.trailTitle || 'Trail', order: key === 'camp' ? Infinity : p.trailOrder ?? 0 });
      }
      return [...seen.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    }
    const clearing = key => world?.clearings.find(c => c.key === key);
    const nodeXY = n => [world.net.nodes[n].x, world.net.nodes[n].y];

    // --- where a walker goes ---
    const areaOf = (w, spot) => (HUB_SPOTS.has(spot) ? 'hub' : w.home);
    function placesOf(w, spot) {
      if (HUB_SPOTS.has(spot)) return world.hubPlaces[spot] || [];
      return clearing(w.home)?.places[spot] || [];
    }
    function slotFor(w, spot) {
      const area = areaOf(w, spot);
      const taken = new Set([...walkers.values()].filter(o => o !== w && o.spot === spot && areaOf(o, o.spot) === area && o.slot != null).map(o => o.slot));
      let i = 0;
      while (taken.has(i)) i += 1;
      return i;
    }
    function free(x, y) {
      x = Math.round(x); y = Math.round(y);
      if (x < 4 || y < 18 || x >= world.aw - 4 || y >= world.ah - 2) return false;
      const k = world.kind[y * world.aw + x];
      return k !== GROUND.FOREST && k !== GROUND.WATER && !world.blocked[y * world.aw + x];
    }
    function nearestNode(x, y, kind) {
      let best = 0;
      let d = Infinity;
      world.net.nodes.forEach((n, i) => {
        if (kind && !n.kinds.has(kind)) return;
        const dd = Math.hypot(n.x - x, n.y - y);
        if (dd < d) { d = dd; best = i; }
      });
      return best;
    }
    // A place: [x, y, facing, sitting, aside, node]. Past the spot's own places, the nearest free
    // bit of ground, looking at what they came for.
    function placeFor(w, spot, slot) {
      if (spot === 'drop') return [w.bagAt[0] - 6, w.bagAt[1] + 1, 'right', 0, 0, clearing(w.home)?.exit ?? 0];
      if (spot === 'ring') { const n = w.wander ?? world.stroll[0]; return [...nodeXY(n), 'down', 0, 0, n]; }
      const places = placesOf(w, spot);
      if (slot < places.length) return places[slot];
      const [ax, ay, facing, sit, , node] = places[0] || [world.aw / 2, world.ah / 2, 'down', 0, 0, 0];
      const f = world.hub.focus[spot];
      const focus = HUB_SPOTS.has(spot) && f ? [world.hx + f[0], world.hy + f[1]] : null;
      const near = ([x, y]) => [...walkers.values()].some(o => o !== w && o.goal && o.spot !== 'ring' && Math.abs(o.goal[0] - x) < 9 && Math.abs(o.goal[1] - y) < 9)
        || places.some(([px0, py0]) => Math.abs(px0 - x) < 9 && Math.abs(py0 - y) < 9);
      const cand = [];
      for (let dy = -42; dy <= 42; dy += 7) for (let dx = -42; dx <= 42; dx += 7) cand.push([ax + dx, ay + dy]);
      cand.sort((p, q) => Math.hypot(p[0] - ax, p[1] - ay) - Math.hypot(q[0] - ax, q[1] - ay));
      const [x, y] = cand.find(p => free(...p) && !near(p)) || [ax + 5 * (slot % 4) - 7, ay + 3];
      const face = focus ? (Math.abs(focus[0] - x) > Math.abs(focus[1] - y) ? (focus[0] > x ? 'right' : 'left') : focus[1] > y ? 'down' : 'up') : facing;
      return [x, y, face, sit, 1, HUB_SPOTS.has(spot) ? nearestNode(x, y, 'ring') : node];
    }

    // Put a walker straight at its spot (on opening, and when the map is laid out anew).
    function snap(w, now) {
      if (w.spot === 'ring') w.wander = world.stroll[Math.floor(Math.random() * world.stroll.length)];
      w.slot = w.spot === 'ring' ? null : slotFor(w, w.spot);
      const [x, y, facing, sit, aside, node] = placeFor(w, w.spot, w.slot);
      Object.assign(w, { x, y, goal: [x, y], facing, sit: !!sit, aside: !!aside, node, legs: [], trail: [], pets: [], arrived: now - MIN_DWELL, pause: 0 });
    }

    // Send a walker somewhere, the shortest way along the paths: to the node its place hangs
    // off, along the edges, and the last steps to the place.
    function go(w, spot, now, wanderTo) {
      const strolling = spot === 'ring' && w.spot === 'ring' && !w.legs.length;
      w.spot = spot;
      w.slot = spot === 'ring' ? null : slotFor(w, spot);
      if (spot === 'ring') w.wander = wanderTo ?? nearestNode(w.x, w.y, 'ring');
      const [tx, ty, facing, sit, aside, to] = placeFor(w, spot, w.slot);
      const legs = [];
      let from;
      // Heading for a node already: get there first. Otherwise back to the node they're by.
      if (w.legs.length && w.legs[0].node != null) { legs.push(w.legs[0]); from = w.legs[0].node; } else {
        from = w.node ?? nearestNode(w.x, w.y);
        const [nx, ny] = nodeXY(from);
        if (Math.hypot(nx - w.x, ny - w.y) > 0.5) legs.push({ pts: [[nx, ny]], node: from });
      }
      for (const e of shortest(world.net, from, to)) legs.push({ pts: e.pts.slice(1), node: e.to });
      if (spot !== 'ring') legs.push({ pts: [[tx, ty]], node: null });
      w.legs = legs;
      w.goal = [tx, ty];
      w.facing = facing || 'down';
      w.sit = !!sit;
      w.aside = !!aside;
      let len = 0;
      let [lx, ly] = [w.x, w.y];
      for (const leg of legs) for (const [x, y] of leg.pts) { len += Math.hypot(x - lx, y - ly); lx = x; ly = y; }
      // A walk, never a run: a stroll when thinking, a little brisker to get somewhere.
      w.speed = strolling ? 21 : Math.max(26, Math.min(40, len / 3.2));
      w.arrived = 0;
    }
    function wander(w, now) {
      const here = [w.x, w.y];
      const far = world.stroll.filter(n => Math.hypot(world.net.nodes[n].x - here[0], world.net.nodes[n].y - here[1]) > 30);
      const pick = far.length ? far : world.stroll;
      go(w, 'ring', now, pick[Math.floor(Math.random() * pick.length)]);
    }

    // --- wanderers: out of the woods, to work, a bag left in the clearing, back into the woods ---
    // Where they come out and go back in: off the clearing's outer side, below the tent on the
    // left, above the bench on the right.
    function woodsOf(c) {
      const s = c.cx < world.aw / 2 ? -1 : 1;
      const y = c.cy + (s < 0 ? 12 : 3);
      return { inner: [c.cx + s * (c.rx - 10), y], woods: [Math.max(3, Math.min(world.aw - 3, c.cx + s * (c.rx + 16))), y] };
    }
    function enter(w, want, now) {
      const c = clearing(w.home);
      const { inner, woods } = woodsOf(c);
      [w.x, w.y] = woods;
      Object.assign(w, { goal: null, facing: 'down', sit: false, aside: false, node: c.exit, legs: [], trail: [], pets: [], arrived: 0, pause: 0, woods, spot: null });
      go(w, want, now);
      w.legs.unshift({ pts: [inner], node: null });
    }
    // A session's walker lives in its tent: out of it when the session starts or is resumed, back
    // into it when the session ends. The door, inside, and the spot just outside it.
    function doorOf(c) {
      const mid = c.tent.x + Math.round(c.tent.w / 2);
      return { inside: [mid, c.tent.y + c.tent.h - 2], out: [mid, c.tent.y + c.tent.h + 3] };
    }
    function outOfTent(w, want, now) {
      const c = clearing(w.home);
      w.spot = 'start';
      snap(w, now);
      const place = [w.x, w.y];
      const { inside, out } = doorOf(c);
      [w.x, w.y] = inside;
      w.woods = inside;
      w.fadeLen = 5;
      if (want === 'start') { Object.assign(w, { legs: [{ pts: [out, place], node: null }], goal: place, speed: 16, arrived: 0 }); return; }
      go(w, want, now);
      w.legs.unshift({ pts: [out], node: null });
    }
    // Leaving the map: a wanderer back into the woods, a walker back into their tent. From where
    // they are in the clearing straight there; from anywhere else, along the paths to it first.
    function leave(w, now) {
      const c = clearing(w.home);
      if (!c) { walkers.delete(w.id); return; }
      const last = w.run ? (({ inner, woods }) => [inner, woods])(woodsOf(c)) : (({ out, inside }) => [out, inside])(doorOf(c));
      const legs = [];
      const home = !w.legs.length && w.node === c.exit && !HUB_SPOTS.has(w.spot);
      if (!home) {
        let from;
        if (w.legs.length && w.legs[0].node != null) { legs.push(w.legs[0]); from = w.legs[0].node; } else {
          from = w.node ?? nearestNode(w.x, w.y);
          legs.push({ pts: [nodeXY(from)], node: from });
        }
        for (const e of shortest(world.net, from, c.exit)) legs.push({ pts: e.pts.slice(1), node: e.to });
      }
      legs.push({ pts: last, node: null });
      let len = 0;
      let [lx, ly] = [w.x, w.y];
      for (const leg of legs) for (const [x, y] of leg.pts) { len += Math.hypot(x - lx, y - ly); lx = x; ly = y; }
      Object.assign(w, {
        legs, goal: last[1], woods: last[1], fadeLen: w.run ? 14 : 5, spot: 'out', slot: null, sit: false, leaving: true, pending: null, chat: null, arrived: 0,
        speed: Math.max(home ? 18 : 26, Math.min(40, len / 3.2)),
      });
    }
    // A free bit of the clearing's meadow for a bag, away from the tent, the bench, where people
    // sit and the other bags.
    function bagSpot(c, self) {
      const others = [...bags.entries()].filter(([id, b]) => id !== self && b.home === c.key).map(([, b]) => [b.x, b.y])
        .concat([...walkers.values()].filter(o => o.id !== self && o.bagAt && o.home === c.key && !bags.has(o.id)).map(o => o.bagAt));
      const places = Object.values(c.places).flat();
      const ok = (x, y) => ((x - c.cx) / (c.rx - 5)) ** 2 + ((y - c.cy) / (c.ry - 5)) ** 2 <= 1
        && free(x, y) && free(x - 6, y + 1) && free(x + 3, y) && free(x, y - 6)
        && world.kind[y * world.aw + x] === GROUND.MEADOW && world.kind[(y + 1) * world.aw + x - 6] === GROUND.MEADOW
        && !places.some(([px, py]) => Math.abs(px - x) < 9 && Math.abs(py - y) < 8)
        && !others.some(([bx, by]) => Math.abs(bx - x) < 8 && Math.abs(by - y) < 6);
      for (const [dx, dy] of [[-34, 15], [30, 6], [-16, -14], [24, -12], [-38, 2], [6, 22], [-4, -19], [36, -4]]) {
        if (ok(c.cx + dx, c.cy + dy)) return [c.cx + dx, c.cy + dy];
      }
      for (let r = 8; r < 44; r += 3) {
        for (let a = 0; a < 16; a += 1) {
          const x = Math.round(c.cx + Math.cos((a / 16) * Math.PI * 2) * r * 1.4);
          const y = Math.round(c.cy + Math.sin((a / 16) * Math.PI * 2) * r);
          if (ok(x, y)) return [x, y];
        }
      }
      return [c.cx + 4, c.cy + 20];
    }
    // A run that's done: its wanderer takes the bag to the clearing; with nobody out (it finished
    // while the map was away), the bag's just there.
    function finished(p, now) {
      if (bags.has(p.id)) { bags.get(p.id).p = p; return; }
      const w = walkers.get(p.id);
      if (w) {
        w.p = p;
        if (w.unplaced || !world || !clearing(w.home) || w.leaving || w.spot === 'drop') return;
        w.bagAt = bagSpot(clearing(w.home), p.id);
        go(w, 'drop', now);
        return;
      }
      const c = world && clearing(homeOf(p));
      if (!c) return;
      const [x, y] = bagSpot(c, p.id);
      bags.set(p.id, { x, y, home: c.key, p, at: 0 });
    }
    function dropBag(w, now) {
      bags.set(w.id, { x: w.bagAt[0], y: w.bagAt[1], home: w.home, p: w.p, at: now });
      w.facing = 'right';
      w.leaveAt = now + 1600;
    }

    function sync(now) {
      const ids = new Set(people.map(p => p.id));
      for (const [id, w] of [...walkers]) {
        if (ids.has(id)) continue;
        // A session that's ended goes back into its tent; a wanderer whose run you've opened, into
        // the woods.
        if (world && !w.unplaced && clearing(w.home)) { if (!w.leaving) leave(w, now); } else walkers.delete(id);
      }
      for (const id of [...bags.keys()]) if (!ids.has(id)) bags.delete(id);
      for (const p of people) {
        if (p.kind === 'run' && p.run !== 'running') { finished(p, now); continue; }
        const want = SPOT_OF[poseOf(p)] || 'rest';
        let w = walkers.get(p.id);
        if (!w) {
          const run = p.kind === 'run';
          w = { id: p.id, run, look: run ? wandererLooks(p.id) : looksOf(p.id), home: homeOf(p), spot: want, legs: [], pending: null, p };
          walkers.set(p.id, w);
          if (world && clearing(w.home)) {
            if (run) enter(w, want, now); // out of the woods
            else outOfTent(w, want, now); // someone new, or back, comes out of their tent
          } else w.unplaced = true;
          continue;
        }
        if (w.leaving) {
          // Resumed on the way to the tent: about turn.
          if (w.run || p.kind === 'run') continue;
          Object.assign(w, { leaving: false, p });
          go(w, want, now);
          continue;
        }
        w.p = p;
        if (!world || w.unplaced) { w.spot = want; w.home = homeOf(p); continue; }
        if (w.home !== homeOf(p)) {
          w.home = homeOf(p);
          if (!clearing(w.home)) { w.spot = want; w.unplaced = true; continue; } // a new clearing: the map is laid out anew
          go(w, want, now);
          continue;
        }
        if (w.spot === want && !w.pending) continue;
        // From one kind of work to another: stay a moment first, then go straight to the latest.
        const busy = w.arrived && now - w.arrived < MIN_DWELL;
        if (WORK.has(want) && WORK.has(w.spot) && busy) { w.pending = want; continue; }
        w.pending = null;
        if (w.spot !== want) go(w, want, now);
      }
    }

    // Those who find themselves at the same spot (round the fire, on the deck, at the board…) talk
    // now and then: a word each about their session, in turn, three at most. A few seconds after
    // someone joins them, then every half a minute or so.
    const talks = new Map(); // spot (and area) → { next, n }: when they may talk next, and how many were there
    function chatter(now, list) {
      const groups = new Map();
      for (const w of list) {
        if (w.unplaced || w.legs.length || w.leaving || !w.p?.say || now - (w.arrived || 0) < 1500) continue;
        if (!w.spot || ['ring', 'rest', 'drop', 'out'].includes(w.spot)) continue;
        const key = `${w.spot}|${areaOf(w, w.spot)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(w);
      }
      for (const key of [...talks.keys()]) if ((groups.get(key)?.length || 0) < 2) talks.delete(key);
      for (const [key, ws] of groups) {
        if (ws.length < 2 || ws.some(w => w.chat && now < w.chat.to)) continue;
        const t = talks.get(key);
        if (!t || ws.length > t.n) { talks.set(key, { next: Math.min(t?.next ?? Infinity, now + 1500 + Math.random() * 2500), n: ws.length }); continue; }
        t.n = ws.length;
        if (now < t.next) continue;
        const who = ws.map(w => [Math.random(), w]).sort((a, b) => a[0] - b[0]).slice(0, 3).map(([, w]) => w);
        let at = now + 200;
        who.forEach((w, i) => { w.chat = { from: at, to: at + 2000, text: w.p.say, with: who[(i + 1) % who.length].id }; at += 2000; });
        t.next = at + 18000 + Math.random() * 20000;
      }
    }

    let synced = 0;
    function step(now, dt) {
      if (now - synced > 4000) { synced = now; sync(now); }
      const list = [...walkers.values()];
      for (const w of list) {
        if (w.unplaced || w.pause > now) continue;
        if (w.leaving && !w.legs.length) { walkers.delete(w.id); continue; } // into the tent, or the woods
        if (w.run && !w.legs.length) {
          if (w.spot === 'drop' && !bags.has(w.id)) dropBag(w, now);
          if (w.leaveAt && now >= w.leaveAt) { leave(w, now); continue; }
        }
        if (w.legs.length) {
          let budget = (w.speed * dt) / 1000;
          while (budget > 0 && w.legs.length) {
            const leg = w.legs[0];
            if (!leg.pts.length) { if (leg.node != null) w.node = leg.node; w.legs.shift(); continue; }
            const [tx, ty] = leg.pts[0];
            const dx = tx - w.x;
            const dy = ty - w.y;
            const d = Math.hypot(dx, dy);
            if (d > 0.01) w.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
            if (d <= budget) { w.x = tx; w.y = ty; budget -= d; leg.pts.shift(); } else { w.x += (dx / d) * budget; w.y += (dy / d) * budget; budget = 0; }
          }
          while (w.legs.length && !w.legs[0].pts.length) { if (w.legs[0].node != null) w.node = w.legs[0].node; w.legs.shift(); }
          const last = w.trail[0];
          if (!last || Math.hypot(last[0] - w.x, last[1] - w.y) >= 1) { w.trail.unshift([w.x, w.y]); if (w.trail.length > 90) w.trail.pop(); }
          if (!w.legs.length) { w.arrived = now; if (!w.leaving) w.woods = null; } // out among the others
          continue;
        }
        if (w.pending && now - w.arrived >= MIN_DWELL) { const s = w.pending; w.pending = null; if (s !== w.spot) go(w, s, now); continue; }
        // Thinking: on along the paths, with a pause now and then.
        if (w.spot === 'ring' && now - w.arrived > 900 + ((w.look.phase * 37) % 1500)) wander(w, now);
      }
      // Walkers who cross on the way stop and say hello (once in a while, not every time).
      for (let i = 0; i < list.length; i += 1) {
        const a = list[i];
        if (!a.legs?.length || a.pause > now || a.unplaced || a.leaving) continue;
        for (let j = i + 1; j < list.length; j += 1) {
          const b = list[j];
          if (!b.legs?.length || b.pause > now || b.unplaced || b.leaving) continue;
          if (Math.abs(a.x - b.x) > 9 || Math.abs(a.y - b.y) > 7) continue;
          const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
          if (now - (met.get(key) || 0) < 45000) continue;
          met.set(key, now);
          // A wave and a hello; then, with something to tell, a word each about their session,
          // one after the other.
          const [first, second] = Math.random() < 0.5 ? [a, b] : [b, a];
          const talk = Boolean(first.p?.say && second.p?.say);
          const until = now + (talk ? 4800 : 1300);
          a.pause = until; b.pause = until;
          a.hello = until; b.hello = until;
          a.helloAt = now; b.helloAt = now;
          first.chat = talk ? { from: now + 700, to: now + 2700, text: first.p.say, with: second.id } : null;
          second.chat = talk ? { from: now + 2700, to: now + 4700, text: second.p.say, with: first.id } : null;
          const ab = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
          a.dir = ab ? (b.x > a.x ? 'right' : 'left') : b.y > a.y ? 'down' : 'up';
          b.dir = ab ? (a.x > b.x ? 'right' : 'left') : a.y > b.y ? 'down' : 'up';
        }
      }
      chatter(now, list);
    }

    // --- layout: the largest whole number of screen pixels per art pixel at which it all fits ---
    function layout() {
      const W = host.clientWidth;
      const H = host.clientHeight;
      if (!W || !H) return null;
      const dpr = window.devicePixelRatio || 1;
      if (mode === 'strip') return { dpr, W, H: Math.max(H, stripPeople().length * (HEAD_H * 2 + 8) + 12), k: 2 * dpr };
      const n = clearingList().length;
      let k = Math.max(1, Math.round(3 * dpr));
      while (k > 1 && !fits(Math.ceil((W * dpr) / k), Math.ceil((H * dpr) / k), n)) k -= 1;
      return { dpr, k, css: k / dpr, aw: Math.ceil((W * dpr) / k), ah: Math.ceil((H * dpr) / k), W, H };
    }

    function size(now) {
      geo = layout();
      if (!geo) return false;
      canvas.style.width = `${geo.W}px`;
      canvas.style.height = `${geo.H}px`;
      const cw = Math.round(geo.W * geo.dpr);
      const ch = Math.round(geo.H * geo.dpr);
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      if (mode === 'strip') return true;
      if (art.width !== geo.aw || art.height !== geo.ah) { art.width = geo.aw; art.height = geo.ah; }
      const list = clearingList();
      const key = `${geo.aw}x${geo.ah}|${list.map(c => `${c.key}:${c.title}`).join()}`;
      if (key !== worldKey) {
        // Dragging a border lays the map out many times a second: not more than ~6.
        if (world && now - builtAt < 160) { dirty = true; return true; }
        world = buildWorld(geo.aw, geo.ah, list);
        worldKey = key;
        builtAt = now;
        // Anyone on their way out (into a tent or the woods), or a wanderer with a bag to leave, is
        // gone; the bags are laid anew.
        for (const w of [...walkers.values()]) if (w.leaving || (w.run && w.p?.run !== 'running')) walkers.delete(w.id);
        bags.clear();
        for (const w of walkers.values()) { w.slot = null; w.goal = null; w.woods = null; }
        for (const w of walkers.values()) { w.unplaced = false; snap(w, now); }
        for (const p of people) if (p.kind === 'run' && p.run !== 'running') finished(p, now);
      }
      for (const w of walkers.values()) if (w.unplaced) { w.unplaced = false; snap(w, now); }
      return true;
    }

    // --- drawing in art pixels ---
    const R = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, h); };
    const H = (x, y, w, h, c) => R(world.hx + x, world.hy + y, w, h, c);

    function drawMap(now) {
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      g.drawImage(world.canvas, 0, 0);
      const t = Math.floor(now / 125); // the art's own frames: 8 a second
      const sky = daylight(hourNow());
      grass(now);
      woods(now);
      live(t, now);
      if (hoverCamp) {
        const c = world.clearings.find(cl => cl.key === hoverCamp);
        if (c) bubble(c.tent.x + Math.round(c.tent.w / 2), c.tent.y - 3, '#d9a26b', 'plus');
      }
      // Walkers and their pets, back to front.
      const items = [];
      for (const w of walkers.values()) {
        if (w.unplaced) continue;
        items.push({ y: w.y, draw: () => walker(w, now, t) });
        for (const pet of pets(w, now)) items.push({ y: pet.y, draw: () => drawPet(pet) });
      }
      for (const b of bags.values()) items.push({ y: b.y, draw: () => drawBag(b, now) });
      items.sort((a, b) => a.y - b.y).forEach(it => it.draw());
      leaves(now);
      butterflies(now, sky);
      clouds(now, sky);
      light(now, sky);
    }

    // The wind in the grass: each tuft's tips, leaning a pixel while a gust goes by.
    function grass(now) {
      for (const [col, list] of world.tufts) {
        g.fillStyle = col;
        for (const [x, y] of list) {
          const l = gust(x, now) > 0.3 ? 1 : 0;
          g.fillRect(x + l, y, 1, 1); g.fillRect(x + 2 + l, y, 1, 1); g.fillRect(x + 1 + l, y - 1, 1, 1);
        }
      }
    }
    // The woods, back to front, the top of each crown leaning with the gusts; bushes only in the
    // strong ones. Then the mushrooms at their feet.
    function woods(now) {
      const { flora, atlas } = world;
      for (const f of flora) {
        const dx = f.x + f.ox; const dy = f.y + f.oy;
        const l = gust(f.x + f.ph, now) > (f.type === 'bush' ? 0.62 : 0.4) ? 1 : 0;
        if (!l) { g.drawImage(atlas, f.sx, f.sy, f.w, f.h, dx, dy, f.w, f.h); continue; }
        g.drawImage(atlas, f.sx, f.sy + f.cut, f.w, f.h - f.cut, dx, dy + f.cut, f.w, f.h - f.cut);
        g.drawImage(atlas, f.sx, f.sy, f.w, f.cut, dx + l, dy, f.w, f.cut);
      }
      for (const [x, y] of world.shrooms) drawShroom(g, x, y);
    }
    // Now and then, on a gust, a leaf comes off a tree at the edge of the woods and drifts.
    function leaves(now) {
      const edge = world.edgeTrees;
      if (!edge.length) return;
      for (let i = 0; i < 3; i += 1) {
        const span = 6500 + i * 1700;
        const n = Math.floor((now + i * 2300) / span);
        const age = ((now + i * 2300) % span) / span;
        if (age > 0.8) continue;
        const [tx, ty] = edge[(n * 7 + i * 13) % edge.length];
        if (gust(tx, n * span - i * 2300) < 0.3) continue; // only when it left on a gust
        const x = Math.round(tx - 4 + ((n * 5 + i * 3) % 9) + age * 44 + Math.sin(age * 11) * 3);
        const y = Math.round(ty - 15 + age * 28 + Math.cos(age * 9) * 1.5);
        const c = (n + i) % 3 ? P.treeL : '#d6a548';
        if (Math.floor(now / 180 + i) % 2) R(x, y, 2, 1, c); else R(x, y, 1, 1, c);
      }
    }

    // What moves on the map itself: the fire and its smoke, the pond, the gate when someone's
    // at it, the dot on the kiosk's map while someone reads it.
    function live(t, now) {
      const here = [...walkers.values()].filter(w => !w.unplaced && !w.legs.length && HUB_SPOTS.has(w.spot));
      const at = spot => here.filter(w => w.spot === spot);
      const [fx, fy] = world.hub.fire;
      const busy = at('fire').length > 0;
      const f = t % 4;
      H(fx - 2, fy - 5 - (busy ? 2 : 0) + (f === 1 ? 1 : 0), 5, busy ? 6 : 4, P.fire[2]);
      H(fx - 1, fy - 4 - (busy ? 3 : 1) + (f === 2 ? 1 : 0), 3, busy ? 5 : 3, P.fire[1]);
      H(fx, fy - 2 - (busy ? 2 : 0), 1, 2, P.fire[0]);
      if (busy) for (let i = 0; i < 3; i += 1) { const k = (t + i * 5) % 12; H(fx - 1 + ((i * 3 + k) % 4), fy - 8 - k, 1, 1, k < 6 ? P.fire[0] : P.fire[1]); }
      for (let i = 0; i < 4; i += 1) {
        const age = ((now / 1000 + i * 0.9) % 3.6) / 3.6;
        const size = age > 0.5 ? 3 : 2;
        H(fx + Math.round(Math.sin(age * 6 + i) * 1.5 + age * 5), fy - 8 - Math.round(age * 16), size, 2, `rgba(210,210,220,${(0.3 * (1 - age)).toFixed(2)})`);
      }
      // Light moving on the pond.
      const [px, py, prx, pry] = world.pond;
      for (let i = 0; i < 6; i += 1) {
        const x = px - prx + 4 + ((now / 110 + i * 13) % (2 * prx - 8));
        const y = py - pry + 4 + Math.round((i * (2 * pry - 8)) / 5);
        if (((x - px) / (prx - 2)) ** 2 + ((y - py) / (pry - 2)) ** 2 < 1 && (Math.floor(now / 500) + i) % 3) R(x, y, 2, 1, 'rgba(190,235,228,0.55)');
      }
      for (const [x, y] of world.reeds) {
        const l = gust(x, now) > 0.25 ? 1 : 0;
        R(x + l, y + 1, 1, 2, '#5f8a3e'); R(x + l, y - 2, 1, 3, '#7a5236');
      }
      const [gx, gb] = world.hub.gateAt;
      const rattle = at('gate').length && t % 4 < 2 ? 1 : 0;
      for (const y of [gb + 18, gb + 22, gb + 26]) { H(gx + 24 + rattle, y, 13, 2, P.wood); H(gx + 24 + rattle, y, 13, 1, P.woodL); }
      for (let i = 0; i < 11; i += 1) H(gx + 25 + i + rattle, gb + 27 - Math.floor(i * 0.8), 1, 2, P.woodL); // the brace
      if (at('board').length && t % 6 < 4) H(world.hub.kiosk[0] + 24, world.hub.kiosk[1] + 15, 2, 2, P.red); // "you are here"
    }

    // Butterflies over the flowers by day.
    function butterflies(now, sky) {
      if (sky.lamps > 0.3 || !world.blooms.length) return;
      for (let i = 0; i < Math.min(3, world.blooms.length); i += 1) {
        const [bx, by] = world.blooms[(i * 7) % world.blooms.length];
        const x = Math.round(bx + Math.sin(now / 1300 + i * 2) * 10);
        const y = Math.round(by - 6 + Math.cos(now / 1700 + i) * 5);
        const c = P.flower[1 + (i % 4)];
        R(x, y, 1, 1, '#2b2119');
        if (Math.floor(now / 140 + i) % 2) { R(x - 1, y - 1, 1, 1, c); R(x + 1, y - 1, 1, 1, c); } else { R(x - 1, y, 1, 1, c); R(x + 1, y, 1, 1, c); }
      }
    }
    // The shadows of clouds drifting over, by day.
    function clouds(now, sky) {
      const a = 0.07 * (1 - Math.min(1, sky.lamps * 2));
      if (a < 0.01) return;
      const span = world.aw + 140;
      for (let i = 0; i < 2; i += 1) {
        const cx = ((now / 1000) * 3 + i * span * 0.55) % span - 70;
        const cy = world.ah * (0.28 + i * 0.45);
        g.fillStyle = `rgba(10,25,30,${a.toFixed(3)})`;
        for (const [dx, dy, rx, ry] of [[0, 0, 44, 18], [30, 8, 26, 12], [-28, 6, 24, 10]]) {
          for (let j = -ry; j <= ry; j += 1) { const w = Math.round(rx * Math.sqrt(1 - (j / (ry + 0.5)) ** 2)); g.fillRect(Math.round(cx + dx - w), Math.round(cy + dy + j), w * 2 + 1, 1); }
        }
      }
    }
    // The time of day over everything, then lamps and the fire glowing through it, and fireflies.
    function light(now, sky) {
      if (sky.alpha > 0.005) {
        g.globalCompositeOperation = 'multiply';
        g.globalAlpha = sky.alpha;
        g.fillStyle = `rgb(${sky.tint.join(',')})`;
        g.fillRect(0, 0, world.aw, world.ah);
        g.globalAlpha = 1;
      }
      if (sky.lamps > 0.02) {
        g.globalCompositeOperation = 'lighter';
        const glow = (x, y, r, [cr, cg, cb], a) => {
          const grd = g.createRadialGradient(x, y, 0, x, y, r);
          grd.addColorStop(0, `rgba(${cr},${cg},${cb},${a.toFixed(3)})`);
          grd.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
          g.fillStyle = grd;
          g.fillRect(x - r, y - r, r * 2, r * 2);
        };
        for (const [x, y, r, c, flicker] of world.lights) {
          const rr = flicker ? r * (0.93 + 0.05 * Math.sin(now / 130) + 0.03 * Math.sin(now / 47)) : r;
          glow(x, y, rr, c, 0.4 * sky.lamps);
        }
        for (const [gx, gy, ph, sp] of world.glades) {
          const tt = (now / 1000) * sp;
          if (Math.sin(tt * 2.1 + ph * 3) < 0.1) continue;
          const x = gx + Math.sin(tt * 0.7 + ph) * 9;
          const y = gy + Math.cos(tt * 0.5 + ph * 1.3) * 6 - 4;
          glow(x, y, 4, [220, 255, 150], 0.5 * sky.lamps);
          g.globalCompositeOperation = 'source-over';
          R(x, y, 1, 1, `rgba(240,255,190,${Math.min(1, 0.3 + sky.lamps).toFixed(2)})`);
          g.globalCompositeOperation = 'lighter';
        }
      }
      g.globalCompositeOperation = 'source-over';
    }

    function walker(w, now, t) {
      const f = t + w.look.phase;
      const moving = w.legs.length > 0 && !(w.pause > now);
      const dir = (moving || w.pause > now ? w.dir : w.facing) || 'down';
      const legs = moving ? (Math.floor(now / 170) % 2 ? 'a' : 'b') : w.sit && !w.legs.length ? 'sit' : 'stand';
      const spot = w.legs.length ? null : w.spot;
      const shut = spot === 'rest' || (!moving && f % 40 < 2);
      const img = w.run ? wandererSprite(w.id, w.look, dir, legs, shut) : walkerSprite(w.id, w.look, dir, legs, shut);
      const fx = Math.round(w.x);
      const fy = Math.round(w.y);
      const x0 = fx - (w.run ? W_FOOT_X : FOOT_X);
      const breathe = !moving && legs === 'stand' && f % 32 < 3 ? 1 : 0;
      const y0 = fy - (w.run ? W_FOOT_Y : FOOT_Y) + (moving && legs === 'a' ? -1 : 0) + (legs === 'sit' ? 1 : 0) + breathe;
      const top = y0 + (w.run ? W_LIFT : 0); // where a walker's head would start: what's drawn on them goes from here
      w.box = [x0, y0, img.width, img.height];
      // Coming out of the woods, or going back in: faint among the trees.
      const fade = w.woods ? Math.min(1, Math.hypot(w.x - w.woods[0], w.y - w.woods[1]) / (w.fadeLen || 14)) : 1;
      if (fade < 1) g.globalAlpha = Math.max(0.05, fade);
      R(fx - 4, fy - 1, 9, 2, 'rgba(0,0,0,0.25)');
      if (w.p?.current && !w.leaving) { R(fx - 6, fy - 1, 13, 1, '#d9a26b'); R(fx - 5, fy + 1, 11, 1, '#d9a26b'); R(fx - 7, fy, 1, 1, '#d9a26b'); R(fx + 7, fy, 1, 1, '#d9a26b'); }
      if (spot === 'pond' && !w.aside) rod(fx, fy, dir, f);
      g.drawImage(img, x0, y0);
      g.globalAlpha = 1;
      if (w.hello > now) {
        const speaking = w.chat && now >= w.chat.from && now < w.chat.to;
        if (now - (w.helloAt || 0) < 700) { wave(w, fx, top, f); glyph(GLYPH.hi, fx - 2, y0 - 7, '#f4f1ea'); } else if (speaking && f % 10 < 3) wave(w, fx, top, f);
        return;
      }
      if (spot) act(w, spot, fx, top, dir, f, y0);
      else if (w.p && !w.leaving && poseOf(w.p) === 'waiting') bubble(fx, y0 + 1, '#e3a008', 'bang'); // on the way to the gate
    }

    // A bag on the grass: it drops, puffs a little dust, and glints now and then to be noticed.
    function drawBag(b, now) {
      const img = bagSprite(b.p?.run === 'failed');
      const age = b.at ? now - b.at : Infinity;
      const x = Math.round(b.x - 4);
      const y = Math.round(b.y - img.height + 1) - (age < 260 ? Math.round((1 - age / 260) * 5) : 0);
      R(b.x - 3, b.y, 7, 1, 'rgba(0,0,0,0.25)');
      g.drawImage(img, x, y);
      if (age >= 260 && age < 700) {
        const r = 4 + (age - 260) / 110;
        R(b.x - r, b.y - 1, 1, 1, 'rgba(225,215,190,0.7)'); R(b.x + r, b.y - 1, 1, 1, 'rgba(225,215,190,0.7)');
      }
      const tw = (now + (hash(String(b.p?.id)) % 3200)) % 3600;
      if (tw < 300) {
        R(b.x + 3, y - 2, 1, 1, '#fff6d8');
        if (tw > 90 && tw < 210) { R(b.x + 2, y - 2, 3, 1, '#fff6d8'); R(b.x + 3, y - 3, 1, 3, '#fff6d8'); }
      }
      b.box = [b.x - 6, y - 4, 13, img.height + 5];
    }
    function wave(w, fx, y0, f) {
      const up = f % 4 < 2;
      R(fx + 5, y0 + 7 + (up ? 0 : 1), 2, 4, w.look.shirt);
      R(fx + (up ? 5 : 6), y0 + 4 + (up ? 0 : 1), 2, 3, w.look.skin);
    }

    // The rod over the water, and the float bobbing on it.
    function rod(fx, fy, dir, f) {
      const col = '#6b4a2e';
      if (dir === 'down') {
        for (let i = 0; i < 8; i += 1) R(fx + 4, fy - 9 + i, 1, 1, col);
        const by = fy + 4 + (f % 10 < 5 ? 0 : 1);
        R(fx + 4, fy - 1, 1, by - fy + 1, 'rgba(230,230,230,0.5)');
        R(fx + 3, by, 3, 2, '#e8e3d8'); R(fx + 4, by, 1, 1, P.red);
        ripple(fx + 4, by + 1, f);
        return;
      }
      const s = dir === 'left' ? -1 : 1;
      for (let i = 0; i < 9; i += 1) R(fx + s * (3 + i), fy - 7 - Math.floor(i / 2), 1, 1, col);
      const tipx = fx + s * 12;
      const by = fy - 2 + (f % 10 < 5 ? 0 : 1);
      R(tipx, fy - 11, 1, by - (fy - 11), 'rgba(230,230,230,0.5)');
      R(tipx - 1, by, 3, 2, '#e8e3d8'); R(tipx, by, 1, 1, P.red);
      ripple(tipx, by + 1, f);
    }
    function ripple(x, y, f) {
      const ph = (f % 20) / 20;
      const r = 2 + ph * 5;
      for (let i = 0; i < 10; i += 1) {
        const a = (i / 10) * Math.PI * 2;
        R(x + Math.cos(a) * r, y + Math.sin(a) * r * 0.45, 1, 1, `rgba(200,240,235,${(0.55 * (1 - ph)).toFixed(2)})`);
      }
    }

    // What each spot has them do, drawn over the walker.
    function act(w, spot, fx, y0, dir, f, spriteTop = y0) {
      const look = w.look;
      if (spot === 'gate') bubble(fx, spriteTop + 1 - (f % 8 < 4 ? 0 : 1), '#e3a008', 'bang');
      else if (spot === 'drop') { if (w.leaveAt && f % 6 < 3) R(fx + 4, y0 + 9, 2, 2, look.skin); } // setting the bag down
      else if (spot === 'lounge') {
        if (w.p && poseOf(w.p) === 'done') { if (f % 40 < 10) wave(w, fx, y0, f); bubble(fx, y0 + 1, '#58a6ff', 'check'); } else {
          R(fx + 3, y0 + 10, 3, 3, '#e8e3d8'); R(fx + 6, y0 + 11, 1, 1, '#e8e3d8'); R(fx + 2, y0 + 12, 2, 2, look.skin); // a mug
          if (f % 12 < 8) { R(fx + 4, y0 + 7 - ((f % 12) >> 2), 1, 2, 'rgba(220,225,232,0.7)'); }
        }
      } else if (spot === 'board') {
        if (f % 12 < 6) { R(fx + 3, y0 + 5, 2, 5, look.shirt); R(fx + 3, y0 + 3, 2, 2, look.skin); }
      } else if (spot === 'rock') {
        if (dir === 'down' && w.sit) {
          R(fx - 3, y0 + 13, 7, 4, '#e8e3d8'); R(fx - 3, y0 + 13, 7, 1, P.red);
          R(fx - 2 + (f % 5), y0 + 15, 1, 1, '#4a4a55');
          R(fx - 1 + (f % 5), y0 + 13, 2, 2, look.skin);
        }
      } else if (spot === 'fire') {
        if (f % 16 < 8) {
          const s = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
          if (s) for (let i = 0; i < 5; i += 1) R(fx + s * (4 + i), y0 + 11 + Math.floor(i / 2), 1, 1, '#6b4a2e');
        }
      } else if (spot === 'rest') {
        if (f % 32 < 20) glyph(GLYPH.z, fx + 4, y0 - 2 - ((f % 32) >> 2), '#c7cfda');
      } else if (spot === 'ring' && !(w.p?.subagents > 0 || w.p?.bgAgents > 0)) {
        for (let i = 0; i < 3; i += 1) if (i <= (f % 8) / 2) R(fx + 4 + i * 2, y0 - i * 2, 1 + (i > 1 ? 1 : 0), 1 + (i > 1 ? 1 : 0), '#c7cfda');
      }
    }

    // A pet for each subagent out, trotting behind along the way the walker came.
    function pets(w, now) {
      const n = Math.min(3, (w.p?.subagents || 0) + (w.p?.bgAgents || 0));
      if (!n) return [];
      const out = [];
      for (let i = 0; i < n; i += 1) {
        const back = 12 + i * 10;
        let pos = null;
        let acc = 0;
        for (let j = 1; j < w.trail.length; j += 1) {
          acc += Math.hypot(w.trail[j][0] - w.trail[j - 1][0], w.trail[j][1] - w.trail[j - 1][1]);
          if (acc >= back) { pos = w.trail[j]; break; }
        }
        if (!pos) pos = [w.x - 10 - i * 8, w.y + 2];
        const prev = w.pets[i] || { 0: pos[0], 1: pos[1] };
        const moving = Math.hypot(pos[0] - prev[0], pos[1] - prev[1]) > 0.2;
        const left = moving ? pos[0] < prev[0] - 0.1 || (Math.abs(pos[0] - prev[0]) <= 0.1 && (w.pets[i]?.left ?? false)) : (w.pets[i]?.left ?? pos[0] > w.x);
        w.pets[i] = { 0: pos[0], 1: pos[1], left };
        out.push({ x: pos[0], y: pos[1], left, moving, kind: (w.look.phase + i) % 3 === 2 ? 'cat' : 'dog', color: FUR[(w.look.fur + i * 2) % FUR.length], id: `${w.id}:${i}`, now });
      }
      return out;
    }
    function drawPet(pet) {
      const legs = pet.moving ? (Math.floor(pet.now / 110) % 2 ? 'a' : 'b') : 'stand';
      const img = petSprite(pet.id, pet.kind, pet.color, legs, pet.left);
      const x = Math.round(pet.x - img.width / 2);
      const y = Math.round(pet.y - img.height + 1);
      R(x + 2, y + img.height - 1, img.width - 4, 1, 'rgba(0,0,0,0.25)');
      g.drawImage(img, x, y);
    }

    const GLYPH = {
      bang: ['1', '1', '1', '0', '1'],
      check: ['000001', '000011', '100110', '111100', '011000'],
      z: ['111', '001', '010', '100', '111'],
      hi: ['10001', '10000', '11101', '10101', '10101'],
      plus: ['00100', '00100', '11111', '00100', '00100'],
    };
    function glyph(rows, x, y, color) { rows.forEach((r, j) => [...r].forEach((c, i) => { if (c === '1') R(x + i, y + j, 1, 1, color); })); }
    function bubble(cx, bottom, color, kind) {
      const rows = GLYPH[kind];
      const w = rows[0].length + 4;
      const h = rows.length + 3;
      const x = cx - Math.floor(w / 2);
      const y = bottom - h - 1;
      R(x + 1, y, w - 2, h, color); R(x, y + 1, w, h - 2, color); R(x + 1, y + 1, w - 2, h - 2, '#f4f1ea');
      R(cx, y + h, 1, 1, color);
      glyph(rows, x + 2, y + 1.5, color);
    }

    // --- on top, at screen resolution: trail names and the name of what's open ---
    function overlay() {
      const { css } = geo;
      ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      for (const c of world.clearings) {
        const size = Math.max(9, Math.min(12, Math.floor(c.sign.h * css * 0.62)));
        ctx.font = `700 ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        ctx.fillStyle = '#f6e7c8';
        ctx.fillText(fit(c.title, c.sign.w * css - 8), (c.sign.x + c.sign.w / 2) * css, (c.sign.y + c.sign.h / 2) * css + 0.5);
      }
      const cur = [...walkers.values()].find(w => w.p?.current && w.box && !w.unplaced && !w.leaving);
      if (cur) nameTag(cur, '#d9a26b');
      const now = performance.now();
      for (const w of walkers.values()) {
        // Said where they stand: someone who has set off since says nothing more.
        if (w.chat && w.box && !w.unplaced && now >= w.chat.from && now < w.chat.to && (!w.legs.length || w.hello > now)) speech(w, w.chat.text);
      }
      if (!people.length) {
        ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        const text = 'Nobody’s out yet. Click a tent to start a session on its trail.';
        ctx.fillStyle = 'rgba(14,17,22,0.78)';
        const tw = Math.min(geo.W - 16, ctx.measureText(text).width + 20);
        const y = (world.hy + world.hub.lounge[1] + 24) * css;
        ctx.fillRect(geo.W / 2 - tw / 2, y - 14, tw, 28);
        ctx.fillStyle = '#c7cfda';
        ctx.fillText(fit(text, tw - 16), geo.W / 2, y);
      }
      ctx.textAlign = 'start';
    }
    // What someone says when they stop to chat: a few words in a bubble over their head.
    function speech(w, text) {
      const { css } = geo;
      ctx.font = '500 10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      const line = fit(text, 180);
      const tw = Math.round(ctx.measureText(line).width) + 14;
      const hx = (w.box[0] + w.box[2] / 2) * css;
      const cx = Math.min(Math.max(hx, tw / 2 + 4), geo.W - tw / 2 - 4);
      // Over their head; under their feet when the one they're talking to stands above them.
      const other = walkers.get(w.chat.with);
      const below = (other && other.y < w.y - 3) || w.box[1] * css < 28;
      // Over the ! at the gate and the tick on the deck, not on them.
      const marked = !w.legs.length && (w.spot === 'gate' || (w.spot === 'lounge' && w.p && poseOf(w.p) === 'done'));
      const top = below ? Math.min(geo.H - 21, (w.box[1] + w.box[3]) * css + 6) : Math.max(4, (w.box[1] - (marked ? 10 : 0)) * css - 24);
      const tip = below ? [top + 1, top - 4] : [top + 16, top + 21]; // the tail's base and point
      ctx.fillStyle = 'rgba(21,18,28,0.9)';
      ctx.beginPath(); ctx.roundRect(cx - tw / 2 - 1, top - 1, tw + 2, 19, 7); ctx.fill();
      ctx.beginPath(); ctx.moveTo(hx - 4, tip[0]); ctx.lineTo(hx + 4, tip[0]); ctx.lineTo(hx, tip[1] + (below ? -1 : 1)); ctx.fill();
      ctx.fillStyle = '#f6efdf';
      ctx.beginPath(); ctx.roundRect(cx - tw / 2, top, tw, 17, 6); ctx.fill();
      ctx.beginPath(); ctx.moveTo(hx - 3, tip[0]); ctx.lineTo(hx + 3, tip[0]); ctx.lineTo(hx, tip[1]); ctx.fill();
      ctx.fillStyle = '#2b2620';
      ctx.fillText(line, cx, top + 9);
    }
    function nameTag(w, color) {
      const { css } = geo;
      ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      const text = fit(w.p.title || 'Untitled session', 150);
      const tw = ctx.measureText(text).width + 12;
      const cx = Math.min(Math.max((w.box[0] + w.box[2] / 2) * css, tw / 2 + 4), geo.W - tw / 2 - 4);
      const cy = Math.min((w.box[1] + w.box[3]) * css + 9, geo.H - 10);
      ctx.fillStyle = 'rgba(14,17,22,0.82)';
      ctx.beginPath();
      ctx.roundRect(cx - tw / 2, cy - 8, tw, 16, 5);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillText(text, cx, cy + 0.5);
    }
    function fit(text, max) {
      if (ctx.measureText(text).width <= max) return text;
      let s = text;
      while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
      return `${s}…`;
    }

    // The strip: a column of heads, each with its dot.
    const DOT = { working: '#3fb950', waiting: '#e3a008', idle: '#58a6ff', bg: '#a371f7' };
    function drawStrip(now) {
      const t = Math.floor(now / 125);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      const { k, dpr } = geo;
      stripPeople().forEach((p, i) => {
        const run = p.kind === 'run';
        const look = run ? wandererLooks(p.id) : looksOf(p.id);
        const f = t + look.phase;
        const shut = poseOf(p) === 'rest' || f % 40 < 2;
        const img = run ? wandererSprite(p.id, look, 'down', 'stand', shut) : walkerSprite(p.id, look, 'down', 'stand', shut);
        const y = (6 + i * (HEAD_H * 2 + 8)) * dpr;
        const x = Math.round((geo.W * dpr - img.width * k) / 2);
        if (p.current) { ctx.fillStyle = '#232b3b'; ctx.fillRect(2 * dpr, y - 2 * dpr, (geo.W - 4) * dpr, (HEAD_H * 2 + 4) * dpr); }
        const from = run ? W_LIFT : 0; // the same head and shoulders, under the bedroll
        ctx.drawImage(img, 0, from, img.width, 13, x, y, img.width * k, 13 * k); // head and shoulders
        const dot = DOT[p.dot];
        if (dot && (p.dot !== 'waiting' || f % 8 < 5)) {
          const cx = x + (run ? 14 : 12) * k;
          const cy = y + 11 * k;
          ctx.fillStyle = '#0e1116';
          ctx.beginPath(); ctx.arc(cx, cy, 3 * k, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = dot;
          ctx.beginPath(); ctx.arc(cx, cy, 2 * k, 0, Math.PI * 2); ctx.fill();
        }
      });
    }

    let last = 0;
    function draw(now) {
      if (!host.isConnected || !host.offsetParent) { stop(); return; }
      if (dirty || !geo) { dirty = false; if (!size(now)) return; }
      if (mode === 'strip') { drawStrip(now); return; }
      if (!world) return;
      const dt = last ? Math.min(100, now - last) : 0;
      last = now;
      step(now, dt);
      g.imageSmoothingEnabled = false;
      drawMap(now);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(art, 0, 0, geo.aw * geo.k, geo.ah * geo.k);
      const cw = canvas.width; const ch = canvas.height;
      const vg = ctx.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.32, cw / 2, ch / 2, Math.max(cw, ch) * 0.72);
      vg.addColorStop(0, 'rgba(6,10,14,0)');
      vg.addColorStop(1, 'rgba(6,10,14,0.4)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, cw, ch);
      overlay();
    }
    // A timer, not every display frame: it's on screen all day. Smooth while anyone walks,
    // 8 frames a second otherwise.
    let failed = false;
    function safely(fn) {
      try { fn(); } catch (e) { if (!failed) { failed = true; console.error('[journey]', e); } }
    }
    function loop() {
      const now = performance.now();
      safely(() => draw(now));
      const moving = mode === 'map' && [...walkers.values()].some(w => w.legs?.length && !(w.pause > now));
      timer = setTimeout(loop, moving ? 33 : 125);
    }
    // Back on screen after a while away: everyone is already where they were going.
    let hiddenAt = 0;
    function start() {
      if (timer) return;
      if (hiddenAt && world && performance.now() - hiddenAt > 2000) {
        for (const w of walkers.values()) {
          if (!w.legs?.length) continue;
          [w.x, w.y] = w.goal || [w.x, w.y];
          for (const leg of w.legs) if (leg.node != null) w.node = leg.node;
          w.legs = [];
          w.arrived = performance.now() - MIN_DWELL;
        }
      }
      last = 0;
      timer = setTimeout(loop, 0);
    }
    function stop() { if (timer) hiddenAt = performance.now(); clearTimeout(timer); timer = 0; }

    // --- pointer: who's under it, a card about them, a click opens them ---
    function at(e) {
      if (!geo) return null;
      const r = canvas.getBoundingClientRect();
      if (mode === 'strip') {
        const i = Math.floor((e.clientY - r.top - 4) / (HEAD_H * 2 + 8));
        return stripPeople()[i] || null;
      }
      const ax = (e.clientX - r.left) / geo.css;
      const ay = (e.clientY - r.top) / geo.css;
      const inside = box => box && ax >= box[0] && ax < box[0] + box[2] && ay >= box[1] && ay < box[1] + box[3];
      const hit = [...walkers.values()].filter(w => !w.unplaced && inside(w.box)).sort((a, b) => b.y - a.y)[0];
      const p = hit && people.find(q => q.id === hit.id);
      if (p) return p;
      // A bag left on the grass opens its run too.
      const bag = [...bags.values()].filter(b => inside(b.box)).sort((a, b) => b.y - a.y)[0];
      const left = bag && people.find(q => q.id === bag.p?.id);
      if (left) return left;
      // A camp's tent starts a new session on its trail.
      const c = world?.clearings.find(cl => inside([cl.tent.x - 2, cl.tent.y - 4, cl.tent.w + 4, cl.tent.h + 6]));
      return c ? { kind: 'camp', id: `camp:${c.key}`, key: c.key, title: c.title, dot: 'none', status: c.key === 'camp' ? 'Click for a new session, on no trail' : 'Click for a new session on this trail' } : null;
    }
    // The strip has those at work, wanderers included, but not the bags.
    const stripPeople = () => people.filter(p => p.kind !== 'run' || p.run === 'running');
    canvas.addEventListener('mousemove', e => {
      const p = at(e);
      canvas.style.cursor = p ? 'pointer' : '';
      hoverCamp = p?.kind === 'camp' ? p.key : null;
      // The strip is too narrow for a card: it gets the system's tooltip instead.
      if (mode === 'strip') { canvas.title = p ? `${p.title || (p.kind === 'run' ? 'Background run' : 'Untitled session')} · ${p.status}${p.preview ? `\n${p.preview}` : ''}` : ''; return; }
      if (!p) { tip.hidden = true; hover = null; return; }
      if (hover !== p.id) {
        hover = p.id;
        tip.innerHTML = '';
        const title = document.createElement('b');
        title.textContent = p.title || (p.kind === 'run' ? 'Background run' : 'Untitled session');
        const what = document.createElement('span');
        what.className = `journey-tip-status ${p.dot}`;
        what.textContent = p.status;
        tip.append(title, what);
        if (p.preview) { const line = document.createElement('span'); line.textContent = p.preview; tip.append(line); }
        tip.hidden = false;
      }
      const hr = host.getBoundingClientRect();
      const left = Math.min(e.clientX - hr.left + 14, host.clientWidth - tip.offsetWidth - 6);
      tip.style.left = `${Math.max(6, left)}px`;
      tip.style.top = `${Math.min(e.clientY - hr.top + 16, host.clientHeight - tip.offsetHeight - 6)}px`;
    });
    canvas.addEventListener('mouseleave', () => { tip.hidden = true; hover = null; hoverCamp = null; });
    canvas.addEventListener('click', e => {
      const p = at(e);
      if (!p) return;
      tip.hidden = true; hover = null; hoverCamp = null;
      if (p.kind === 'camp') onCamp(p.key === 'camp' ? null : p.key); else onOpen(p.id, p.kind || 'session');
    });

    const observer = new ResizeObserver(() => { dirty = true; if (timer) safely(() => draw(performance.now())); });
    observer.observe(host);

    return {
      // people: [{ id, title, dot, activity, subagents, status, preview, say, current, starting, trailId, trailTitle, trailOrder }]
      // (say: the few words they tell someone they stop to chat with)
      // camps: the trails, each to have its camp on the map (with the base camp) even with nobody out.
      update(list, campList) {
        if (campList) camps = campList;
        // Pictures of walkers (and pets) who've gone are dropped.
        const ids = list.map(p => p.id).join();
        if (ids !== lastIds) {
          lastIds = ids;
          const live = new Set(list.map(p => String(p.id)));
          for (const key of [...cache.keys()]) {
            const id = key.startsWith('pet|') ? key.split('|')[1].split(':')[0] : key.split('|')[0];
            if (!live.has(id)) cache.delete(key);
          }
        }
        people = list;
        if (mode === 'map') safely(() => sync(performance.now()));
        dirty = true;
        if (hover && !list.some(p => p.id === hover)) { tip.hidden = true; hover = null; }
        if (host.offsetParent) { start(); safely(() => draw(performance.now())); }
      },
      // The panel was shown or hidden: animate only while it's on screen.
      visible(on) { if (on) { dirty = true; start(); } else { tip.hidden = true; hover = null; stop(); } },
      destroy() { stop(); observer.disconnect(); canvas.remove(); tip.remove(); },
    };
  }

  window.Journey = { create, looksOf, poseOf };
}());
