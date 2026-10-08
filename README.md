# Nekto audio → Discord

An owner-controlled Discord bot that joins your voice channel, opens https://nekto-me.kz/audiochat#/ in headless Chromium, sets `storage_audio_v2.user.authToken` before the app loads, starts a search, and plays incoming WebRTC audio through Discord.

This is an **incoming-only** relay. Nekto receives a silent microphone; your Discord microphone is not forwarded. Audio is processed in memory, with no recordings. People in your Discord voice channel can hear the Nekto participant.

## Commands

| Command | Action |
| --- | --- |
| `/token token:<value>` | Save or replace your Nekto auth token; restart search if you are in the bot's voice channel. |
| `/join` | Join your current regular voice channel and search on Nekto. |
| `/next` | End the Nekto call and start a fresh search. |
| `/stop` | Close Nekto while remaining in Discord voice. |
| `/leave` | Close Nekto and leave Discord voice. |
| `/status` | Show connection state, sound counters, and the last search failure privately. |

Use `/token`, join a voice channel yourself, then use `/join`. Changing the token restarts search when you are in the bot's voice channel. Replies are ephemeral. The bot never logs token values. Only the Discord application owner can control it unless `BOT_OWNER_IDS` is configured. The bot disconnects when the controlling user leaves or moves out of its voice channel.

## Discord setup

Invite the bot with `bot` and `applications.commands` scopes. Give it View Channel, Connect and Speak permissions. No privileged intents or message-content access are required. Global commands may take time to appear; set `DISCORD_GUILD_ID` to register guild commands immediately. The bot supports the DAVE encryption dependency included by `@discordjs/voice`.

Never commit credentials. If a Discord bot token has been posted in chat, reset it in the Discord Developer Portal and replace the Railway `DISCORD_TOKEN` variable.

## Railway

Deploy this repository using its Dockerfile. Run one replica with app sleeping disabled and attach a volume at `/data` so `/token` survives redeploys.

Required environment variable: `DISCORD_TOKEN`. Optional variables: `BOT_OWNER_IDS` (comma-separated Discord user IDs), `DISCORD_GUILD_ID`, `NEKTO_AUTH_TOKEN` (initial fallback token), `DATA_DIR` (default `/data` in Docker), `PORT` (default 3000). The health endpoint `/health` becomes ready only after Discord login, slash-command registration and browser startup succeed. No public domain is needed for this worker.

Nekto uses its normal website controls. If the site requests verification, rejects the token or changes its interface, the command reports failure; it does not bypass safeguards. `/next` opens a new browser context to end the previous peer connection cleanly. Relay success depends on the site accepting the token, finding a participant and Railway reaching the WebRTC/Discord voice endpoints.

## Local development

Requires Node 24.17+. Set environment variables in your shell, or run with Node's `--env-file=.env` option after copying `.env.example`. Install with `npm ci`, then `npx playwright install --with-deps chromium`. Run `npm start`.

`npm test` checks token persistence, private file permissions, safe storage injection and bounded PCM buffering. `npm run test:browser` runs a local Chromium WebRTC loopback test to verify that real incoming audio reaches Node as 20 ms, 48 kHz stereo signed 16-bit little-endian PCM, and checks peer cleanup. Both tests run in the Docker build. A live Nekto-to-Discord call requires the owner to set a valid Nekto token and invoke `/join` from Discord.
