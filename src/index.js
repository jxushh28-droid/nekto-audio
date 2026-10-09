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

const server = http.createServer((request, response) => {
  if (request.url !== '/health') { response.writeHead(404); response.end(); return; }
  response.writeHead(ready && client.isReady() ? 200 : 503, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ ready: ready && client.isReady() }));
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

try {
  if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is required.');
  await store.load();
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
  await client.login(process.env.DISCORD_TOKEN);
} catch (error) {
  console.error(`Bot startup failed (${safeError(error)}). Check DISCORD_TOKEN and the browser installation.`);
  await shutdown(); process.exitCode = 1;
}

