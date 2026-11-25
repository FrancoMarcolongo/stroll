// The encrypted channel between the computer and a paired phone (src/shared/channel.js): pairing,
// reconnecting, and that the relay in between can't read, forge, replay or reorder messages.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/shared/channel');

async function identity(extractable) {
  const keys = await C.newKeyPair(extractable);
  return { privateKey: keys.privateKey, publicKey: await C.exportPublic(keys.publicKey) };
}

// A computer, a phone, and the phone paired with the code shown on the computer.
async function paired() {
  const host = await identity(true);
  const phone = await identity(false);
  const devices = new Map();
  const findDevice = id => devices.get(id);
  const { hello, finish } = await C.clientHello({ identity: phone, hostPublicKey: host.publicKey, pairing: { code: 'code-123', name: 'Pixel' } });
  const accepted = await C.hostAccept(hello, { identity: host, findDevice, pairingCodes: ['other', 'code-123'] });
  devices.set(accepted.device.id, accepted.device);
  return { host, phone, findDevice, accepted, phoneChannel: await finish(accepted.welcome) };
}

test('pairing: the computer learns the phone with the right code, and both can talk', async () => {
  const { accepted, phoneChannel } = await paired();
  assert.equal(accepted.paired, 'code-123');
  assert.equal(accepted.device.name, 'Pixel');
  assert.deepEqual(await accepted.channel.open(await phoneChannel.seal({ hi: 'computer' })), { hi: 'computer' });
  assert.deepEqual(await phoneChannel.open(await accepted.channel.seal({ hi: 'phone' })), { hi: 'phone' });
});

test('pairing with a wrong or used code is refused', async () => {
  const host = await identity(true);
  const phone = await identity(false);
  const { hello } = await C.clientHello({ identity: phone, hostPublicKey: host.publicKey, pairing: { code: 'guess', name: 'x' } });
  await assert.rejects(C.hostAccept(hello, { identity: host, findDevice: () => null, pairingCodes: ['code-123'] }), /expired or was already used/);
});

test('a paired phone reconnects without a code; an unpaired one can’t', async () => {
  const { host, phone, findDevice } = await paired();
  const again = await C.clientHello({ identity: phone, hostPublicKey: host.publicKey });
  const accepted = await C.hostAccept(again.hello, { identity: host, findDevice });
  const channel = await again.finish(accepted.welcome);
  assert.deepEqual(await accepted.channel.open(await channel.seal('back')), 'back');

  const stranger = await identity(false);
  const theirs = await C.clientHello({ identity: stranger, hostPublicKey: host.publicKey });
  await assert.rejects(C.hostAccept(theirs.hello, { identity: host, findDevice }), /isn’t paired/);
});

test('messages arrive in the order they were sealed, even when sealed together', async () => {
  const { accepted, phoneChannel } = await paired();
  const frames = await Promise.all([1, 2, 3].map(n => phoneChannel.seal({ n })));
  for (const [i, f] of frames.entries()) assert.deepEqual(await accepted.channel.open(f), { n: i + 1 });
});

test('a replayed, reordered or altered frame fails, and the channel is dead after', async () => {
  for (const attack of ['replay', 'reorder', 'alter']) {
    const { accepted, phoneChannel } = await paired();
    const a = await phoneChannel.seal('a');
    const b = await phoneChannel.seal('b');
    if (attack === 'replay') {
      await accepted.channel.open(a);
      await assert.rejects(accepted.channel.open(a), /could not be decrypted/, attack);
    } else if (attack === 'reorder') {
      await assert.rejects(accepted.channel.open(b), /could not be decrypted/, attack);
    } else {
      const m = JSON.parse(a);
      m.d = m.d.slice(0, -4) + (m.d.endsWith('AAAA') ? 'BBBB' : 'AAAA');
      await assert.rejects(accepted.channel.open(JSON.stringify(m)), /could not be decrypted/, attack);
    }
    await assert.rejects(accepted.channel.open(b), /closed|could not be decrypted/, `${attack}: dead after`);
  }
});

test('the pairing link carries the relay, room, key, code and name', () => {
  const p = { relay: 'wss://relay.example', room: 'room1', hostPublicKey: 'key', code: 'code-123', name: 'Mac' };
  assert.deepEqual(C.decodePairing(C.encodePairing(p)), p);
});
