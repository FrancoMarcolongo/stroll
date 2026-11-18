// Stroll's relay: a Cloudflare Worker that passes messages between Stroll on a computer (the
// host) and that person's paired phones (clients). Each computer has a room, a Durable Object.
//
// The relay is a pipe. What goes through it is encrypted end to end (src/shared/channel.js in
// the app), so it can't read or forge anything, and it stores nothing: a message for a phone
// that isn't connected is dropped. All it decides is who may sit at the host's end of a room:
// whoever holds the key the room's name is the hash of.
import { DurableObject } from 'cloudflare:workers';

const MAX_MESSAGE = 4 * 1024 * 1024; // characters; a full state snapshot is a few hundred KB
const MAX_CLIENTS = 16;
// Both ends send "ping" every 25 seconds. A connection not heard from for this long is gone,
// whatever the network says: a phone that went into a pocket or changed network often leaves
// its connection open on this side and never closes it.
const STALE_MS = 90 * 1000;
const ROOM = /^\/v1\/room\/([A-Za-z0-9_-]{43})$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(ROOM);
    if (!m) return new Response(url.pathname === '/' ? 'Stroll relay\n' : 'Not found\n', { status: url.pathname === '/' ? 200 : 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket\n', { status: 426 });
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(request);
  },
};

const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const roomOf = async hostKey => b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hostKey)));
const json = obj => JSON.stringify(obj);

// Sockets hibernate: the object can be unloaded between messages, so nothing is kept in
// memory. Who a socket is lives in its tags and its attachment.
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Keep-alives are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // When this end last showed it was there: its latest keep-alive, or when it connected.
  heard(ws) {
    const ping = this.ctx.getWebSocketAutoResponseTimestamp(ws);
    return Math.max(ping ? ping.getTime() : 0, ws.deserializeAttachment()?.at || 0);
  }

  get staleMs() { return Number(this.env.STALE_MS) || STALE_MS; }

  // The computer's live connection: the one heard from last, and not one that went quiet.
  host() {
    const live = this.ctx.getWebSockets('host').filter(ws => ws.deserializeAttachment()?.ok && Date.now() - this.heard(ws) < this.staleMs);
    return live.sort((a, b) => this.heard(b) - this.heard(a))[0] || null;
  }

  // Closes the phone connections that went quiet, so they don't fill the room.
  sweep() {
    for (const ws of this.ctx.getWebSockets('client')) {
      if (Date.now() - this.heard(ws) < this.staleMs) continue;
      this.host()?.send(json({ t: 'close', from: ws.deserializeAttachment().id }));
      try { ws.close(4002, 'Not heard from'); } catch (_) { /* already gone */ }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const room = url.pathname.match(ROOM)[1];
    const asHost = url.searchParams.get('role') === 'host';
    if (!asHost) {
      this.sweep();
      if (this.ctx.getWebSockets('client').filter(ws => Date.now() - this.heard(ws) < this.staleMs).length >= MAX_CLIENTS) return new Response('Too many devices are connected to this computer\n', { status: 429 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    if (asHost) {
      // Not the host yet: its first message has to be the room's key.
      this.ctx.acceptWebSocket(server, ['host']);
      server.serializeAttachment({ role: 'host', room, ok: false, at: Date.now() });
    } else {
      const id = crypto.randomUUID().slice(0, 8);
      this.ctx.acceptWebSocket(server, ['client', `c:${id}`]);
      server.serializeAttachment({ role: 'client', id, at: Date.now() });
      const host = this.host();
      server.send(json({ relay: host ? 'host-online' : 'host-offline' }));
      host?.send(json({ t: 'open', from: id }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE) { ws.close(1009, 'Message too large'); return; }
    const who = ws.deserializeAttachment();
    if (who.role === 'client') {
      // A phone's messages go to the host as they are, labelled with who sent them.
      this.host()?.send(json({ t: 'msg', from: who.id, d: message }));
      return;
    }
    let m;
    try { m = JSON.parse(message); } catch (_) { ws.close(1003, 'Not JSON'); return; }
    if (!who.ok) {
      if (m.t !== 'host' || typeof m.key !== 'string' || await roomOf(m.key) !== who.room) { ws.close(4003, 'Not the host of this room'); return; }
      // The same computer connecting again (it restarted, its network changed) takes over.
      for (const old of this.ctx.getWebSockets('host')) if (old !== ws && old.deserializeAttachment()?.ok) old.close(4000, 'Replaced by a newer connection');
      ws.serializeAttachment({ ...who, ok: true, at: Date.now() });
      this.sweep();
      const clients = this.ctx.getWebSockets('client').filter(c => Date.now() - this.heard(c) < this.staleMs);
      ws.send(json({ t: 'hosting', clients: clients.map(c => c.deserializeAttachment().id) }));
      for (const c of clients) c.send(json({ relay: 'host-online' }));
      return;
    }
    const to = typeof m.to === 'string' ? this.ctx.getWebSockets(`c:${m.to}`)[0] : null;
    if (m.t === 'msg' && typeof m.d === 'string') {
      if (to) to.send(m.d);
      else ws.send(json({ t: 'close', from: m.to }));
    } else if (m.t === 'drop' && to) {
      to.close(4001, 'The computer closed the connection');
    }
  }

  async webSocketClose(ws, code) {
    const who = ws.deserializeAttachment();
    if (who?.role === 'client') this.host()?.send(json({ t: 'close', from: who.id }));
    // A replaced host (4000) leaves a live one behind; any other host leaving means offline.
    else if (who?.ok && code !== 4000 && !this.ctx.getWebSockets('host').some(h => h !== ws && h.deserializeAttachment()?.ok && Date.now() - this.heard(h) < this.staleMs)) {
      for (const c of this.ctx.getWebSockets('client')) c.send(json({ relay: 'host-offline' }));
    }
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'Closing'); } catch (_) { /* already closed */ }
  }

  async webSocketError(ws) { await this.webSocketClose(ws, 1011); }
}
