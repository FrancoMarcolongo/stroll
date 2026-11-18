// The encrypted channel between Stroll on a computer (the host) and a paired phone (the client).
// Runs as-is in Node (the app) and in a browser (the phone), on WebCrypto only.
//
// The relay between them is not trusted: it passes these messages along and can't read or
// forge them. What makes that so:
//  - Each side has a long-lived ECDH P-256 key. They learn each other's public key when the
//    phone is paired: the computer's travels in the QR code, the phone's in its first hello,
//    sealed with a key only someone holding the one-time pairing code can derive.
//  - Every connection mixes a fresh key exchange (so recorded traffic stays unreadable if a
//    long-lived key leaks later) with one between the long-lived keys (so only the paired
//    phone and its computer can derive the session keys). There is nothing else to check: a
//    side that isn't who it claims to be can't produce a message that decrypts.
//  - After that every message is AES-256-GCM, one key per direction, numbered by a counter
//    neither side sends. A dropped, repeated or reordered message fails to decrypt.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StrollChannel = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const subtle = globalThis.crypto.subtle;
  const VERSION = 1;
  const CURVE = { name: 'ECDH', namedCurve: 'P-256' };
  const utf8 = s => new TextEncoder().encode(s);
  const text = bytes => new TextDecoder().decode(bytes);

  function b64u(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(str) {
    const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
    return out;
  }
  const randomId = (bytes = 16) => b64u(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
  const sha256 = async bytes => new Uint8Array(await subtle.digest('SHA-256', bytes));
  function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) { out.set(new Uint8Array(p), at); at += p.byteLength; }
    return out;
  }

  // --- keys ---
  // `extractable` false keeps a private key inside the browser's key store (it can be used,
  // never read out); the app keeps its own in a private file, so there it has to be true.
  const newKeyPair = (extractable = false) => subtle.generateKey(CURVE, extractable, ['deriveBits']);
  const exportPublic = async key => b64u(await subtle.exportKey('raw', key));
  const importPublic = pub => subtle.importKey('raw', unb64u(pub), CURVE, true, []);
  const exportPrivate = key => subtle.exportKey('jwk', key);
  const importPrivate = jwk => subtle.importKey('jwk', jwk, CURVE, true, ['deriveBits']);
  const deviceId = async pub => b64u(await sha256(unb64u(pub))).slice(0, 22);
  // A room on the relay belongs to whoever holds the key it's the hash of.
  const roomOf = async hostKey => b64u(await sha256(utf8(hostKey)));

  const dh = async (priv, pub) => new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
  async function hkdf(secret, salt, info, bytes) {
    const key = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info) }, key, bytes * 8));
  }
  const aesKey = raw => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

  // --- pairing: the phone's public key and name, readable only with the pairing code ---
  const pairKey = async (shared, code) => aesKey(await hkdf(shared, utf8(code), 'stroll pair v1', 32));
  async function sealPairing(shared, code, body) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const box = await subtle.encrypt({ name: 'AES-GCM', iv }, await pairKey(shared, code), utf8(JSON.stringify(body)));
    return { iv: b64u(iv), box: b64u(box) };
  }
  async function openPairing(shared, code, sealed) {
    try {
      return JSON.parse(text(await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(sealed.iv) }, await pairKey(shared, code), unb64u(sealed.box))));
    } catch (_) {
      return null; // not this code
    }
  }

  // --- the session: one key per direction, a counter as the nonce ---
  function nonce(n) {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, BigInt(n));
    return iv;
  }
  class Channel {
    constructor(sendKey, receiveKey) {
      this.sendKey = sendKey;
      this.receiveKey = receiveKey;
      this.sent = 0;
      this.received = 0;
      this.outbox = Promise.resolve();
      this.inbox = Promise.resolve();
    }

    // Messages are numbered when they're handed over, and encrypted and delivered in that
    // order, even if several are sent before the first is done.
    seal(message) {
      const n = this.sent;
      this.sent += 1;
      const work = this.outbox.then(async () => JSON.stringify({
        t: 'm', d: b64u(await subtle.encrypt({ name: 'AES-GCM', iv: nonce(n) }, this.sendKey, utf8(JSON.stringify(message)))),
      }));
      this.outbox = work.catch(() => {});
      return work;
    }

    // Rejects when the frame isn't the next one this channel's peer sent. After that the
    // channel is dead (the counters no longer agree): drop the connection.
    open(frame) {
      const work = this.inbox.then(async () => {
        if (this.broken) throw new Error('The channel is closed');
        try {
          const m = typeof frame === 'string' ? JSON.parse(frame) : frame;
          if (!m || m.t !== 'm' || typeof m.d !== 'string') throw new Error('not a message');
          const plain = await subtle.decrypt({ name: 'AES-GCM', iv: nonce(this.received) }, this.receiveKey, unb64u(m.d));
          this.received += 1;
          return JSON.parse(text(plain));
        } catch (_) {
          this.broken = true;
          throw new Error('A message could not be decrypted');
        }
      });
      this.inbox = work.catch(() => {});
      return work;
    }
  }

  async function sessionKeys({ ephPriv, ephPub, staticPriv, staticPub, bind }) {
    const secret = concat(await dh(ephPriv, ephPub), await dh(staticPriv, staticPub));
    const okm = await hkdf(secret, await sha256(utf8(JSON.stringify(bind))), 'stroll session v1', 64);
    return { c2h: await aesKey(okm.slice(0, 32)), h2c: await aesKey(okm.slice(32)) };
  }
  // Everything both sides must agree on, or the keys come out different.
  const binding = (dev, clientEph, hostEph, hostPub, clientPub) => [VERSION, dev, clientEph, hostEph, hostPub, clientPub];

  // --- the phone's side ---
  // `identity`: its key pair { privateKey, publicKey: exported }. `hostPublicKey`: the
  // computer's, from the QR code. `pairing` (first time only): { code, name }.
  // Returns the hello to send and `finish(welcome)`, which gives the channel. The computer is
  // who it claims to be once its first message opens.
  async function clientHello({ identity, hostPublicKey, pairing = null }) {
    const eph = await newKeyPair(false);
    const ephPub = await exportPublic(eph.publicKey);
    const hostPub = await importPublic(hostPublicKey);
    const dev = await deviceId(identity.publicKey);
    const hello = { t: 'hello', v: VERSION, dev, eph: ephPub };
    if (pairing) hello.pair = await sealPairing(await dh(eph.privateKey, hostPub), pairing.code, { pub: identity.publicKey, name: String(pairing.name || '').slice(0, 60) });
    return {
      hello,
      async finish(welcome) {
        if (!welcome || welcome.t !== 'welcome' || typeof welcome.eph !== 'string') throw new Error(welcome?.reason || 'The computer refused the connection');
        const keys = await sessionKeys({
          ephPriv: eph.privateKey, ephPub: await importPublic(welcome.eph), staticPriv: identity.privateKey, staticPub: hostPub,
          bind: binding(dev, ephPub, welcome.eph, hostPublicKey, identity.publicKey),
        });
        return new Channel(keys.c2h, keys.h2c);
      },
    };
  }

  // --- the computer's side ---
  // `identity`: { privateKey, publicKey: exported }. `findDevice(id)` gives a paired device
  // ({ publicKey, … }) or nothing. `pairingCodes`: the codes waiting to be used.
  // Returns { welcome, channel, device, paired: the code a new device used, if it just paired }.
  // Throws with a reason fit to show on the phone when the hello isn't from a paired device.
  async function hostAccept(hello, { identity, findDevice, pairingCodes = [] }) {
    if (!hello || hello.t !== 'hello' || typeof hello.dev !== 'string' || typeof hello.eph !== 'string') throw new Error('Not a Stroll connection');
    if (hello.v !== VERSION) throw new Error('This phone and this computer run versions of Stroll that can’t talk to each other. Update both.');
    const clientEph = await importPublic(hello.eph);
    let device = findDevice(hello.dev);
    let paired = null;
    if (hello.pair) {
      const shared = await dh(identity.privateKey, clientEph);
      for (const code of pairingCodes) {
        const body = await openPairing(shared, code, hello.pair);
        if (body && typeof body.pub === 'string' && await deviceId(body.pub) === hello.dev) {
          device = { id: hello.dev, name: String(body.name || '').slice(0, 60) || 'Phone', publicKey: body.pub };
          paired = code;
          break;
        }
      }
      if (!paired) throw new Error('That pairing code has expired or was already used. Show a new one on the computer.');
    }
    if (!device) throw new Error('This phone isn’t paired with that computer.');
    const eph = await newKeyPair(false);
    const ephPub = await exportPublic(eph.publicKey);
    const keys = await sessionKeys({
      ephPriv: eph.privateKey, ephPub: clientEph, staticPriv: identity.privateKey, staticPub: await importPublic(device.publicKey),
      bind: binding(hello.dev, hello.eph, ephPub, identity.publicKey, device.publicKey),
    });
    return { welcome: { t: 'welcome', eph: ephPub }, channel: new Channel(keys.h2c, keys.c2h), device, paired };
  }

  // What the QR code carries: where the relay is, which room, the computer's public key and
  // the one-time code. It goes after the # of the phone app's address, which browsers keep to
  // themselves.
  const encodePairing = p => b64u(utf8(JSON.stringify({ v: VERSION, r: p.relay, d: p.room, k: p.hostPublicKey, c: p.code, n: p.name })));
  function decodePairing(s) {
    const p = JSON.parse(text(unb64u(s)));
    if (p.v !== VERSION) throw new Error('This pairing code is from another version of Stroll.');
    return { relay: p.r, room: p.d, hostPublicKey: p.k, code: p.c, name: p.n };
  }

  return {
    VERSION, b64u, unb64u, randomId, newKeyPair, exportPublic, importPublic, exportPrivate, importPrivate, deviceId, roomOf,
    clientHello, hostAccept, encodePairing, decodePairing, Channel,
  };
}));
