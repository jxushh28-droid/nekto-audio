import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('token').setDescription('Save your Nekto auth token privately')
    .addStringOption(option => option.setName('token').setDescription('Your Nekto auth token')
      .setRequired(true).setMinLength(1).setMaxLength(4000)),
  new SlashCommandBuilder().setName('join').setDescription('Join your voice channel and search on Nekto'),
  new SlashCommandBuilder().setName('next').setDescription('End this Nekto call and search for another person'),
  new SlashCommandBuilder().setName('autonext').setDescription('Toggle searching after a partner ends the call')
    .addBooleanOption(option => option.setName('enabled').setDescription('Enable or disable automatic next')),
  new SlashCommandBuilder().setName('stop').setDescription('Stop Nekto while staying in Discord voice'),
  new SlashCommandBuilder().setName('leave').setDescription('Stop Nekto and leave Discord voice'),
  new SlashCommandBuilder().setName('status').setDescription('Show private relay connection status'),
].map(command => command.setDMPermission(false).toJSON());
