// The phone's connection to Stroll on the computer: pairing, the encrypted channel
// (channel.js), and staying connected. The screen (app.js) sits on top of it and never sees a
// key.
//
// What the phone keeps, in this browser's own storage and nowhere else: its private key, which
// the browser will use but never hand out, and which computer it is paired with. No state of
// the computer is stored here: close the page and nothing of your work stays on the phone.
(function () {
  const C = self.StrollChannel;
  const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000];
  const PING_MS = 25 * 1000;
  const SILENT_MS = 70 * 1000;
  const ANSWER_MS = 20 * 1000;
  const HANDSHAKE_MS = 12 * 1000; // the computer answers a hello in well under a second

  // --- a small key-value store in IndexedDB (it can hold keys that can't be read out) ---
  function db() {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('stroll', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }
  async function kv(mode, fn) {
    const d = await db();
    try {
      return await new Promise((resolve, reject) => {
        const tx = d.transaction('kv', mode);
        const req = fn(tx.objectStore('kv'));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
      });
    } finally { d.close(); }
  }
  const load = key => kv('readonly', s => s.get(key));
  const save = (key, value) => kv('readwrite', s => s.put(value, key));
  const remove = key => kv('readwrite', s => s.delete(key));

  // States: unpaired · connecting · offline (the computer isn't on the relay) · online ·
  // refused (the computer won't have this phone: `reason` says why).
  class Link {
    constructor() {
      this.state = 'connecting';
      this.reason = null;
      this.stage = 'relay'; // while connecting: 'relay' (reaching it) or 'computer' (waiting for its answer)
      this.computer = null; // { relay, room, hostPublicKey, name }
      this.identity = null;
      this.ready = null; // what the computer said about itself: { name, version }
      this.listeners = new Map();
      this.calls = new Map();
      this.seq = 0;
      this.attempt = 0;
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.wake(); });
      addEventListener('online', () => this.wake());
    }

    on(channel, fn) {
      if (!this.listeners.has(channel)) this.listeners.set(channel, new Set());
      this.listeners.get(channel).add(fn);
    }

    emit(channel, ...args) { for (const fn of this.listeners.get(channel) || []) fn(...args); }

    set(state, reason = null) {
      if (this.state === state && this.reason === reason) return;
      this.state = state;
      this.reason = reason;
      this.emit('link', state, reason);
    }

    // Reads what this phone has stored. `code`: a pairing code from the address, if it was
    // opened from one.
    async start(code = null) {
      this.identity = await load('identity');
      this.computer = await load('computer');
      if (code) {
        let pairing;
        try { pairing = C.decodePairing(code); } catch (e) { this.set('refused', 'That pairing code can’t be read. Show a new one on the computer.'); return; }
        if (!this.identity) {
          const pair = await C.newKeyPair(false); // not extractable: it never leaves this browser
          this.identity = { privateKey: pair.privateKey, publicKey: await C.exportPublic(pair.publicKey) };
          await save('identity', this.identity);
        }
        this.pending = pairing;
        this.computer = { relay: pairing.relay, room: pairing.room, hostPublicKey: pairing.hostPublicKey, name: pairing.name };
      }
      if (!this.computer || !this.identity) { this.set('unpaired'); return; }
      this.connect();
    }

    // A pairing code opened while the app is already running: start over with it.
    async pair(code) {
      clearTimeout(this.retry);
      this.closeSocket();
      this.failCalls('Pairing again');
      this.attempt = 0;
      this.ready = null;
      this.state = 'connecting';
      this.reason = null;
      await this.start(code);
    }

    connect() {
      clearTimeout(this.retry);
      this.closeSocket();
      this.stage = 'relay';
      if (this.state !== 'offline') this.set('connecting');
      let ws;
      try { ws = new WebSocket(`${this.computer.relay}/v1/room/${this.computer.room}?role=client`); } catch (_) { this.lost(); return; }
      this.ws = ws;
      this.channel = null;
      this.heard = Date.now();
      // One message at a time, in order: the handshake takes a moment to finish and the
      // computer's first encrypted message is already on its way.
      let work = Promise.resolve();
      ws.onmessage = e => { if (ws === this.ws) work = work.then(() => this.receive(ws, e.data)).catch(() => this.broken(ws)); };
      ws.onclose = () => { if (ws === this.ws) this.lost(); };
      ws.onerror = () => { /* a close follows */ };
      clearInterval(this.pinger);
      this.pinger = setInterval(() => {
        if (ws !== this.ws) return;
        if (Date.now() - this.heard > SILENT_MS) this.lost();
        else if (ws.readyState === 1) ws.send('ping');
      }, PING_MS);
    }

    async receive(ws, raw) {
      this.heard = Date.now();
      if (raw === 'pong') return;
      const m = JSON.parse(raw);
      if (m.relay === 'host-offline') { this.channel = null; this.failCalls('The computer went offline'); this.set('offline'); return; }
      if (m.relay === 'host-online') {
        // The computer is there: introduce ourselves (with the pairing code the first time).
        this.hello = await C.clientHello({ identity: this.identity, hostPublicKey: this.computer.hostPublicKey, pairing: this.pending ? { code: this.pending.code, name: await deviceName() } : null });
        this.stage = 'computer';
        this.set('connecting');
        this.emit('link', this.state, this.reason);
        ws.send(JSON.stringify(this.hello.hello));
        // No answer means this connection is no good (the relay lost track of the computer,
        // or of us): don't sit on it, start a new one.
        clearTimeout(this.handshake);
        this.handshake = setTimeout(() => { if (ws === this.ws && this.state !== 'online') this.lost(); }, HANDSHAKE_MS);
        return;
      }
      if (m.t === 'refused') { this.refused(m.reason); return; }
      if (m.t === 'welcome') { this.channel = await this.hello.finish(m); return; }
      if (m.t !== 'm' || !this.channel) return;
      const msg = await this.channel.open(raw); // throws if it isn't from the computer: see broken()
      if (msg.ready) {
        // Its first message opened, so it holds the key we paired with: it is our computer.
        clearTimeout(this.handshake);
        this.ready = msg.ready;
        this.attempt = 0;
        if (this.pending) { this.pending = null; await save('computer', this.computer); }
        if (msg.ready.name && msg.ready.name !== this.computer.name) { this.computer.name = msg.ready.name; await save('computer', this.computer); }
        this.set('online');
      } else if (msg.on) this.emit(msg.on, ...(msg.args || []));
      else if (this.calls.has(msg.id)) {
        const call = this.calls.get(msg.id);
        this.calls.delete(msg.id);
        clearTimeout(call.timer);
        if ('err' in msg) call.reject(new Error(msg.err)); else call.resolve(msg.ok);
      }
    }

    // The computer said no. With a pairing code that's a bad code; without one, this phone was
    // removed there. Either way, trying again won't help.
    refused(reason) {
      const pairing = Boolean(this.pending);
      this.pending = null;
      clearTimeout(this.retry);
      clearInterval(this.pinger);
      this.closeSocket();
      this.set('refused', reason || (pairing ? 'The computer refused that pairing code.' : 'This phone isn’t paired with that computer.'));
    }

    // A message that didn't decrypt: this connection can't be trusted or used. Start over.
    broken(ws) {
      if (ws !== this.ws) return;
      this.lost();
    }

    lost() {
      if (this.state === 'refused' || this.state === 'unpaired') return;
      this.closeSocket();
      this.failCalls('The connection dropped');
      if (this.state === 'online') this.set('connecting');
      const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
      this.attempt += 1;
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.connect(), wait);
      this.emit('link', this.state, this.reason); // the screen says how it's going
    }

    closeSocket() {
      const ws = this.ws;
      this.ws = null;
      this.channel = null;
      clearInterval(this.pinger);
      clearTimeout(this.handshake);
      try { ws?.close(); } catch (_) { /* gone */ }
    }

    failCalls(why) {
      for (const call of this.calls.values()) { clearTimeout(call.timer); call.reject(new Error(why)); }
      this.calls.clear();
    }

    // The page came back to the front, or the network did: don't wait out a backoff. `now`:
    // the user asked to try again.
    wake(now = false) {
      if (!this.computer || this.state === 'refused' || this.state === 'unpaired') return;
      if (now || !this.ws || this.ws.readyState > 1 || Date.now() - this.heard > SILENT_MS) { this.attempt = 0; this.connect(); }
      else if (this.ws.readyState === 1) this.ws.send('ping');
    }

    async invoke(channel, ...args) {
      if (this.state !== 'online' || !this.channel) throw new Error('Not connected to the computer');
      this.seq += 1;
      const id = this.seq;
      const answer = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.calls.delete(id); reject(new Error('The computer didn’t answer')); }, ANSWER_MS);
        this.calls.set(id, { resolve, reject, timer });
      });
      this.ws.send(await this.channel.seal({ id, invoke: channel, args }));
      return answer;
    }

    async send(channel, ...args) {
      if (this.state !== 'online' || !this.channel) return;
      this.ws.send(await this.channel.seal({ send: channel, args }));
    }

    // Forget the computer (and this phone's key): pairing again starts from scratch.
    async forget() {
      clearTimeout(this.retry);
      this.closeSocket();
      await remove('computer');
      await remove('identity');
      this.computer = null;
      this.identity = null;
      this.set('unpaired');
    }
  }

  // What the computer lists this phone as: its model where the browser says ("Pixel 9").
  // Chrome on Android now puts a placeholder ("K") in the user agent and gives the model
  // only when asked.
  async function deviceName() {
    try {
      const { model } = await navigator.userAgentData.getHighEntropyValues(['model']);
      if (model) return model;
    } catch (_) { /* not a browser that has it */ }
    const ua = navigator.userAgent;
    const android = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\)|;)/);
    if (android && android[1].trim() !== 'K') return android[1].trim();
    if (/Android/.test(ua)) return 'Android phone';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    return /Mobile/.test(ua) ? 'Phone' : 'Browser';
  }

  self.StrollLink = Link;
}());
