## Support Streamer Kecil ini | Support this little streamer :D [Donate here](https://sociabuzz.com/aftermathaoe/tribe)

### Interactive Point Spinner
<img width="1335" height="740" alt="image" src="https://github.com/user-attachments/assets/fef49ddf-c021-4e4f-94ea-7462e73ef60f" />

### Live Auction
<img width="1333" height="737" alt="image" src="https://github.com/user-attachments/assets/afce8e59-f353-4719-92f3-5d1e611f7b1e" />
SC : [Youtube [CC]AfterMath](https://youtube.com/@aftermathaoe)

# INSTRUKSI BERBAHASA INDONESIA

# Stream Toolkit

Kumpulan overlay OBS yang bisa kamu jalankan sendiri buat live stream YouTube: spinner hadiah yang dipicu penonton, plus dua auction pakai currency dari live chat. Semuanya tetap sinkron real-time antara tab Control Panel kamu dan Browser Source OBS lewat WebSocket. Tanpa layanan eksternal, tanpa database, tanpa build step — cuma Node.js polos + file JSON lokal, jalan sepenuhnya di PC kamu sendiri bareng OBS.

## Apa aja yang ada di dalamnya

1. **Point Spinner** — penonton dapat currency (default-nya `Points`, bisa kamu ganti namanya — lihat [docs/CONFIGURATION.md](docs/CONFIGURATION.md)) cuma dengan chatting, terus mereka pakai buat `!spin` buat menangin hadiah random dari daftar yang kamu atur. Putarannya tampil live di overlay OBS.
2. **Live Auction** — auction yang jalan sepenuhnya lewat live chat YouTube (`!joinbid`, `!bid`), harganya pakai currency yang sama dengan Point Spinner. Cuma satu auction aktif dalam satu waktu; kalau ke-outbid, uangnya langsung dikembalikan penuh.
3. **Exclusive Auction** — auction kedua yang independen, pakai currency *kedua* (default-nya `Premium Points`) yang nggak pernah didapat otomatis — moderator harus kasih manual lewat `!give`. Currency ini juga susut sekian persen tiap bulan (bisa kamu atur persennya). Ada juga test panel buat latihan jalanin auction pakai bidder dummy, tanpa perlu live stream beneran.

Tiap fitur itu folder yang berdiri sendiri: `control.html` (panel admin yang kamu buka di tab browser biasa), `overlay.html` (yang kamu tambahkan ke OBS sebagai Browser Source), dan kadang `winner.html` (Browser Source terpisah buat pengumuman pemenang, durasinya ~3 menit).

## Semuanya jalan lokal

Toolkit ini bukan layanan yang perlu di-hosting — nggak ada server yang perlu di-deploy, nggak perlu domain, nggak perlu setup HTTPS. Kamu jalanin persis seperti kamu jalanin OBS sendiri:

- `server.js` jalan di PC kamu sendiri (default-nya `http://localhost:3000`).
- Browser Source di OBS cukup diarahkan ke URL `http://localhost:3000/...` biasa — OBS bisa load HTTP lokal tanpa masalah, nggak butuh sertifikat apa pun.
- `bot/bot.js` (bot chat YouTube-nya) juga jalan di PC yang sama dan ngobrol sama `server.js` lewat `ws://localhost:3000/...` — nggak ada yang perlu dibuka ke internet.
- Cukup jalan pas kamu lagi streaming aja, siklus hidupnya sama kayak OBS. Tutup aja jendela terminal-nya kalau sudah selesai; nggak ada yang perlu "tetap nyala" di background.

## Arsitektur

```
                 ┌─────────────────────────────────────────┐
  Live chat      │               server.js                  │
  YouTube        │  (HTTP polos + 4 namespace WebSocket)    │
     │           │                                           │
     │  polling  │   /point-spinner/ws  ──┐                  │
     ▼           │   /economy/ws         │  baca/tulis       │       Control Panel
 bot/bot.js ─────┼──►/live-auction/ws    ├─ file JSON ────┐  │        (tab browser)
 (1 proses       │   /exclusive-         │  lokal di      │  │             │
  Node)          │    auction/ws       ──┘  data/         │  │   namespace │
                 │                                        │  │   WS sama   │
                 └────────────────────────────────────────┼──┘             │
                                                            │               ▼
                                               Browser Source OBS
                                              (overlay.html / winner.html)
```

`server.js` itu satu-satunya proses yang nyimpen state. `bot/bot.js` cuma client tipis yang nge-polling API live chat YouTube dan nerusin command-nya ke `server.js` lewat WebSocket — jadi kalau kamu restart bot-nya, saldo atau daftar item nggak akan hilang, karena semua itu disimpan di `data/*.json`, bukan di proses bot-nya.

## Mulai cepat

1. `npm install`
2. `cp .env.example .env` terus isi nilai-nilainya (nama currency, channel ID YouTube kamu, dll) — lihat [docs/CONFIGURATION.md](docs/CONFIGURATION.md) buat tahu fungsi masing-masing.
3. Bikin project Google Cloud + kredensial OAuth buat bot YouTube-nya — lihat [docs/SETUP.md](docs/SETUP.md) buat panduan lengkapnya (cuma perlu sekali). Terus otorisasi dua akun yang dibutuhin bot:
   ```
   node bot/authorize.js main
   node bot/authorize.js bot
   ```
4. Jalanin server-nya: `npm start` (atau `node server.js`)
5. Di terminal terpisah, jalanin bot-nya: `node bot/bot.js`
6. Buka control panel-nya di browser buat nambahin hadiah/mulai auction, contohnya `http://localhost:3000/point-spinner/control`
7. Tambahin URL overlay yang sesuai sebagai Browser Source di OBS, contohnya `http://localhost:3000/point-spinner/overlay` — lihat [docs/CONFIGURATION.md](docs/CONFIGURATION.md) buat daftar URL lengkap dan ukuran yang disarankan.

## Struktur project

```
server.js                 server utama (file statis, upload, WebSocket)
bot/
  bot.js                  bot live chat YouTube
  authorize.js             helper login OAuth (sekali pakai)
  economy.js               fungsi bantu currency yang dipakai bot.js
  wsClients.js              client WebSocket yang dipakai bot.js buat ngobrol ke server.js
point-spinner/             control panel + overlay + winner Point Spinner
live-auction/               control panel + overlay Live Auction
exclusive-auction/          control panel + overlay + winner Exclusive
                            Auction + test panel yang berdiri sendiri
data/                       dibuat otomatis saat jalan: saldo, daftar item,
                            state auction (di-gitignore)
uploads/                    dibuat otomatis saat jalan: gambar hadiah yang
                            diupload (di-gitignore)
docs/
  SETUP.md                 panduan Google Cloud / YouTube API / OAuth
  CONFIGURATION.md          referensi .env lengkap, setup OBS, cara ganti
                            nama currency
```

## Nggak ada test suite

Nggak ada test suite otomatis atau build step. Kalau mau verifikasi perubahan, jalanin aja server dan bot-nya terus coba langsung (tab browser buat control panel-nya, OBS atau tab browser biasa buat overlay-nya).

# ENGLISH INSTRUCTION

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


