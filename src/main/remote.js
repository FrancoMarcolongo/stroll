const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const qrcode = require('qrcode-generator');
const { writePrivate } = require('./config');
const C = require('../shared/channel');
const { newVapidKeys, sendPush, validSubscription } = require('./push');

// Phone access. Stroll keeps one outbound connection to the relay, where the user's paired
// phones find this computer, and serves them what the window gets over IPC. Nothing runs on
// the phone: it's a second view of the sessions, runs and lists that live here.
//
// A paired phone can do what the user can do in the window, typing into sessions included, so
// who gets in is the whole question. Only a phone holding a key this computer registered when
// the user paired it (channel.js); the relay in between can't read or forge anything.

// What a phone may ask for. Not here on purpose: settings, workflow setup (it decides what
// background runs may do), updates, deleting and clearing, and anything that opens a window or
// a dialog on the computer.
const INVOKE = new Set([
  'state:get', 'todo:add', 'todo:update', 'todo:handoff',
  'session:create', 'session:buffer', 'session:kill', 'session:rename', 'session:link', 'session:markRead', 'session:mute', 'session:setTrail',
  'run:markRead', 'run:decide', 'run:allowAll', 'run:events', 'run:cancel', 'run:reviewed',
  'workflow:start', 'workflow:prepare', 'workflow:dismiss', 'workflow:render',
  'trail:add', 'trail:update', 'trail:suggestion', 'trail:condense',
]);
const SEND = new Set(['session:write', 'session:resize', 'session:interrupt']);
// Answered here, not by the app: a phone registering where notifications for it go.
const PUSH_SUBSCRIBE = 'push:subscribe';
const EVENTS = new Set(['state:changed', 'session:data', 'session:exit', 'session:size', 'run:event', 'ui:error']);

const PAIRING_MS = 5 * 60 * 1000;
const PING_MS = 25 * 1000;
const SILENT_MS = 70 * 1000; // nothing heard from the relay for this long: the connection is dead
const BACKOFF_MS = [1000, 2000, 5000, 15000, 30000];
const STATE_EVERY_MS = 1000; // a phone gets the state at most this often: it's the whole snapshot
const TERMINAL_EVERY_MS = 40; // terminal output is sent in batches, not chunk by chunk
const BUFFER_TAIL = 300 * 1000; // chars of a session's scrollback a phone gets when it opens it
// A phone with Stroll on screen says so every 20 seconds. One that has gone quiet may still
// hold its connection (a page frozen in the background does): it counts as away after
// AWAY_MS, and is dropped after SILENT_PHONE_MS.
const AWAY_MS = 50 * 1000;
const SILENT_PHONE_MS = 5 * 60 * 1000;

// What the phone calls this computer: the name its owner gave it ("Ana's MacBook Pro") where
// the system has one, rather than the network's name for it.
let knownName = null;
function computerName() {
  if (knownName) return knownName;
  if (process.platform === 'darwin') {
    try { knownName = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim(); } catch (_) { /* fall through */ }
  }
  knownName = knownName || os.hostname().split('.')[0];
  return knownName;
}

class Remote extends EventEmitter {
  // `api`: how the app is reached: { invoke: Map channel → fn, send: Map channel → fn,
  // seen(view), version }. `config`: the app's, read live (config.remote).
  constructor({ file, config, api, WebSocketImpl = globalThis.WebSocket }) {
    super();
    this.file = file;
    this.config = config;
    this.api = api;
    this.WebSocket = WebSocketImpl;
    this.data = null; // { hostKey, identity: { privateKey: jwk, publicKey }, devices: [] }
    this.identity = null;
    this.room = null;
    this.ws = null;
    this.state = 'off'; // off | connecting | online | offline
    this.error = null;
    this.attempt = 0;
    this.clients = new Map(); // relay connection id → { id, channel, device, focus, … }
    this.pairing = null; // { code, expiresAt }
    this.url = null;
  }

  // This computer's keys and its paired phones, made on first use. Private to the user.
  async load() {
    if (this.data) return;
    let data = null;
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { /* first use */ }
    if (!data?.hostKey || !data.identity) {
      const pair = await C.newKeyPair(true);
      data = { hostKey: C.randomId(32), identity: { privateKey: await C.exportPrivate(pair.privateKey), publicKey: await C.exportPublic(pair.publicKey) }, devices: [] };
      writePrivate(this.file, JSON.stringify(data, null, 2));
    }
    if (!data.vapid) {
      data.vapid = await newVapidKeys();
      writePrivate(this.file, JSON.stringify(data, null, 2));
    }
    this.data = data;
    this.identity = { privateKey: await C.importPrivate(data.identity.privateKey), publicKey: data.identity.publicKey };
    this.room = await C.roomOf(data.hostKey);
  }

  save() { writePrivate(this.file, JSON.stringify(this.data, null, 2)); }

  get settings() { return this.config.remote || {}; }
  get relay() { return String(this.settings.relayUrl || '').trim().replace(/\/+$/, ''); }

  // What Settings shows. Never the keys.
  status() {
    const live = [...this.clients.values()].filter(c => c.channel);
    return {
      enabled: Boolean(this.settings.enabled),
      relayUrl: this.relay,
      state: this.state,
      error: this.error,
      pairing: this.activeCode() ? { expiresAt: this.pairing.expiresAt } : null,
      devices: (this.data?.devices || []).map(d => ({ id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeenAt: d.lastSeenAt, connected: live.some(c => c.device.id === d.id && Date.now() - c.heardAt < AWAY_MS), notifies: Boolean(d.push), lastPush: d.lastPush || null })),
    };
  }

  changed() { this.emit('changed', this.status()); }

  setState(state, error = null) {
    if (this.state === state && this.error === error) return;
    this.state = state;
    this.error = error;
    this.changed();
  }

  // Follows the settings: connects when phone access is on and there's a relay, otherwise not.
  async apply() {
    const wanted = this.settings.enabled && /^wss?:\/\/\S+$/.test(this.relay) ? this.relay : null;
    if (wanted !== this.url || (wanted && !this.ws)) {
      this.disconnect();
      this.url = wanted;
      if (wanted) {
        await this.load();
        this.connect();
      } else {
        this.state = 'off';
        this.error = this.settings.enabled && this.relay ? 'The relay address has to start with wss://' : null;
      }
    }
    this.changed(); // Settings shows the switch and the address too, not only the connection
  }

  connect() {
    clearTimeout(this.retry);
    let ws;
    try { ws = new this.WebSocket(`${this.url}/v1/room/${this.room}?role=host`); } catch (e) { this.lost(e.message); return; }
    this.ws = ws;
    this.heard = Date.now();
    if (this.state !== 'offline') this.setState('connecting');
    ws.onopen = () => ws.send(JSON.stringify({ t: 'host', key: this.data.hostKey }));
    ws.onmessage = e => { if (ws === this.ws) this.fromRelay(e.data); };
    ws.onerror = () => { /* a close follows */ };
    ws.onclose = e => {
      if (ws !== this.ws) return;
      this.lost(e.code === 4000 ? 'Another Stroll took this computer’s place on the relay' : e.code === 4003 ? 'The relay refused this computer' : null, e.code === 4000);
    };
    clearInterval(this.pinger);
    this.pinger = setInterval(() => {
      if (ws !== this.ws) return;
      if (Date.now() - this.heard > SILENT_MS) { try { ws.close(); } catch (_) { /* gone */ } this.lost('The relay stopped answering'); return; }
      if (ws.readyState === 1) ws.send('ping');
      for (const c of [...this.clients.values()]) {
        if (Date.now() - c.heardAt < SILENT_PHONE_MS) continue;
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'drop', to: c.id }));
        this.forgetClient(c.id);
      }
    }, PING_MS);
  }

  // The connection is gone: the phones on it are too. Try again, a little later each time.
  lost(error = null, slowly = false) {
    this.ws = null;
    clearInterval(this.pinger);
    this.dropAll();
    if (!this.url) return;
    this.setState('offline', error || 'The relay can’t be reached');
    const wait = slowly ? 30000 : BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => { if (this.url && !this.ws) this.connect(); }, wait);
  }

  disconnect() {
    clearTimeout(this.retry);
    clearInterval(this.pinger);
    const ws = this.ws;
    this.ws = null;
    this.url = null;
    this.attempt = 0;
    this.dropAll();
    try { ws?.close(); } catch (_) { /* gone */ }
  }

  stop() { this.disconnect(); this.setState('off'); }

  fromRelay(raw) {
    this.heard = Date.now();
    if (raw === 'pong' || typeof raw !== 'string') return;
    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }
    if (m.t === 'hosting') { this.attempt = 0; this.setState('online'); }
    else if (m.t === 'close') this.forgetClient(m.from);
    else if (m.t === 'msg' && typeof m.from === 'string' && typeof m.d === 'string') this.fromClient(m.from, m.d);
  }

  toClient(id, frame) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'msg', to: id, d: frame }));
  }

  // --- phones ---
  // One phone's messages are handled in the order they came: the channel counts them.
  fromClient(id, frame) {
    let c = this.clients.get(id);
    if (!c) {
      c = { id, channel: null, device: null, focus: null, visible: false, heardAt: Date.now(), work: Promise.resolve(), terminal: new Map() };
      this.clients.set(id, c);
    }
    c.work = c.work.then(() => (c.channel ? this.message(c, frame) : this.hello(c, frame))).catch(err => this.refuse(c, err));
  }

  async hello(c, frame) {
    let hello = null;
    try { hello = JSON.parse(frame); } catch (_) { /* refused below */ }
    const code = this.activeCode();
    const r = await C.hostAccept(hello, { identity: this.identity, findDevice: id => this.data.devices.find(d => d.id === id), pairingCodes: code ? [code] : [] });
    const now = new Date().toISOString();
    let device = this.data.devices.find(d => d.id === r.device.id);
    if (r.paired) {
      this.pairing = null; // a code pairs one phone
      if (!device) { device = { ...r.device, pairedAt: now }; this.data.devices.push(device); }
      this.emit('paired', device);
    }
    device.lastSeenAt = now;
    this.save();
    c.device = device;
    c.channel = r.channel;
    this.toClient(c.id, JSON.stringify(r.welcome));
    await this.push(c, { ready: { name: computerName(), version: this.api.version, push: this.data.vapid.publicKey } });
    this.changed();
  }

  async message(c, frame) {
    const m = await c.channel.open(frame);
    c.heardAt = Date.now();
    if (typeof m.invoke === 'string') this.answer(c, m);
    else if (m.send === 'ui:focus') {
      // What the phone is looking at: it gets that session's or run's live output, and
      // looking at something counts as having seen it.
      c.focus = m.args?.[0] && typeof m.args[0] === 'object' ? { type: String(m.args[0].type), id: String(m.args[0].id) } : null;
      c.terminal.clear();
      if (c.focus) this.api.seen(c.focus);
    } else if (m.send === 'ui:visible') {
      c.visible = Boolean(m.args?.[0]); // on screen right now: no need to notify it
    } else if (SEND.has(m.send)) {
      try { this.api.send.get(m.send)?.(...(Array.isArray(m.args) ? m.args : [])); } catch (_) { /* a bad message from a phone changes nothing */ }
    }
  }

  async answer(c, m) {
    let reply;
    try {
      if (m.invoke === PUSH_SUBSCRIBE) {
        const sub = m.args?.[0];
        if (sub && !validSubscription(sub)) throw new Error('That isn’t a push subscription.');
        c.device.push = sub ? { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } } : undefined;
        this.save();
        this.changed();
        this.push(c, { id: m.id, ok: true }).catch(() => {});
        return;
      }
      const fn = INVOKE.has(m.invoke) && this.api.invoke.get(m.invoke);
      if (!fn) throw new Error('That isn’t available from a phone.');
      const args = Array.isArray(m.args) ? m.args : [];
      // The scrollback so far replaces anything still waiting to go out for that session.
      if (m.invoke === 'session:buffer') { this.flushTerminal(c, args[0], true); args[1] = BUFFER_TAIL; }
      reply = { id: m.id, ok: (await fn(...args)) ?? null };
    } catch (e) {
      reply = { id: m.id, err: String(e?.message || e) };
    }
    this.push(c, reply).catch(() => {});
  }

  async push(c, message) {
    if (!c.channel || this.clients.get(c.id) !== c) return;
    this.toClient(c.id, await c.channel.seal(message));
  }

  // Before the channel is up the phone is told why in the clear; a message that doesn't
  // decrypt afterwards means the channel is broken (or it isn't that phone): just hang up.
  refuse(c, err) {
    if (!c.channel) this.toClient(c.id, JSON.stringify({ t: 'refused', reason: String(err?.message || err) }));
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'drop', to: c.id }));
    this.forgetClient(c.id);
  }

  forgetClient(id) {
    const c = this.clients.get(id);
    if (!c) return;
    clearTimeout(c.stateTimer);
    for (const t of c.terminal.values()) clearTimeout(t.timer);
    this.clients.delete(id);
    if (c.channel) this.changed();
  }

  dropAll() { for (const id of [...this.clients.keys()]) this.forgetClient(id); }

  // --- what the app sends its window goes to the phones too ---
  broadcast(channel, args) {
    if (!EVENTS.has(channel) || !this.clients.size) return;
    // A session's or a run's own events go only to a phone that has it open.
    const about = channel.startsWith('session:') ? 'session' : channel === 'run:event' ? 'run' : null;
    for (const c of this.clients.values()) {
      if (!c.channel) continue;
      if (about && !(c.focus?.type === about && c.focus.id === args[0])) continue;
      if (channel === 'state:changed') this.pushState(c, args);
      else if (channel === 'session:data') this.pushTerminal(c, args);
      else {
        // Order matters to a terminal: what was printed before this goes out before it.
        if (about === 'session') this.flushTerminal(c, args[0]);
        this.push(c, { on: channel, args }).catch(() => {});
      }
    }
  }

  // The newest state, at most once a second.
  pushState(c, args) {
    c.state = args;
    if (c.stateTimer) return;
    const wait = Math.max(0, STATE_EVERY_MS - (Date.now() - (c.stateAt || 0)));
    c.stateTimer = setTimeout(() => {
      c.stateTimer = null;
      c.stateAt = Date.now();
      this.push(c, { on: 'state:changed', args: c.state }).catch(() => {});
    }, wait);
  }

  // Terminal output of the session a phone has open, a batch at a time: (id, seq of the last
  // chunk in it, the chunks joined).
  pushTerminal(c, [id, seq, data]) {
    let t = c.terminal.get(id);
    if (!t) { t = { seq, data: '', timer: null }; c.terminal.set(id, t); }
    t.seq = seq;
    t.data += data;
    if (!t.timer) t.timer = setTimeout(() => this.flushTerminal(c, id), TERMINAL_EVERY_MS);
  }

  flushTerminal(c, id, discard = false) {
    const t = c.terminal.get(id);
    if (!t) return;
    clearTimeout(t.timer);
    c.terminal.delete(id);
    if (!discard && t.data) this.push(c, { on: 'session:data', args: [id, t.seq, t.data] }).catch(() => {});
  }

  // --- notifications ---
  // Tells the paired phones that aren't looking at Stroll right now. `view`: what to open
  // when the notification is tapped.
  async notifyPhones({ title, body = '', view = null }) {
    if (!this.settings.enabled || !this.data?.vapid) return;
    const onScreen = new Set([...this.clients.values()].filter(c => c.channel && c.visible && Date.now() - c.heardAt < AWAY_MS).map(c => c.device.id));
    const subject = String(this.settings.appUrl || '').trim() || (this.url ? `${this.url.replace(/^ws/, 'http')}/` : 'https://github.com/');
    for (const device of this.data.devices) {
      if (device.push && !onScreen.has(device.id)) await this.pushTo(device, { title, body: String(body).slice(0, 300), view }, subject);
    }
  }

  // One push to one phone. What came of it is kept with the phone, for Settings to show: a
  // notification that never arrives is otherwise impossible to tell from one never sent.
  async pushTo(device, message, subject) {
    let result;
    try {
      result = await sendPush(device.push, message, { vapid: this.data.vapid, subject });
    } catch (e) {
      result = { ok: false, gone: false, status: 0, error: String(e?.message || e) }; // no network, or the push service is down
    }
    device.lastPush = { at: new Date().toISOString(), ok: result.ok, status: result.status };
    if (result.gone) device.push = undefined; // the phone unsubscribed, or its app data was cleared
    this.save();
    this.changed();
    return result;
  }

  // "Test" in Settings: sent whether or not the phone has Stroll on screen.
  async testPush(deviceId) {
    await this.load();
    const device = this.data.devices.find(d => d.id === deviceId);
    if (!device?.push) throw new Error('That phone hasn’t turned notifications on.');
    const subject = String(this.settings.appUrl || '').trim() || (this.url ? `${this.url.replace(/^ws/, 'http')}/` : 'https://github.com/');
    const r = await this.pushTo(device, { title: 'Stroll', body: `Notifications from ${computerName()} reach this phone.`, view: null }, subject);
    if (!r.ok) throw new Error(r.gone ? 'That phone is no longer subscribed. Turn notifications on again in the phone app.' : `The push service refused it (${r.status || r.error}).`);
    return true;
  }

  // --- pairing ---
  activeCode() {
    if (this.pairing && Date.now() > this.pairing.expiresAt) this.pairing = null;
    return this.pairing?.code || null;
  }

  // A one-time code, good for five minutes, as a link and its QR code. The link opens the
  // phone app with everything it needs after the #, which never leaves the phone.
  async startPairing() {
    if (!this.url) throw new Error('Turn on phone access and set the relay first.');
    await this.load();
    this.pairing = { code: C.randomId(16), expiresAt: Date.now() + PAIRING_MS };
    const app = String(this.settings.appUrl || '').trim() || `${this.url.replace(/^ws/, 'http')}/`;
    const link = `${app}#p=${C.encodePairing({ relay: this.url, room: this.room, hostPublicKey: this.identity.publicKey, code: this.pairing.code, name: computerName() })}`;
    const qr = qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    this.changed();
    return { link, qr: qr.createDataURL(4, 8), expiresAt: this.pairing.expiresAt };
  }

  cancelPairing() {
    this.pairing = null;
    this.changed();
  }

  // The phone is no longer let in, and is disconnected if it's here now.
  forget(deviceId) {
    if (!this.data) return;
    this.data.devices = this.data.devices.filter(d => d.id !== deviceId);
    this.save();
    for (const c of [...this.clients.values()]) {
      if (c.device?.id !== deviceId) continue;
      if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'drop', to: c.id }));
      this.forgetClient(c.id);
    }
    this.changed();
  }
}

// When paired phones are told about something, as chosen in Settings › Phone access:
//   away    only when the user isn't at Stroll on this computer (the default)
//   always  everything, even what they are looking at here
//   never
const NOTIFY_MODES = ['away', 'always', 'never'];
const notifyMode = mode => (NOTIFY_MODES.includes(mode) ? mode : 'away');
const phonesWanted = (mode, atComputer) => notifyMode(mode) === 'always' || (notifyMode(mode) === 'away' && !atComputer);

module.exports = { Remote, INVOKE, SEND, EVENTS, NOTIFY_MODES, notifyMode, phonesWanted };
