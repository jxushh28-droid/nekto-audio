import http from 'node:http';
import {
  ChannelType, Client, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
} from 'discord.js';
import {
  AudioPlayerStatus, createAudioPlayer, createAudioResource, entersState, joinVoiceChannel,
  NoSubscriberBehavior, StreamType, VoiceConnectionStatus,
} from '@discordjs/voice';
import { NektoBrowser } from './nekto.js';
import { PcmQueue, PcmStream } from './pcm.js';
import { TokenStore } from './token-store.js';
import { statusReply } from './status-reply.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const store = new TokenStore(process.env.DATA_DIR || './data', process.env.NEKTO_AUTH_TOKEN || '');
let ready = false;
let busy = false;
let closing = false;
let session = null;
let ownerIds = new Set();
const queue = new PcmQueue();
const browser = new NektoBrowser(base64 => { if (session) queue.accept(base64); });
const startupCategory = error => {
  const message = String(error?.message || '');
  if (/ProcessSingleton|SingletonLock|profile appears to be in use|profile.*locked/i.test(message)) return 'browser-profile-locked';
  if (/Executable doesn.t exist|browser.*executable.*not.*found/i.test(message)) return 'browser-executable-missing';
  if (/EACCES|permission denied/i.test(message)) return 'filesystem-permission';
  return 'unclassified';
};
const safeError = error => String(error?.code || error?.name || 'Error').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);

const commands = [
  new SlashCommandBuilder().setName('token').setDescription('Save your Nekto auth token privately')
    .addStringOption(option => option.setName('token').setDescription('Your Nekto auth token')
      .setRequired(true).setMinLength(1).setMaxLength(4000)),
  new SlashCommandBuilder().setName('join').setDescription('Join your voice channel and search on Nekto'),
  new SlashCommandBuilder().setName('next').setDescription('End this Nekto call and search for another person'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop Nekto while staying in Discord voice'),
  new SlashCommandBuilder().setName('leave').setDescription('Stop Nekto and leave Discord voice'),
  new SlashCommandBuilder().setName('status').setDescription('Show private relay connection status'),
].map(command => command.setDMPermission(false).toJSON());

async function leave() {
  const previous = session;
  session = null;
  queue.clear();
  if (previous) {
    previous.player.stop(true);
    previous.stream.destroy();
    if (previous.connection.state.status !== VoiceConnectionStatus.Destroyed) previous.connection.destroy();
  }
  await browser.stop();
}

async function join(interaction) {
  if (!store.value) throw new Error('Set your Nekto token with /token first.');
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const channel = member.voice.channel;
  if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error('Join a regular Discord voice channel first.');
  const permissions = channel.permissionsFor(interaction.guild.members.me);
  if (!permissions?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
    throw new Error('Give the bot Connect and Speak permissions in your voice channel.');
  }
  if (session?.guildId === interaction.guildId && session.channelId === channel.id &&
      session.userId === interaction.user.id && session.connection.state.status === VoiceConnectionStatus.Ready &&
      session.player.state.status === AudioPlayerStatus.Playing) {
    return browser.search(store.value);
  }
  await leave();
  const connection = joinVoiceChannel({
    channelId: channel.id, guildId: interaction.guild.id,
    adapterCreator: interaction.guild.voiceAdapterCreator, selfDeaf: true, selfMute: false,
  });
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  const stream = new PcmStream(queue);
  session = { guildId: interaction.guild.id, channelId: channel.id, userId: interaction.user.id, connection, player, stream };
  const current = session;
  connection.on('error', error => console.error(`Discord voice connection error (${safeError(error)}).`));
  player.on('error', () => { console.error('Audio playback error.'); void leave(); });
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch { if (session === current) await leave(); }
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30000);
    // The user may have left while the bot was connecting.
    await member.fetch();
    if (member.voice.channelId !== channel.id || session !== current) throw new Error('Join the voice channel again, then use /join.');
    connection.subscribe(player);
    player.play(createAudioResource(stream, { inputType: StreamType.Raw }));
    await entersState(player, AudioPlayerStatus.Playing, 5000);
  } catch (error) {
    await leave();
    if (/Set your|Join the|Nekto|capture/i.test(error.message)) throw error;
    throw new Error('Could not establish Discord voice. Check Connect/Speak permissions and try /join again.');
  }
  // Keep Discord voice connected if the website search fails.
  return browser.search(store.value);
}

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand() || !commands.some(c => c.name === interaction.commandName)) return;
  if (!ownerIds.has(interaction.user.id)) {
    await interaction.reply({ content: 'This bot is restricted to its owner.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Use this command in your Discord server.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (busy) {
    await interaction.reply({ content: 'Another relay command is still running. Try again in a moment.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  busy = true;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let message, privateStatus;
    switch (interaction.commandName) {
      case 'token': {
        await store.set(interaction.options.getString('token', true));
        await browser.stop(); queue.clear();
        message = 'Nekto token saved. Use /join to start, or /next if I am already in your voice channel.';
        if (session?.guildId === interaction.guildId) {
          const member = await interaction.guild.members.fetch(interaction.user.id);
          if (member.voice.channelId === session?.channelId) message = `Nekto token saved. ${await browser.search(store.value)}`;
        }
        break;
      }
      case 'join': message = await join(interaction); break;
      case 'next': {
        if (!session || session.guildId !== interaction.guildId) throw new Error('Use /join first.');
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (member.voice.channelId !== session.channelId) throw new Error('Join my voice channel first.');
        queue.clear(); message = await browser.next(store.value); break;
      }
      case 'stop': await browser.stop(); queue.clear(); message = 'Nekto stopped.'; break;
      case 'leave': await leave(); message = 'Stopped Nekto and left voice.'; break;
      case 'status': {
        const status = await browser.status(store.value);
        console.log(JSON.stringify({ event: 'discord_audio_status', voice: session?.connection.state.status || 'disconnected',
          framesReceived: queue.received, nonSilentFrames: queue.nonSilent }));
        privateStatus = statusReply({ status, voice: session?.connection.state.status || 'disconnected', token: store.value, queue });
        break;
      }
    }
    await interaction.editReply(privateStatus || { content: message, allowedMentions: { parse: [] } });
  } catch (error) {
    console.error(`Relay command /${interaction.commandName} failed (${safeError(error)}).`);
    const publicMessages = /^(Set your Nekto|Join a regular|Give the bot|Nekto |Remote audio|Audio capture|Could not establish|Could not read|Token must|Use \/join|Join my voice|Join the voice)/;
    const message = publicMessages.test(error.message) ? error.message : 'The relay operation failed. Check Railway runtime logs for the error category, then try again.';
    if (interaction.deferred) await interaction.editReply({ content: message }).catch(() => {});
    else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
  } finally { busy = false; }
});

client.on(Events.VoiceStateUpdate, (before, after) => {
  const current = session;
  if (!current || before.guild.id !== current.guildId) return;
  if ((after.id === current.userId || after.id === client.user?.id) && after.channelId !== current.channelId) {
    void leave();
  }
});
client.on(Events.Error, error => console.error(`Discord gateway error (${safeError(error)}).`));
client.on(Events.ShardDisconnect, () => { ready = false; void leave(); });
client.on(Events.ShardResume, () => { ready = true; });

const PANEL_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>nekto-audio panel</title><style>
*{box-sizing:border-box;margin:0;padding:0}body{background:#0d0d0f;color:#e0e0e0;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;padding:20px;min-height:100vh}
h1{font-size:18px;font-weight:600;color:#fff;margin-bottom:16px;letter-spacing:.5px}h1 span{font-size:11px;font-weight:400;color:#555;margin-left:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.card{background:#16161a;border:1px solid #222;border-radius:8px;padding:14px}
.card-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#555;margin-bottom:10px}
.row{display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #1c1c22}
.row:last-child{border-bottom:none}.label{color:#888;font-size:12px}.val{font-size:12px;font-weight:500;color:#ccc;max-width:180px;text-align:right;word-break:break-all}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px}
.ok{color:#4ade80}.ok .dot{background:#4ade80}.warn{color:#facc15}.warn .dot{background:#facc15}.bad{color:#f87171}.bad .dot{background:#f87171}.dim{color:#555}
.badge{display:inline-block;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:600}
.badge-ok{background:#052e16;color:#4ade80}.badge-warn{background:#2d2000;color:#facc15}.badge-bad{background:#2d0f0f;color:#f87171}.badge-dim{background:#1c1c22;color:#555}
#err{display:none;background:#2d0f0f;border:1px solid #f87171;border-radius:6px;padding:10px;margin-bottom:12px;color:#f87171;font-size:12px}
.ts{font-size:10px;color:#333;margin-top:14px;text-align:right}
</style></head><body>
<h1>nekto-audio <span id="ts">—</span></h1>
<div id="err"></div>
<div class="grid" id="grid"></div>
<script>
const dot=c=>'<span class="dot"></span>';
const badge=(v,cls)=>'<span class="badge badge-'+cls+'">'+v+'</span>';
const cls=(ok,warn)=>ok?'ok':warn?'warn':'bad';
function row(label,val,colorCls){return'<div class="row"><span class="label">'+label+'</span><span class="val '+(colorCls||'')+'">'+(colorCls?dot():'')+val+'</span></div>';}
function card(title,rows){return'<div class="card"><div class="card-title">'+title+'</div>'+rows+'</div>';}
async function poll(){
  try{
    const r=await fetch('/status');
    if(!r.ok)throw new Error('HTTP '+r.status);
    const d=await r.json();
    document.getElementById('err').style.display='none';
    render(d);
    document.getElementById('ts').textContent='updated '+new Date().toLocaleTimeString();
  }catch(e){
    const el=document.getElementById('err');
    el.style.display='block';el.textContent='⚠ Cannot reach bot: '+e.message;
  }
}
function render(d){
  const voice=d.voice||'disconnected';
  const nekto=d.nekto||'stopped';
  const auth=d.authorization||'unconfirmed';
  const captcha=d.captcha;
  const restricted=d.restricted;
  const failure=d.lastFailure;
  const frames=d.framesReceived||0;
  const sound=d.nonSilentFrames||0;
  const peers=d.peers||0;
  const packets=d.inboundPackets||0;
  const bytes=d.inboundBytes||0;
  const tracks=d.tracks||0;
  const p=d.protocol||{};
  const reg=d.registration||{};
  const obs=d.observed||{};
  const ctl=d.controls||{};
  const mic=d.microphone||{};

  const voiceCls=voice==='ready'?'ok':voice==='disconnected'?'bad':'warn';
  const nektoCls=nekto.includes('search')||nekto.includes('open')?'warn':nekto.includes('call')||nekto.includes('confirm')?'ok':nekto==='stopped'?'dim':'warn';
  const captchaCls=captcha?'bad':'ok';

  const cards=[
    card('Status',[
      row('Discord voice',voice,voiceCls),
      row('Nekto',nekto,nektoCls),
      row('Authorization',auth,auth.includes('confirm')?'ok':'warn'),
      row('Captcha',captcha?badge('REQUIRED','bad'):badge('clear','ok')),
      row('Restricted',restricted?badge('YES','bad'):badge('no','ok')),
      row('Last failure',failure?badge(failure,'bad'):badge('none','ok')),
    ].join('')),
    card('Audio',[
      row('Frames received',frames,frames>0?'ok':'dim'),
      row('Frames with sound',sound,sound>0?'ok':'dim'),
      row('WebRTC peers',peers,peers>0?'ok':'dim'),
      row('Remote tracks',tracks,tracks>0?'ok':'dim'),
      row('Packets in',packets,packets>0?'ok':'dim'),
      row('Bytes in',bytes>1024?(bytes/1024).toFixed(1)+'KB':bytes+'B',bytes>0?'ok':'dim'),
    ].join('')),
    card('Token / Protocol',[
      row('Storage token',reg.savedTokenMatches!=null?(reg.savedTokenMatches?badge('match','ok'):badge('MISMATCH','bad')):'—'),
      row('Live token',reg.liveTokenMatches!=null?(reg.liveTokenMatches?badge('match','ok'):badge('MISMATCH','bad')):'—'),
      row('Socket connected',reg.socketConnected!=null?(reg.socketConnected?badge('yes','ok'):badge('no','bad')):'—'),
      row('Authenticated',reg.authenticated!=null?(reg.authenticated?badge('yes','ok'):badge('no','bad')):'—'),
      row('captcha-request',p.captchaRequested?badge('received','bad'):badge('none','ok')),
      row('Reg reply',p.registrationReplyObserved!=null?(p.registrationSuccess?badge('ok','ok'):badge('fail','bad')):'—'),
    ].join('')),
    card('Browser / Controls',[
      row('Observed stage',obs.stage||'—'),
      row('Start button',ctl.startVisible!=null?(ctl.startEnabled?badge('enabled','ok'):(ctl.startVisible?badge('visible','warn'):badge('hidden','dim'))):'—'),
      row('Cookies btn',ctl.cookiesVisible?badge('visible','warn'):badge('gone','ok')),
      row('Mic permission',mic.permission||'—',mic.permission==='granted'?'ok':'bad'),
      row('Mic inputs',mic.inputs!=null?mic.inputs:'-'),
      row('Browser audio',d.audioState||'—',d.audioState==='running'?'ok':'warn'),
    ].join('')),
  ];
  document.getElementById('grid').innerHTML=cards.join('');
}
poll();setInterval(poll,1500);
</script></body></html>`;

const server = http.createServer(async (request, response) => {
  if (request.url === '/health') {
    response.writeHead(ready && client.isReady() ? 200 : 503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ready: ready && client.isReady() }));
    return;
  }
  if (request.url === '/status') {
    try {
      const status = await browser.status(store.value);
      const d = status.authorizationDiagnostics || {};
      const p = status.protocolDiagnostics || {};
      const c = status.controlDiagnostics || {};
      const obs = status.observedStage ? { stage: `${status.observedStage}; captcha=${!!d.captcha}; hcaptcha=${!!d.hcaptcha}` } : {};
      response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      response.end(JSON.stringify({
        voice: session?.connection.state.status || 'disconnected',
        nekto: status.active ? (status.callState?.phase || 'open') : 'stopped',
        authorization: status.authorization || 'unconfirmed',
        captcha: !!(d.captcha || d.hcaptcha),
        restricted: !!d.restricted,
        lastFailure: status.lastFailure ? `${status.lastFailure.code}: ${status.lastFailure.message}` : null,
        framesReceived: queue.received,
        nonSilentFrames: queue.nonSilent,
        peers: status.peers || 0,
        tracks: status.tracks || 0,
        inboundPackets: status.inboundPackets || 0,
        inboundBytes: status.inboundBytes || 0,
        audioState: status.audioState || null,
        registration: { authenticated: d.authenticated, socketConnected: d.socketConnected, savedTokenMatches: d.savedTokenMatches, liveTokenMatches: d.liveTokenMatches },
        protocol: { captchaRequested: !!p.captchaRequested, registrationReplyObserved: p.registrationReplyObserved, registrationSuccess: p.registrationSuccess },
        controls: c,
        observed: obs,
        microphone: status.microphone || null,
      }));
    } catch {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'status unavailable' }));
    }
    return;
  }
  if (request.url === '/' || request.url === '/panel') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(PANEL_HTML);
    return;
  }
  response.writeHead(404); response.end();
});
server.listen(Number(process.env.PORT || 3000), '0.0.0.0');

async function shutdown() {
  if (closing) return;
  closing = true; ready = false;
  const force = setTimeout(() => process.exit(1), 10000); force.unref();
  await leave(); await browser.close(); client.destroy(); server.close();
  clearTimeout(force);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

let startupStage = 'configuration';
try {
  if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is required.');
  startupStage = 'token-store';
  await store.load();
  startupStage = 'browser';
  await browser.launch(store.value); // Verify Chromium with the extension before reporting healthy.
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.fetch();
      const configured = (process.env.BOT_OWNER_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
      const owner = client.application.owner;
      ownerIds = new Set(configured.length ? configured : [owner?.ownerId || owner?.id].filter(Boolean));
      if (!ownerIds.size || [...ownerIds].some(id => !/^\d{17,20}$/.test(id))) throw new Error('Invalid bot owner configuration.');
      const manager = process.env.DISCORD_GUILD_ID
        ? (await client.guilds.fetch(process.env.DISCORD_GUILD_ID)).commands : client.application.commands;
      // Delete the retired popup commands without replacing unrelated commands.
      for (const existingManager of [client.application.commands, manager].filter((value, index, list) => list.indexOf(value) === index)) {
        const registered = await existingManager.fetch();
        for (const command of registered.values()) {
          if (['answer', 'prompt'].includes(command.name)) await existingManager.delete(command.id);
        }
      }
      for (const command of commands) await manager.create(command);
      ready = true;
      console.log('Discord bot online; slash commands registered; browser ready.');
    } catch (error) {
      console.error(`Bot setup failed (${safeError(error)}).`);
      await shutdown(); process.exitCode = 1;
    }
  });
  startupStage = 'discord-login';
  await client.login(process.env.DISCORD_TOKEN);
} catch (error) {
  console.error(JSON.stringify({ event: 'bot_startup_failed', stage: startupStage, category: startupCategory(error), errorType: safeError(error) }));
  await shutdown(); process.exitCode = 1;
}

