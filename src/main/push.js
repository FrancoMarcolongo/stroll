// Web Push, sent by this computer straight to a paired phone's browser, through the push
// service that browser uses (Google's for Chrome). No server of Stroll's is involved, and the
// push service can't read what it carries: the message is encrypted to keys only the phone's
// browser holds (RFC 8291), and signed so the service knows it's from the sender the phone
// subscribed to (VAPID, RFC 8292).
const { webcrypto } = require('crypto');
const C = require('../shared/channel');

const { subtle } = webcrypto;
const utf8 = s => new TextEncoder().encode(s);
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) { out.set(new Uint8Array(p), at); at += p.byteLength; }
  return out;
};
async function hkdf(secret, salt, info, bytes) {
  const key = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

// The key pair that identifies this computer to push services. The phone subscribes with the
// public half, so only this computer can push to it.
async function newVapidKeys() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  return { privateKey: await subtle.exportKey('jwk', pair.privateKey), publicKey: C.b64u(await subtle.exportKey('raw', pair.publicKey)) };
}

// "aes128gcm" content coding with the Web Push key schedule: one record, salt and the
// sender's one-time public key in its header.
async function encrypt(subscription, plaintext) {
  const phoneKey = C.unb64u(subscription.keys.p256dh);
  const auth = C.unb64u(subscription.keys.auth);
  const mine = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const myKey = new Uint8Array(await subtle.exportKey('raw', mine.publicKey));
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: await subtle.importKey('raw', phoneKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []) }, mine.privateKey, 256));
  const ikm = await hkdf(shared, auth, concat(utf8('WebPush: info\0'), phoneKey, myKey), 32);
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const key = await subtle.importKey('raw', await hkdf(ikm, salt, utf8('Content-Encoding: aes128gcm\0'), 16), 'AES-GCM', false, ['encrypt']);
  const nonce = await hkdf(ikm, salt, utf8('Content-Encoding: nonce\0'), 12);
  // 0x02 marks the last (here the only) record.
  const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1 + myKey.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = myKey.length;
  header.set(myKey, 21);
  return concat(header, sealed);
}

// A short-lived token saying who is pushing, signed with the VAPID key.
async function vapidToken(endpoint, vapid, subject) {
  const head = C.b64u(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = C.b64u(utf8(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await subtle.importKey('jwk', vapid.privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(`${head}.${claims}`));
  return `${head}.${claims}.${C.b64u(signature)}`;
}

const validSubscription = s => Boolean(s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint)
  && typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string');

// Sends one message. Resolves with { ok, gone, status }: `gone` means the phone's subscription
// no longer exists (it was revoked, or the app's data was cleared) and should be forgotten.
async function sendPush(subscription, message, { vapid, subject, ttl = 3600, fetchImpl = fetch } = {}) {
  const body = await encrypt(subscription, utf8(JSON.stringify(message)));
  const res = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: 'high',
      Authorization: `vapid t=${await vapidToken(subscription.endpoint, vapid, subject)}, k=${vapid.publicKey}`,
    },
    body,
  });
  return { ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410, status: res.status };
}

module.exports = { newVapidKeys, sendPush, validSubscription, encrypt, vapidToken };
