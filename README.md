# Nekto audio → Discord

An owner-controlled Discord bot that joins your voice channel, opens https://nekto-me.kz/audiochat#/ in an isolated browser context, sets `storage_audio_v2.user.authToken` before the website initializes Vuex, starts a native search, and plays incoming WebRTC audio through Discord.

On a Windows or macOS desktop it uses installed Google Chrome with a visible window. Railway and Linux without a display use bundled headless Chromium. If installed Chrome is missing, the desktop launch falls back to bundled Chromium. `NEKTO_BROWSER_CHANNEL` and `NEKTO_HEADLESS=0|1` can override these defaults. Each new session uses a fresh non-persistent context; `/next` preserves the current session.

If clicking Search yourself works in the bot's window while the automatic click gets verification, set `NEKTO_MANUAL_SEARCH=1` in your local `.env` and restart. `/join` opens and authorizes the page, then asks you to click Search. The bot observes your native search/call and relays its incoming audio automatically. `/next` still ends the current call and confirms its ordinary End prompt, then waits for your Search click. After a partner leaves it also waits for you. In this mode verification stays in place for you to handle, without automatic entry-page reloads. Use a visible desktop browser (`NEKTO_HEADLESS=0`); manual Search cannot be operated on a headless Railway instance. Set `NEKTO_MANUAL_SEARCH=0` or remove it to restore automatic Search. This provides a working manual path; it does not establish why Nekto treats an automatic click differently.

The token script is restricted to the exact `https://nekto-me.kz` origin, including matching frames. Google, CAPTCHA frames, unrelated pages and other origins receive no token or audio setup. It preserves saved settings and changes only `storage_audio_v2.user.authToken`. The browser's native User-Agent, Client Hints, plugins, canvas, GPU, offline audio and screen remain intact. The previous `NEKTO_SPOOF_FP` option and encrypted `fpt` rewriting have been removed. No global Origin or Referer header is forced: the real `.kz` page supplies its normal browser headers, including its connection to `audio.nekto-me.kz`.

The legacy `--disable-blink-features=AutomationControlled` launch flag is removed, restoring the browser's native automation indicator. JavaScript uses the browser's enabled default. Browser fixtures verify scripts in a new Google-origin tab, native browser properties, and cross-origin CAPTCHA documents/images without token leakage. These checks establish browser compatibility with those fixture resources; they do not establish that Google will clear an unusual-traffic warning. The bot uses an isolated session, separate from your ordinary Chrome cookies and storage.

Once the audio client loads, the bot finds its Vuex store through `el.__vue__` and observes native audio registration. Search starts only when `system.isAuth`, `system.socketConnected`, `user.tokenId`, and the supplied token in both Vuex and `storage_audio_v2` agree. It does not expect the text client's `tokenModel` or `user/socket_auth.successToken` event, and it does not redundantly reauthorize an audio session. Verification, native restrictions, registration errors, token replacement, or a timeout stop the search. `/status` preserves boolean registration diagnostics after closing a failed browser. The text client's `storage_v2` key is not used.

This is an **incoming-only** relay. Nekto receives a silent microphone; your Discord microphone is not forwarded. Audio is processed in memory, with no recordings. People in your Discord voice channel can hear the Nekto participant.

## Commands

| Command | Action |
| --- | --- |
| `/token token:<value>` | Save or replace your Nekto auth token; restart search if you are in the bot's voice channel. |
| `/join` | Join your current regular voice channel and search on Nekto. Repeating it keeps an active partner or search. |
| `/next` | Confirm the ordinary End prompt, acknowledge a partner-left notice, and search again in the same session. An active search is left running. |
| `/stop` | Close Nekto while remaining in Discord voice. |
| `/leave` | Close Nekto and leave Discord voice. |
| `/status` | Show your full saved Nekto token, partner/search state, WebRTC diagnostics, and the last failure privately. |

Use `/token`, join a voice channel yourself, then use `/join`. Changing the token restarts search when you are in the bot's voice channel. Replies are ephemeral. `/status` shows the complete saved Nekto token only to the authorized requester; long tokens are attached in `nekto-token.txt` to fit Discord message limits. The bot never logs token values. Only the Discord application owner can control it unless `BOT_OWNER_IDS` is configured. The bot disconnects when the controlling user leaves or moves out of its voice channel.

Token acceptance is preserved in status even after a failed browser closes. Native CAPTCHA and hCaptcha flags are refreshed at the failure boundary and whenever live status is requested. `before-start` means the check appeared before clicking Start; `after-start` means it was observed after that click. Runtime logs record these stages and boolean flags without tokens. This locates the failure; it does not establish why the website requested verification.

Start lookup ignores hidden copies of controls and requires a single visible, enabled match. It supports native buttons, links and `.btn` controls with explicit call/search labels in Kazakh, Russian and English. The bot leaves cookie-consent controls alone and proceeds directly to Start. Unavailable or ambiguous Start controls and failed clicks have separate codes. Failed Start attempts and website challenges keep the current page, so `/join` can resume without creating another registration. Failure logs include visible control labels with token values redacted; `/status` logs packet, track, browser-frame and Discord-frame counts without the token. These distinguish a missing control from absent WebRTC audio or a relay delivery problem.

The relay observes native session state every 500 ms. Each automatic search attempt presses the visible, enabled Start control once using Playwright's standard button click. Verification or a failed attempt stays on the current page: the bot does not return to the entry page, reload, or automatically press Start again. CAPTCHA controls are left for you to handle. If verification clears while the existing native search/call continues, forwarding resumes after token checks pass. A new explicit `/next` or `/join` can start another attempt once the page is ready. Restrictions, disconnection, token mismatch, or capture errors pause forwarding. Manual Stop is respected.

`/next` handles the native `closeDialogPopup` ("У вас есть активный разговор. Завершить?"), ordinary End confirmations already open when the command arrives, their closing animation, and a notice that the other participant ended the call. The monitor also confirms ordinary call prompts and resumes searching when a partner leaves, using the native "Начать поиск собеседника" button on the finished-call screen. This keeps the existing browser context and registration. Unknown prompts, reports, forms, restrictions and verification controls are not answered automatically.

Nekto can retain `user.isSearching=true` throughout a call and after it ends. Status and `/next` give the native `/peer` route, active connection and visible finished-call screen priority over that stale flag. Ending a call waits for its Start control, and a new search is confirmed only once the old call screen has gone away. The bot observes this state without changing Nekto's store.

Incoming audio crosses the browser bridge in 40 ms batches, then an 80 ms jitter buffer absorbs uneven delivery. Excess backlog trims only the oldest frames instead of emptying the queue. Discord's playback reads pace complete 20 ms Opus packets, eliminating the separate PCM timer and transform backlog. The encoder uses the voice channel bitrate up to 96 kbps and enables Opus packet-loss protection. The relay's native playout sink is inaudible on the bot PC, avoiding an extra local copy. `/status` reports buffer underruns, trims and browser transport drops for diagnosing remaining glitches.

## Discord setup

Invite the bot with `bot` and `applications.commands` scopes. Give it View Channel, Connect and Speak permissions. No privileged intents or message-content access are required. Global commands may take time to appear; set `DISCORD_GUILD_ID` to register guild commands immediately. The bot supports the DAVE encryption dependency included by `@discordjs/voice`.

Never commit credentials. If a Discord bot token has been posted in chat, reset it in the Discord Developer Portal and replace the Railway `DISCORD_TOKEN` variable.

## Railway

Deploy this repository using its Dockerfile. Run one replica with app sleeping disabled and attach a volume at `/data` so `/token` survives redeploys.

Required environment variable: `DISCORD_TOKEN`. Optional variables: `BOT_OWNER_IDS` (comma-separated Discord user IDs), `DISCORD_GUILD_ID`, `NEKTO_AUTH_TOKEN` (initial fallback token), `DATA_DIR` (default `/data` in Docker), `PORT` (default 3000). The health endpoint `/health` becomes ready only after Discord login, slash-command registration and browser startup succeed. No public domain is needed for this worker.

Chromium exposes a synthetic microphone device and receives an explicit microphone permission grant for `https://nekto-me.kz` before page creation. Chromium reads a looping silent WAV as its native microphone input. The relay leaves modern `mediaDevices.getUserMedia` and legacy callback capture APIs unchanged, so permissions and constraints use browser behavior. Native permission and device checks appear in `/status`. Nekto uses its native `#searchCompanyBtn` control or an unambiguous labelled call action, and confirms search from `user.isSearching` or native partner state. Status distinguishes waiting for a partner, an established partner, and WebRTC/audio capture problems. `/next` keeps the browser, cookies, Vuex identity, and registration intact. It uses an unambiguous visible End action, handles only the ordinary end-call confirmation caused by that click, waits for its closing animation and the call to end, and starts the next search. Unknown controls or native restrictions fail in place without reconnecting or re-registering. An already active search is left running. Repeating `/join` in the same ready Discord voice connection leaves an established partner connected. `/stop`, `/leave`, or a token change closes the session. Relay success depends on the site accepting the token, finding a participant and Railway reaching the WebRTC/Discord voice endpoints.

## Local development

Requires Node 24.17+. Set environment variables in your shell, or run with Node's `--env-file=.env` option after copying `.env.example`. Install with `npm ci`, then `npx playwright install --with-deps chromium`. Run `npm start`.

`npm test` checks token persistence, private extension file permissions, extension storage behavior and bounded PCM buffering. `npm run test:browser` loads the real extension against local fixtures, checks that its token is present before the first page script and in matching frames, checks that unrelated origins receive no token, and verifies token replacement with preserved profile settings. It exercises repeated join, two successive native Next actions with Kazakh links and Russian styled controls, closing confirmation animations, untouched cookie controls and redacted diagnostics. It also runs a Chromium WebRTC loopback test to verify incoming audio reaches Node as 20 ms, 48 kHz stereo signed 16-bit little-endian PCM and checks peer cleanup. The browser checks also exercise the production session against local fixtures, preserving native fingerprint and encrypted payload bytes, leaving Google document headers and CAPTCHA storage untouched, and respecting a manual Stop. All tests run in the Docker build. A live Nekto-to-Discord call requires the owner to set a valid Nekto token and invoke `/join` from Discord.


## Verification diagnostics

Railway logs now record whether the configured token appears in parsed native socket messages, with fixed event categories and equality booleans. A read-only Vuex subscriber records changes to native CAPTCHA flags, including their primitive type so a string such as `"false"` can be distinguished from a boolean. Failed requests and HTTP errors are classified as site, audio or CAPTCHA resources. URLs, query strings, cookies, headers, raw socket payloads and credential values are excluded. These observations do not commit Vuex state or change verification decisions.

After an update, use `/join` then `/status` once to produce a fresh trace. A matching storage/live token alone does not establish that the same credential was transmitted, or that the server waived verification. The local Chromium fixture tests these diagnostics against simulated resource failures and native store mutations; it does not establish that a live Nekto call succeeds.

Browser sessions no longer use a persistent profile, so profile-lock recovery is not part of startup. The older recovery helper is retained only for extension fixture coverage. Startup logs identify the failing stage with fixed categories rather than dumping exception messages.

The browser integration check verifies that relay installation preserves microphone API identities, that native microphone capture remains live and silent over multiple WAV loops, and that modern and legacy capture paths work. This removes unnecessary API replacements; it does not establish the cause of a live CAPTCHA or token restriction.

Set `NEKTO_PROTOCOL_DIAGNOSTICS=1` and restart to enable optional encrypted protocol diagnostics. By default WebCrypto methods remain native, so missing protocol observations in `/status` are expected. When enabled, diagnostics temporarily observe WebCrypto input/output during the first registration and search. They record only fixed message types, whether `register.authToken` matches the configured token, the native `registered` reply, and whether `scan-for-peer.token` is missing, null, empty or present. They pass algorithms, keys, IVs, plaintext and the exact native promises unchanged. They never extract a CAPTCHA response for reuse, change search credentials or manufacture authorization. The observer restores the original method descriptors after the first native CAPTCHA request or peer connection, or after 90 seconds. These checks now appear in the owner's private `/status`; missing observations remain distinct from mismatches. A null search token means no CAPTCHA response was supplied; acceptance still depends on the native server response.

## Updating a local Windows checkout

Stop the running bot with Ctrl+C, then run these commands in its repository folder:

```cmd
git pull --ff-only
npm ci
node --env-file=.env src/index.js
```

If the folder was downloaded as a ZIP, download the updated repository instead and copy your existing `.env` and `data` folder into it. Restarting the bot replaces the old browser process. Use `/join` and then `/status` to check native registration and search. Local tests do not establish that the live matchmaking server will connect a partner or that Google will stop requesting verification.
