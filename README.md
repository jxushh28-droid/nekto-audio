# Nekto audio → Discord

An owner-controlled Discord bot that joins your voice channel, opens https://nekto-me.kz/audiochat#/ in Chromium with the real `nekto prime` Manifest V3 extension, sets `storage_audio_v2.user.authToken` at `document_start`, confirms native audio registration through Vuex, starts a search, and plays incoming WebRTC audio through Discord.

The extension uses the uploaded `prime.js` logic and manifest settings: `https://nekto-me.kz/*`, `document_start`, and `all_frames: true`. Only its hardcoded token is replaced by the saved `/token` value. Runtime extension files are generated privately under `/data/nekto-prime`; credentials are never bundled in the repository. The audio relay does not write token storage. Chromium uses the bundled full `chromium` channel and a persistent profile under `/data/nekto-browser`, so normal site settings and cookies survive restarts. A token change closes Chromium, regenerates `prime.js`, and reloads the extension. This setup does not guarantee the website will stop requesting verification.

Once the audio client loads, the bot finds its Vuex store through `el.__vue__` and observes native audio registration. Search starts only when `system.isAuth`, `system.socketConnected`, `user.tokenId`, and the supplied token in both Vuex and `storage_audio_v2` agree. It does not expect the text client's `tokenModel` or `user/socket_auth.successToken` event, and it does not redundantly reauthorize an audio session. Verification, native restrictions, registration errors, token replacement, or a timeout stop the search. `/status` preserves boolean registration diagnostics after closing a failed browser. The text client's `storage_v2` key is not used.

This is an **incoming-only** relay. Nekto receives a silent microphone; your Discord microphone is not forwarded. Audio is processed in memory, with no recordings. People in your Discord voice channel can hear the Nekto participant.

## Commands

| Command | Action |
| --- | --- |
| `/token token:<value>` | Save or replace your Nekto auth token; restart search if you are in the bot's voice channel. |
| `/join` | Join your current regular voice channel and search on Nekto. Repeating it keeps an active partner or search. |
| `/next` | End the Nekto call through its normal controls and search again in the same browser session. An active search is left running. |
| `/stop` | Close Nekto while remaining in Discord voice. |
| `/leave` | Close Nekto and leave Discord voice. |
| `/status` | Show your full saved Nekto token, partner/search state, WebRTC diagnostics, and the last failure privately. |

Use `/token`, join a voice channel yourself, then use `/join`. Changing the token restarts search when you are in the bot's voice channel. Replies are ephemeral. `/status` shows the complete saved Nekto token only to the authorized requester; long tokens are attached in `nekto-token.txt` to fit Discord message limits. The bot never logs token values. Only the Discord application owner can control it unless `BOT_OWNER_IDS` is configured. The bot disconnects when the controlling user leaves or moves out of its voice channel.

Token acceptance is preserved in status even after a failed browser closes. Native CAPTCHA and hCaptcha flags are refreshed at the failure boundary and whenever live status is requested. `before-start` means the check appeared before clicking Start; `after-start` means it was observed after that click. Runtime logs record these stages and boolean flags without tokens. This locates the failure; it does not establish why the website requested verification.

Start lookup ignores hidden copies of controls and requires a single visible, enabled match. It supports native buttons, links and `.btn` controls with explicit call/search labels in Kazakh, Russian and English. The bot leaves cookie-consent controls alone and proceeds directly to Start. Unavailable or ambiguous Start controls and failed clicks have separate codes. Failed Start attempts and website challenges keep the current page, so `/join` can resume without creating another registration. Failure logs include visible control labels with token values redacted; `/status` logs packet, track, browser-frame and Discord-frame counts without the token. These distinguish a missing control from absent WebRTC audio or a relay delivery problem.

The relay observes native session state every 500 ms. If verification clears while the existing search or call continues, audio forwarding resumes automatically after token and registration checks pass. New verification, restrictions, disconnection, token mismatch, or capture errors pause forwarding. `/stop`, `/leave`, and token replacement cancel monitoring of the old page. The monitor observes state only; it does not answer CAPTCHAs or restart blocked searches. Persistent verification still prevents a Railway-hosted call, and this bot does not currently offer remote browser access to complete it manually.

## Discord setup

Invite the bot with `bot` and `applications.commands` scopes. Give it View Channel, Connect and Speak permissions. No privileged intents or message-content access are required. Global commands may take time to appear; set `DISCORD_GUILD_ID` to register guild commands immediately. The bot supports the DAVE encryption dependency included by `@discordjs/voice`.

Never commit credentials. If a Discord bot token has been posted in chat, reset it in the Discord Developer Portal and replace the Railway `DISCORD_TOKEN` variable.

## Railway

Deploy this repository using its Dockerfile. Run one replica with app sleeping disabled and attach a volume at `/data` so `/token` survives redeploys.

Required environment variable: `DISCORD_TOKEN`. Optional variables: `BOT_OWNER_IDS` (comma-separated Discord user IDs), `DISCORD_GUILD_ID`, `NEKTO_AUTH_TOKEN` (initial fallback token), `DATA_DIR` (default `/data` in Docker), `PORT` (default 3000). The health endpoint `/health` becomes ready only after Discord login, slash-command registration and browser startup succeed. No public domain is needed for this worker.

Chromium exposes a synthetic microphone device and receives an explicit microphone permission grant for `https://nekto-me.kz` before page creation. Chromium reads a looping silent WAV as its native microphone input. The relay leaves modern `mediaDevices.getUserMedia` and legacy callback capture APIs unchanged, so permissions and constraints use browser behavior. Native permission and device checks appear in `/status`. Nekto uses its native `#searchCompanyBtn` control or an unambiguous labelled call action, and confirms search from `user.isSearching` or native partner state. Status distinguishes waiting for a partner, an established partner, and WebRTC/audio capture problems. `/next` keeps the browser, cookies, Vuex identity, and registration intact. It uses an unambiguous visible End action, handles only the ordinary end-call confirmation caused by that click, waits for its closing animation and the call to end, and starts the next search. Unknown controls or native restrictions fail in place without reconnecting or re-registering. An already active search is left running. Repeating `/join` in the same ready Discord voice connection leaves an established partner connected. `/stop`, `/leave`, or a token change closes the session. Relay success depends on the site accepting the token, finding a participant and Railway reaching the WebRTC/Discord voice endpoints.

## Local development

Requires Node 24.17+. Set environment variables in your shell, or run with Node's `--env-file=.env` option after copying `.env.example`. Install with `npm ci`, then `npx playwright install --with-deps chromium`. Run `npm start`.

`npm test` checks token persistence, private extension file permissions, extension storage behavior and bounded PCM buffering. `npm run test:browser` loads the real extension against local fixtures, checks that its token is present before the first page script and in matching frames, checks that unrelated origins receive no token, and verifies token replacement with preserved profile settings. It exercises repeated join, two successive native Next actions with Kazakh links and Russian styled controls, closing confirmation animations, untouched cookie controls and redacted diagnostics. It also runs a Chromium WebRTC loopback test to verify incoming audio reaches Node as 20 ms, 48 kHz stereo signed 16-bit little-endian PCM and checks peer cleanup. Both tests run in the Docker build. A live Nekto-to-Discord call requires the owner to set a valid Nekto token and invoke `/join` from Discord.


## Verification diagnostics

Railway logs now record whether the configured token appears in parsed native socket messages, with fixed event categories and equality booleans. A read-only Vuex subscriber records changes to native CAPTCHA flags, including their primitive type so a string such as `"false"` can be distinguished from a boolean. Failed requests and HTTP errors are classified as site, audio or CAPTCHA resources. URLs, query strings, cookies, headers, raw socket payloads and credential values are excluded. These observations do not commit Vuex state or change verification decisions.

After an update, use `/join` then `/status` once to produce a fresh trace. A matching storage/live token alone does not establish that the same credential was transmitted, or that the server waived verification. The local Chromium fixture tests these diagnostics against simulated resource failures and native store mutations; it does not establish that a live Nekto call succeeds.

On Railway, a failed Chromium launch caused by a stale persistent-profile lock can recover the three symlink lock artifacts and retry once. Recovery is limited to the expected profile directory on Railway and refuses a live local process, regular lock files, or a symlinked profile root. Profile contents, saved credentials and cookies remain intact. Startup logs identify the failing stage with fixed categories rather than dumping exception messages. Railway permits only one deployment to mount a service volume at a time: https://docs.railway.com/deployments/healthchecks#services-with-attached-volumes.

The browser integration check verifies that relay installation preserves microphone API identities, that native microphone capture remains live and silent over multiple WAV loops, and that modern and legacy capture paths work. This removes unnecessary API replacements; it does not establish the cause of a live CAPTCHA or token restriction.

Native encrypted protocol diagnostics temporarily observe WebCrypto input/output during the first registration and search. They record only fixed message types, whether `register.authToken` matches the configured token, the native `registered` reply, and whether `scan-for-peer.token` is missing, null, empty or present. They pass algorithms, keys, IVs, plaintext and the exact native promises unchanged. They never extract a CAPTCHA response for reuse, change search credentials or manufacture authorization. The observer restores the original method descriptors after the first native CAPTCHA request or peer connection, or after 90 seconds. These checks now appear in the owner's private `/status`; missing observations remain distinct from mismatches. A null search token means no CAPTCHA response was supplied; acceptance still depends on the native server response.
