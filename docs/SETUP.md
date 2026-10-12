# Setup: Google Cloud project + YouTube API + OAuth

This is a one-time setup to let `bot/bot.js` read and reply to your
YouTube live chat. Everything here runs on your own PC -- there's nothing
to deploy or host.

The bot needs **two** Google accounts authorized:

- **"main"** -- your own channel's account, used only to detect when
  *you* are live (read-only, never posts anything).
- **"bot"** -- the account that actually reads chat and posts replies.
  This can be your main account too, but a separate "bot" Google account
  (a second channel/profile) is recommended so replies don't come from
  your own name.

## A. Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and
   sign in (any Google account -- doesn't have to be either account above).
2. Create a new project (top bar -> project dropdown -> **New Project**).
   Any name is fine.

## B. Enable the YouTube Data API v3

1. In the project you just created, go to **APIs & Services -> Library**.
2. Search for **YouTube Data API v3** and click **Enable**.

## C. Configure the OAuth consent screen

1. Go to **APIs & Services -> OAuth consent screen**.
2. User type: **External**. Fill in an app name, your support email, and
   developer contact email (any values are fine -- this is only ever seen
   by you and your bot account during login).
3. **Testing** publishing status is enough for personal use -- you do NOT
   need to submit this for Google's verification review unless you plan
   to publish it publicly or expect more than 100 users logging in through
   it, neither of which applies here.
4. Under **Test users**, add the email addresses of BOTH Google accounts
   above (your main channel account and your bot account). Only accounts
   listed here can complete login while the app is in Testing mode.
5. You don't need to add scopes here manually -- `bot/authorize.js`
   requests the specific scopes it needs (`youtube.readonly` for "main",
   `youtube.force-ssl` for "bot") at login time.

## D. Create OAuth credentials

1. Go to **APIs & Services -> Credentials -> Create Credentials -> OAuth
   client ID**.
2. Application type: **Desktop app** (not "Web application" -- the login
   flow in `bot/authorize.js` opens a temporary local server on a random
   port to catch Google's redirect, which only "Desktop app" credentials
   allow without pre-registering an exact redirect URL).
3. Give it any name, click **Create**.
4. Click **Download JSON** on the credential you just created.
5. Save that file as `bot/client_secret.json` in this project (exact
   filename, or point `YOUTUBE_CLIENT_SECRET_PATH` in `.env` at wherever
   you saved it instead).

This file is as sensitive as a password -- it's already covered by
`.gitignore`, never commit it or share it.

## E. Run the authorization script

With `bot/client_secret.json` in place, run (from the project root):

```
node bot/authorize.js main
```

This prints a Google login URL. Open it, **log in with your own channel's
account**, and click **Allow**. The script catches the redirect
automatically and saves a token to `bot/tokens/main.json`.

Then repeat for the bot account:

```
node bot/authorize.js bot
```

Open the printed URL, **log in with the bot account this time**, click
**Allow**. Saves a token to `bot/tokens/bot.json`.

If a run prints a warning about a missing `refresh_token`, that account
already authorized this exact app before. Revoke its access at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions)
and run the command again.

## F. Fill in `.env`

Copy `.env.example` to `.env` if you haven't already, and set
`YOUTUBE_CHANNEL_ID` to **your own channel's** ID (the one you stream
on) -- find it under YouTube Studio -> Settings -> Channel -> Advanced
settings -> **Channel ID** (starts with `UC...`).

## G. Run it

```
npm start              # starts server.js
node bot/bot.js         # in a separate terminal
```

The bot checks whether your channel (`YOUTUBE_CHANNEL_ID`) currently has a
live broadcast, and starts watching its chat automatically once it finds
one. You can start the bot before you go live -- it just polls every few
minutes until it finds a stream.

See [CONFIGURATION.md](CONFIGURATION.md) for the full `.env` reference and
how to wire the overlay pages into OBS.
