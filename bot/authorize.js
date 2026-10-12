/* One-time OAuth authorization helper. Run this TWICE, once per account:
 *   node bot/authorize.js main   <-- log in as YOUR OWN channel
 *   node bot/authorize.js bot    <-- log in as the bot/reader account
 *
 * Each run opens a consent URL, starts a temporary local server to catch
 * Google's redirect, exchanges the code for tokens, and saves them to
 * YOUTUBE_TOKENS_DIR/<which>.json (see .env / docs/SETUP.md). Those token
 * files (and client_secret.json) are as sensitive as a password -- never
 * share or commit them.
 */

require('dotenv').config();

var fs = require('fs');
var path = require('path');
var http = require('http');
var google = require('googleapis').google;

var CLIENT_SECRET_PATH = path.resolve(__dirname, '..', process.env.YOUTUBE_CLIENT_SECRET_PATH || './bot/client_secret.json');
var TOKENS_DIR = path.resolve(__dirname, '..', process.env.YOUTUBE_TOKENS_DIR || './bot/tokens');

var SCOPES = {
  main: ['https://www.googleapis.com/auth/youtube.readonly'],
  bot: ['https://www.googleapis.com/auth/youtube.force-ssl'],
};

var LABELS = {
  main: 'YOUR OWN channel (used to detect when you go live)',
  bot: 'bot/reader account (used to read & reply in live chat)',
};

function loadClientSecret() {
  if (!fs.existsSync(CLIENT_SECRET_PATH)) {
    console.error('Could not find: ' + CLIENT_SECRET_PATH);
    console.error('Download the OAuth client JSON from Google Cloud Console (see docs/SETUP.md),');
    console.error('save it as client_secret.json in the bot/ folder (or point YOUTUBE_CLIENT_SECRET_PATH at it).');
    process.exit(1);
  }
  var raw = fs.readFileSync(CLIENT_SECRET_PATH, 'utf8');
  var data = JSON.parse(raw);
  var creds = data.installed || data.web;
  if (!creds) {
    console.error('Unrecognized client_secret.json format.');
    process.exit(1);
  }
  return { client_id: creds.client_id, client_secret: creds.client_secret };
}

function authorize(which) {
  var creds = loadClientSecret();
  var oAuth2Client;

  var server = http.createServer(function (req, res) {
    var reqUrl;
    try {
      reqUrl = new URL(req.url, 'http://127.0.0.1');
    } catch (err) {
      res.end('Invalid URL.');
      return;
    }
    var code = reqUrl.searchParams.get('code');
    var error = reqUrl.searchParams.get('error');

    if (error) {
      res.end('Authorization cancelled/failed: ' + error + '. You can close this tab and try again.');
      server.close();
      return;
    }
    if (!code) {
      res.end('No authorization code in this URL.');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>Success!</h2><p>You can close this tab and go back to the terminal.</p>');
    server.close();

    oAuth2Client.getToken(code, function (err, tokens) {
      if (err) {
        console.error('Failed to exchange code for a token:', err.message);
        process.exit(1);
      }
      if (!fs.existsSync(TOKENS_DIR)) fs.mkdirSync(TOKENS_DIR, { recursive: true });
      var outPath = path.join(TOKENS_DIR, which + '.json');
      fs.writeFileSync(outPath, JSON.stringify(tokens, null, 2));
      console.log('\nToken for "' + which + '" saved to: ' + outPath);
      if (!tokens.refresh_token) {
        console.log('\nWARNING: no refresh_token in this response.');
        console.log('This usually means this account already authorized this app before.');
        console.log('Revoke its access at https://myaccount.google.com/permissions and run this again.');
      }
      process.exit(0);
    });
  });

  server.listen(0, '127.0.0.1', function () {
    var port = server.address().port;
    var redirectUri = 'http://127.0.0.1:' + port;

    oAuth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret, redirectUri);

    var authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES[which],
    });

    console.log('\n=== Logging in as: ' + LABELS[which] + ' ===\n');
    console.log('Open this link in a browser, log in with the right account, and click Allow:\n');
    console.log(authUrl);
    console.log('\n(waiting for you to finish logging in...)');
  });
}

var which = process.argv[2];
if (which !== 'main' && which !== 'bot') {
  console.log('Usage:');
  console.log('  node bot/authorize.js main   -> log in as your own channel');
  console.log('  node bot/authorize.js bot    -> log in as the bot/reader account');
  process.exit(1);
}

authorize(which);
