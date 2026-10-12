# Configuration

## `.env` reference

Copy `.env.example` to `.env` and fill these in. Every variable has a
working default except `YOUTUBE_CHANNEL_ID`.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port `server.js` listens on. OBS Browser Source URLs and the bot both use `http(s)://localhost:<PORT>`. |
| `CURRENCY_NAME` | `Points` | Display name for the currency everyone earns by chatting, used by Point Spinner (`!spin`) and Live Auction (`!bid`). |
| `CURRENCY_PER_MESSAGE` | `1` | How much `CURRENCY_NAME` a viewer earns per eligible chat message. Only the *initial* default -- after first run it lives in `data/point-spinner-state.json` and is editable live from the Point Spinner control panel. |
| `CURRENCY_MESSAGE_COOLDOWN_SECONDS` | `15` | Minimum seconds between two messages counting as "eligible to earn" for the same viewer. Same initial-default-only behavior as above. |
| `EXCLUSIVE_CURRENCY_NAME` | `Premium Points` | Display name for the second currency, used only by Exclusive Auction. Never earned automatically -- only granted via `!give` or the control panel's "give" form. |
| `EXCLUSIVE_CURRENCY_DEPRECIATION_PERCENT` | `5` | Percentage shaved off every `EXCLUSIVE_CURRENCY_NAME` balance once a month (checked hourly, applied once per newly-completed month). Set to `0` to disable. |
| `YOUTUBE_CHANNEL_ID` | *(none, required)* | The channel ID (`UC...`) you stream on. See [SETUP.md](SETUP.md). |
| `YOUTUBE_CLIENT_SECRET_PATH` | `./bot/client_secret.json` | Where the bot looks for the Google Cloud OAuth client JSON. |
| `YOUTUBE_TOKENS_DIR` | `./bot/tokens` | Where `bot/authorize.js` saves OAuth tokens (`main.json`, `bot.json`). |

## Renaming the currencies

Setting `CURRENCY_NAME` / `EXCLUSIVE_CURRENCY_NAME` in `.env` immediately
changes:

- everything `bot/bot.js` says in chat (balances, bid confirmations, error
  messages)
- the server's own startup/console log lines

It does **not** change the static display text baked into the Live
Auction / Exclusive Auction overlay and control panel pages -- this
project has no build step or templating, so "Points"/"Premium Points"
appear as literal text in a handful of files. If you want the on-screen
labels to match too, find-and-replace in:

- **Live Auction** (`Points` -> your name): `live-auction/control.html`,
  `live-auction/js/control.js`, `live-auction/js/overlay.js`
- **Exclusive Auction** (`Premium Points` -> your name):
  `exclusive-auction/control.html`, `exclusive-auction/winner.html`,
  `exclusive-auction/test-panel.html`, `exclusive-auction/js/control.js`,
  `exclusive-auction/js/overlay.js`, `exclusive-auction/js/test-panel.js`

Point Spinner never mentions `CURRENCY_NAME` on-screen (its control panel
just says "poin"/"points" generically), so there's nothing to rename
there.

## OBS Browser Sources

All overlay pages use `location.host`-relative WebSocket URLs, so they
work from `http://localhost:<PORT>` exactly as-is -- no configuration
needed beyond adding them as Browser Sources. Each overlay's stage scales
with the Browser Source's width/height (CSS `vw`/`vh` units), so an exact
pixel size isn't critical -- matching your OBS canvas resolution (commonly
**1920x1080**) is a safe default. Leave "Shutdown source when not visible"
UNCHECKED so each overlay stays connected (and doesn't miss a spin/bid)
even while its scene isn't the one on screen.

| Page | URL | Where |
|---|---|---|
| Point Spinner control panel | `http://localhost:3000/point-spinner/control` | a normal browser tab, not OBS |
| Point Spinner overlay | `http://localhost:3000/point-spinner/overlay` | OBS Browser Source |
| Point Spinner winner | `http://localhost:3000/point-spinner/winner` | OBS Browser Source (separate scene, ~3 min win announcement) |
| Live Auction control panel | `http://localhost:3000/live-auction/control` | a normal browser tab |
| Live Auction overlay | `http://localhost:3000/live-auction/overlay` | OBS Browser Source |
| Exclusive Auction control panel | `http://localhost:3000/exclusive-auction/control` | a normal browser tab |
| Exclusive Auction overlay | `http://localhost:3000/exclusive-auction/overlay` | OBS Browser Source |
| Exclusive Auction winner | `http://localhost:3000/exclusive-auction/winner` | OBS Browser Source (separate scene) |
| Exclusive Auction test panel | `http://localhost:3000/exclusive-auction/test-panel` | a normal browser tab (rehearse an auction with dummy bidders, no live stream needed) |

(Replace `3000` with your own `PORT` if you changed it.)

Optional: Exclusive Auction's overlay plays a sound on each new bid if a
file exists at `exclusive-auction/assets/sfx/bid.mp3` -- that folder isn't
included (bring your own short sound effect, or leave it out entirely; a
missing file just means no sound plays, nothing breaks).

## Adding/editing prizes and auction items

The control panel UI for each model is meant to be self-explanatory --
open it and the forms/buttons are labeled. A couple of things that aren't
obvious from the UI alone:

- **Images** are automatically cropped to a square (540x540px) on upload,
  regardless of the source image's shape/size -- pick an image where the
  subject is centered, since the crop keeps the middle and cuts the
  longer dimension's edges.
- **Weight** (Point Spinner's item form) controls relative odds, not a
  percentage -- an item with weight `2` is twice as likely to be picked as
  one with weight `1`, regardless of how many other items exist.
- **"Remove after win"** (Point Spinner) takes an item out of the pool
  once it's won, so it can't be won again until you re-add it or import it
  again -- leave it off for prizes you want to stay available indefinitely.
- Live Auction / Exclusive Auction only ever run **one auction at a
  time** -- starting a new one while another is active is rejected by the
  server; close or wait out the current one first.
