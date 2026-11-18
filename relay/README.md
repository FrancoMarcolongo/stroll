# Stroll relay

Passes messages between Stroll on a computer and that person's paired phones. It's a pipe:
what goes through it is encrypted between the two ends (`src/shared/channel.js`), so the relay
can't read or forge it, and it stores nothing.

Each computer has a room, named after the hash of a key only that computer holds. Whoever
presents the key hosts the room; anyone else who connects to it is a phone, and gets nowhere
unless the computer has paired it.

A Cloudflare Worker with one Durable Object per room. The free plan covers it (SQLite-backed
objects, daily limits; when a limit is hit, connections fail until the next day).

## Run it locally

```
npm install
npm run dev        # ws://127.0.0.1:8787
```

Then in Stroll: Settings › Phone access › Relay: `ws://127.0.0.1:8787`.

## Deploy it

```
npx wrangler login
npm run deploy
```

Wrangler prints the address (`https://stroll-relay.<account>.workers.dev`). The relay to set
in Stroll is the same with `wss://` in front.

## What it speaks

`GET /v1/room/<room>?role=host|client`, upgraded to a WebSocket.

- **Host** (Stroll on the computer). First message `{"t":"host","key":…}`; the relay checks
  that the room is the key's hash, answers `{"t":"hosting","clients":[…]}`, and closes with
  4003 otherwise. From then on it receives `{"t":"open","from":id}`, `{"t":"msg","from":id,"d":…}`
  and `{"t":"close","from":id}`, and sends `{"t":"msg","to":id,"d":…}` or `{"t":"drop","to":id}`.
  A host that connects again takes the place of the old connection (closed with 4000).
- **Client** (a phone). It is told `{"relay":"host-online"}` or `{"relay":"host-offline"}`, now
  and whenever that changes. Everything else it sends goes to the host as is, and everything
  the host sends it arrives as is.
- Either side may send the text `ping`; the answer is `pong`.
