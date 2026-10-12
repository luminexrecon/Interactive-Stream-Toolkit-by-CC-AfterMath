# Stream Toolkit

A self-hosted set of OBS overlays for a YouTube live stream: a viewer-triggered
prize spinner and two live-chat currency auctions, all kept in sync in real
time between your Control Panel tab and your OBS Browser Source over
WebSocket. No external services, no database, no build step -- plain
Node.js + local JSON files, running entirely on your own PC alongside OBS.

## What's included

1. **Point Spinner** -- viewers earn a chat-based currency (`Points` by
   default, renamable -- see [docs/CONFIGURATION.md](docs/CONFIGURATION.md))
   just by chatting, and spend it on `!spin` to win a random prize from a
   pool you configure. Spins play out live on an OBS overlay.
2. **Live Auction** -- an auction that runs entirely through YouTube live
   chat (`!joinbid`, `!bid`), priced in the same chat-earned currency as
   Point Spinner. One auction at a time; being outbid refunds you in full.
3. **Exclusive Auction** -- a second, independent auction using a *second*
   currency (`Premium Points` by default) that is never earned automatically
   -- a moderator has to manually `!give` it to someone. This currency also
   depreciates by a configurable percentage every month. Comes with a
   test panel so you can rehearse an auction with dummy bidders, without a
   live stream running.

Each model is a self-contained folder: `control.html` (an admin panel you
open in a normal browser tab), `overlay.html` (what you add to OBS as a
Browser Source), and sometimes `winner.html` (a separate ~3-minute
win-announcement Browser Source).

## Everything runs locally

This toolkit is not a hosted service -- there's no server to deploy, no
domain, no HTTPS to set up. You run it the same way you run OBS itself:

- `server.js` runs on your own PC (`http://localhost:3000` by default).
- OBS Browser Sources point at plain `http://localhost:3000/...` URLs --
  OBS loads local HTTP fine, no certificate needed.
- `bot/bot.js` (the YouTube chat bot) also runs on the same PC and talks to
  `server.js` over `ws://localhost:3000/...` -- nothing needs to be exposed
  to the internet.
- Only needs to be running while you're actually streaming, same lifecycle
  as OBS. Close the terminal windows when you're done; there's nothing to
  "keep alive" in the background.

## Architecture

```
                 ┌─────────────────────────────────────────┐
  YouTube live   │               server.js                  │
  chat           │  (plain HTTP + 4 WebSocket namespaces)   │
     │           │                                           │
     │  polls    │   /point-spinner/ws  ──┐                  │
     ▼           │   /economy/ws         │  read/write       │       Control Panel
 bot/bot.js ─────┼──►/live-auction/ws    ├─ local JSON ───┐  │        (browser tab)
 (one Node       │   /exclusive-         │  files under   │  │             │
  process)       │    auction/ws       ──┘  data/         │  │   same WS   │
                 │                                        │  │  namespace  │
                 └────────────────────────────────────────┼──┘             │
                                                            │               ▼
                                               OBS Browser Source
                                              (overlay.html / winner.html)
```

`server.js` is the only process with state. `bot/bot.js` is a thin client
that polls YouTube's live chat API and relays commands to `server.js` over
WebSocket -- restarting the bot never loses any balances or item lists,
since those live in `data/*.json`, not in the bot process.

## Quickstart

1. `npm install`
2. `cp .env.example .env` and fill in the values (currency names, your
   YouTube channel ID, ...) -- see
   [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for what each one does.
3. Set up a Google Cloud project + OAuth credentials for the YouTube bot --
   see [docs/SETUP.md](docs/SETUP.md) for the full walkthrough (one-time
   setup). Then authorize the two accounts the bot needs:
   ```
   node bot/authorize.js main
   node bot/authorize.js bot
   ```
4. Start the server: `npm start` (or `node server.js`)
5. In a separate terminal, start the bot: `node bot/bot.js`
6. Open the control panels in a browser to add prizes/start auctions, e.g.
   `http://localhost:3000/point-spinner/control`
7. Add the matching overlay URLs as OBS Browser Sources, e.g.
   `http://localhost:3000/point-spinner/overlay` -- see
   [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full URL list and
   recommended dimensions.

## Project layout

```
server.js                 main server (static files, uploads, WebSocket)
bot/
  bot.js                  YouTube live chat bot
  authorize.js             one-time OAuth login helper
  economy.js               currency helper functions used by bot.js
  wsClients.js              WebSocket clients bot.js uses to talk to server.js
point-spinner/             Point Spinner control panel + overlay + winner
live-auction/               Live Auction control panel + overlay
exclusive-auction/          Exclusive Auction control panel + overlay +
                            winner + a standalone test panel
data/                       generated at runtime: balances, item lists,
                            auction state (gitignored)
uploads/                    generated at runtime: uploaded prize images
                            (gitignored)
docs/
  SETUP.md                 Google Cloud / YouTube API / OAuth walkthrough
  CONFIGURATION.md          full .env reference, OBS setup, renaming
                            currencies
```

## No test suite

There's no automated test suite or build step. Verify changes by running
the server and bot and exercising them directly (a browser tab for the
control panels, OBS or a plain browser tab for the overlays).

Support this little streamer :D [Donate here](https://sociabuzz.com/aftermathaoe/tribe)
