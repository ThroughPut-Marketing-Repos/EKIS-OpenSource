import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import logger from '../utils/logger.js';
import configUpdateService from '../services/configUpdateService.js';
import { getConfig as loadRuntimeConfig } from '../config/configManager.js';
import { saveVerifiedUser, VerifiedUserConflictError } from '../services/verificationService.js';

const normaliseDepositReason = (reason) => {
  if (!reason) {
    return null;
  }
  const text = String(reason).replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export const formatVerificationMessage = (result) => {
  const status = result.passed ? '✅ Verification passed' : '❌ Verification failed';
  const exchangeLabel = result.exchangeName || result.exchangeId || 'n/a';
  const lines = [
    status,
    `UID: ${result.uid}`,
    `Exchange: ${exchangeLabel}`
  ];

  if (typeof result.volume === 'number' && !Number.isNaN(result.volume)) {
    lines.push(`Recorded Volume: ${result.volume}`);
    if (result.volumeMet === false) {
      lines.push(`Volume Target: ${result.minimumVolume} (not met, informational only)`);
    } else if (result.volumeMet === true) {
      lines.push(`Volume Target: ${result.minimumVolume} (met)`);
    } else if (result.skipped) {
      lines.push(`Volume Target: ${result.minimumVolume} (tracking disabled)`);
    }
  } else if (result.skipped) {
    lines.push('Trading volume tracking is currently disabled by configuration.');
  }

  const depositThreshold = result.deposit?.threshold;
  const depositMet = result.deposit?.met !== false;
  const amount = typeof result.deposit?.amount === 'number' ? result.deposit.amount : null;

  if (typeof depositThreshold !== 'undefined' && depositThreshold !== null) {
    const statusText = depositMet ? 'met' : 'not met';
    if (amount !== null) {
      lines.push(`Deposit: ${amount} / ${depositThreshold} (${statusText})`);
    } else {
      lines.push(`Deposit Threshold: ${depositThreshold} (${statusText})`);
    }
  } else if (amount !== null) {
    lines.push(`Deposit: ${amount}`);
  }

  if (!depositMet && result.deposit?.reason) {
    const reasonText = normaliseDepositReason(result.deposit.reason);
    if (reasonText) {
      lines.push(`Deposit Reason: ${reasonText}`);
    }
  }

  lines.push(`Checked At: ${result.timestamp}`);
  return lines.join('\n');
};

const VERIFICATION_BUTTON_PREFIX = 'discord-verify';
const VERIFICATION_MODAL_PREFIX = 'discord-verify-modal';
const SETUP_SELECT_GUILD = 'discord-setup-select-guild';
const SETUP_SELECT_CHANNEL = 'discord-setup-select-channel';
const SETUP_SELECT_ROLE = 'discord-setup-select-role';
const CREATE_CHANNEL_VALUE = 'create-channel';
const CREATE_ROLE_VALUE = 'create-role';
const MAX_BUTTONS_PER_ROW = 5;

const hasGuildSetupPermission = (member) => {
  if (!member?.permissions) {
    return false;
  }
  return member.permissions.has(PermissionFlagsBits.Administrator)
    || member.permissions.has(PermissionFlagsBits.ManageGuild);
};

export const buildVerificationEmbedPayload = ({ guildName, exchanges, guildId }) => {
  const embed = new EmbedBuilder()
    .setTitle('Verify your exchange account')
    .setDescription([
      'Welcome! Use the buttons below to verify your UID for the available exchanges.',
      'After submitting your UID you will receive a DM with the verification outcome and any follow-up actions.',
      'If you have not registered through the affiliate link yet, please complete that step before verifying.'
    ].join('\n'))
    .setColor(0x5865F2)
    .setFooter({ text: guildName ? `Requested by ${guildName}` : 'Exchange verification' })
    .setTimestamp();

  const affiliateLines = exchanges
    .filter((exchange) => exchange.affiliateLink)
    .map((exchange) => `• ${exchange.name || exchange.description || exchange.id}: ${exchange.affiliateLink}`);

  if (affiliateLines.length) {
    embed.addFields({
      name: 'Affiliate links',
      value: affiliateLines.join('\n')
    });
  }

  const rows = [];
  let currentRow = new ActionRowBuilder();

  if (exchanges.length === 0) {
    const button = new ButtonBuilder()
      .setCustomId(`${VERIFICATION_BUTTON_PREFIX}:disabled:${guildId || 'unknown'}`)
      .setLabel('No exchanges configured')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);
    currentRow.addComponents(button);
    rows.push(currentRow);
    return { embeds: [embed], components: rows };
  }

  for (const exchange of exchanges) {
    if (currentRow.components.length === MAX_BUTTONS_PER_ROW) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }

    const label = exchange.name || exchange.description || exchange.id;
    const button = new ButtonBuilder()
      .setCustomId(`${VERIFICATION_BUTTON_PREFIX}:${guildId}:${exchange.id}`)
      .setLabel(label.length > 80 ? `${label.slice(0, 77)}…` : label)
      .setStyle(ButtonStyle.Primary);

    currentRow.addComponents(button);
  }

  if (currentRow.components.length) {
    rows.push(currentRow);
  }

  return {
    embeds: [embed],
    components: rows
  };
};

export const publishVerificationEmbed = async ({ guild, channelId, volumeVerifier }) => {
  if (!guild || !channelId) {
    throw new Error('A guild and channel are required to publish the verification embed.');
  }

  const channel = await guild.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error('Verification channel must be a text channel.');
  }

  const exchanges = volumeVerifier.getExchanges ? volumeVerifier.getExchanges() : [];
  const payload = buildVerificationEmbedPayload({
    guildName: guild.name,
    guildId: guild.id,
    exchanges
  });

  await channel.send(payload);
  logger.info('Published verification embed to Discord channel.', {
    guildId: guild.id,
    channelId: channel.id,
    exchanges: exchanges.map((exchange) => exchange.id)
  });
};

export const createDiscordSetupWizard = ({ client, configUpdater, volumeVerifier, discordConfig, publishEmbed = publishVerificationEmbed }) => {
  const sessions = new Map();

  const findSession = (userId) => sessions.get(userId);

  const endSession = (userId) => {
    sessions.delete(userId);
  };

  const fetchEligibleGuilds = async (userId) => {
    const collection = await client.guilds.fetch();
    const eligible = [];

    for (const guild of collection.values()) {
      try {
        const resolvedGuild = guild.joinedTimestamp ? guild : await client.guilds.fetch(guild.id);
        const member = await resolvedGuild.members.fetch(userId);
        if (hasGuildSetupPermission(member)) {
          eligible.push(resolvedGuild);
        }
      } catch (error) {
        logger.debug('Skipping guild during setup wizard permission evaluation.', {
          guildId: guild.id,
          userId,
          error: error.message
        });
      }
    }

    return eligible;
  };

  const buildGuildMenu = (guilds) => {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(SETUP_SELECT_GUILD)
      .setPlaceholder('Select the server to configure')
      .addOptions(guilds.slice(0, 25).map((guild) => ({
        label: guild.name.length > 100 ? `${guild.name.slice(0, 97)}…` : guild.name,
        value: guild.id
      })));

    return new ActionRowBuilder().addComponents(menu);
  };

  const buildChannelMenu = (channels) => {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(SETUP_SELECT_CHANNEL)
      .setPlaceholder('Select or create the verification channel');

    for (const channel of channels.slice(0, 24)) {
      menu.addOptions({
        label: `#${channel.name}`,
        value: channel.id
      });
    }

    menu.addOptions({
      label: 'Create a new channel',
      value: CREATE_CHANNEL_VALUE
    });

    return new ActionRowBuilder().addComponents(menu);
  };

  const buildRoleMenu = (roles) => {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(SETUP_SELECT_ROLE)
      .setPlaceholder('Select or create the verification role');

    for (const role of roles.slice(0, 24)) {
      menu.addOptions({
        label: role.name,
        value: role.id
      });
    }

    menu.addOptions({
      label: 'Create a new role',
      value: CREATE_ROLE_VALUE
    });

    return new ActionRowBuilder().addComponents(menu);
  };

  const promptForChannel = async (session) => {
    const channels = [];
    const fetched = await session.guild.channels.fetch();
    for (const channel of fetched.values()) {
      if (channel.type === ChannelType.GuildText) {
        channels.push(channel);
      }
    }

    if (!channels.length) {
      await session.dmChannel.send('No text channels available. Select the option below to create one.');
    }

    await session.dmChannel.send({
      content: 'Choose the verification channel or create a dedicated one:',
      components: [buildChannelMenu(channels)]
    });
    session.stage = 'channel';
  };

  const promptForRole = async (session) => {
    const roles = [];
    const fetched = await session.guild.roles.fetch();
    for (const role of fetched.values()) {
      if (!role.managed) {
        roles.push(role);
      }
    }

    if (!roles.length) {
      await session.dmChannel.send('No suitable roles detected. Select the option below to create the verification role.');
    }

    await session.dmChannel.send({
      content: 'Choose the verification role or create a new one:',
      components: [buildRoleMenu(roles)]
    });
    session.stage = 'role';
  };

  const persistConfiguration = async ({ guild, channel, role }) => {
    const result = await configUpdater.upsertDiscordGuildConfig({
      guildId: guild.id,
      verificationChannelId: channel.id,
      verifiedRoleId: role.id,
      verifiedRoleName: role.name
    });

    if (discordConfig.guilds) {
      const index = discordConfig.guilds.findIndex((item) => item.id === guild.id);
      const nextValue = {
        id: guild.id,
        verificationChannelId: channel.id,
        verifiedRoleId: role.id,
        verifiedRoleName: role.name
      };
      if (index >= 0) {
        discordConfig.guilds[index] = { ...discordConfig.guilds[index], ...nextValue };
      } else {
        discordConfig.guilds.push(nextValue);
      }
    } else {
      discordConfig.guilds = [{
        id: guild.id,
        verificationChannelId: channel.id,
        verifiedRoleId: role.id,
        verifiedRoleName: role.name
      }];
    }

    if (result?.config?.discord?.guilds) {
      discordConfig.guilds = result.config.discord.guilds;
    }
  };

  const handleSetupMessage = async (message) => {
    if (message.guild) {
      await message.reply('Please DM me to run the setup wizard.');
      return;
    }

    const userId = message.author.id;
    const eligibleGuilds = await fetchEligibleGuilds(userId);

    if (!eligibleGuilds.length) {
      await message.reply('You do not administer any servers that include this bot. Add the bot to your server and ensure you have Manage Server permissions.');
      return;
    }

    const session = {
      userId,
      dmChannel: message.channel,
      guild: null,
      stage: 'guild'
    };
    sessions.set(userId, session);

    await message.reply({
      content: 'Let’s configure your server. Select the server you want to set up:',
      components: [buildGuildMenu(eligibleGuilds)]
    });
  };

  const handleSelectMenuInteraction = async (interaction) => {
    if (!interaction.isStringSelectMenu()) {
      return false;
    }

    const session = findSession(interaction.user.id);
    if (!session) {
      return false;
    }

    if (interaction.customId === SETUP_SELECT_GUILD) {
      const guildId = interaction.values[0];
      const guild = await client.guilds.fetch(guildId);
      session.guild = guild;
      await interaction.update({
        content: `Server selected: **${guild.name}**.`,
        components: []
      });
      await promptForChannel(session);
      return true;
    }

    if (interaction.customId === SETUP_SELECT_CHANNEL && session.stage === 'channel') {
      const choice = interaction.values[0];
      let channel;

      if (choice === CREATE_CHANNEL_VALUE) {
        const baseName = 'verification';
        let channelName = baseName;
        let counter = 1;
        while (session.guild.channels.cache?.some((existing) => existing.name === channelName)) {
          counter += 1;
          channelName = `${baseName}-${counter}`;
        }

        channel = await session.guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          reason: `Verification setup initiated by ${interaction.user.tag}`
        });
        await interaction.update({
          content: `Created channel <#${channel.id}> for verification.`,
          components: []
        });
      } else {
        channel = await session.guild.channels.fetch(choice);
        await interaction.update({
          content: `Verification channel set to <#${channel.id}>.`,
          components: []
        });
      }

      session.channel = channel;
      await promptForRole(session);
      return true;
    }

    if (interaction.customId === SETUP_SELECT_ROLE && session.stage === 'role') {
      const choice = interaction.values[0];
      let role;

      if (choice === CREATE_ROLE_VALUE) {
        role = await session.guild.roles.create({
          name: 'Verified Member',
          mentionable: true,
          reason: `Verification setup initiated by ${interaction.user.tag}`
        });
        await interaction.update({
          content: `Created verification role **${role.name}**.`,
          components: []
        });
      } else {
        role = await session.guild.roles.fetch(choice);
        await interaction.update({
          content: `Verification role set to **${role.name}**.`,
          components: []
        });
      }

      session.role = role;

      await persistConfiguration({
        guild: session.guild,
        channel: session.channel,
        role: session.role
      });

      try {
        await publishEmbed({
          guild: session.guild,
          channelId: session.channel.id,
          volumeVerifier
        });
        await session.dmChannel.send('Setup complete! The verification message has been posted.');
      } catch (error) {
        logger.error(`Failed to publish verification embed during setup: ${error.message}`);
        await session.dmChannel.send('Configuration saved, but the verification embed could not be posted. Please check the channel permissions and try again.');
      } finally {
        endSession(interaction.user.id);
      }

      return true;
    }

    return false;
  };

  const handleInteraction = async (interaction) => {
    try {
      return await handleSelectMenuInteraction(interaction);
    } catch (error) {
      logger.error(`Discord setup wizard interaction failed: ${error.message}`);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: 'Something went wrong handling your selection. Please try again.', ephemeral: true });
        } else {
          await interaction.reply({ content: 'Something went wrong handling your selection. Please try again.', ephemeral: true });
        }
      } catch (replyError) {
        logger.error(`Failed to report setup wizard error: ${replyError.message}`);
      }
      return true;
    }
  };

  return {
    handleSetupMessage,
    handleInteraction
  };
};

const findGuildConfiguration = (discordConfig, guildId) => {
  if (!discordConfig?.guilds) {
    return null;
  }
  return discordConfig.guilds.find((guild) => String(guild.id) === String(guildId)) || null;
};

const sendDirectMessage = async (user, content) => {
  try {
    await user.send(content);
    return { delivered: true, error: null };
  } catch (error) {
    logger.warn('Failed to send Discord DM.', {
      userId: user?.id || null,
      error: error.message
    });
    return { delivered: false, error: error?.message || null };
  }
};

const buildFailureResponse = ({ result, uid, exchangeLabel, affiliateLink }) => {
  const lines = [formatVerificationMessage(result), ''];
  const depositReason = result.deposit?.reason;

  if (depositReason === 'user_not_found') {
    lines.push(`We could not find UID ${uid} on ${exchangeLabel}.`);
    if (affiliateLink) {
      lines.push(`Register using this affiliate link, then retry: ${affiliateLink}`);
    } else {
      lines.push('Confirm you registered through the official affiliate link before trying again.');
    }
  } else if (depositReason === 'no deposit' || depositReason === 'deposit_not_met') {
    const thresholdText = typeof result.deposit?.threshold === 'number'
      ? `the required deposit of ${result.deposit.threshold}`
      : 'the required deposit';
    lines.push(`We could not confirm ${thresholdText}. Complete the deposit and try again.`);
  } else if (depositReason === 'deposit_check_failed') {
    lines.push('We could not reach the exchange to confirm your deposit. Please try again shortly.');
  } else {
    lines.push('We could not verify this UID. Double-check the value and try again.');
  }

  lines.push('You retain your current server access until verification succeeds.');
  return lines.join('\n');
};

const buildSuccessResponse = ({ result, roleName, volumeWarningEnabled }) => {
  const lines = [formatVerificationMessage(result)];

  if (roleName) {
    lines.push(`You have been granted the **${roleName}** role.`);
  }

  if (result.volumeMet === false) {
    lines.push('⚠️ Your trading volume is below the requirement. Continue trading to avoid losing access.');
    if (volumeWarningEnabled !== false) {
      lines.push('A reminder will be sent before any access changes.');
    }
  }

  return lines.join('\n');
};

// Owners inherit administrator privileges even if they are not explicitly listed.
export const isDiscordAdmin = (message, discordConfig) => {
  const ownerId = discordConfig?.ownerId ? String(discordConfig.ownerId) : null;
  if (ownerId && message.author?.id && ownerId === String(message.author.id)) {
    return true;
  }

  const adminUserIds = (discordConfig.adminUserIds || []).map((id) => String(id));
  if (message.author?.id && adminUserIds.includes(String(message.author.id))) {
    return true;
  }

  const adminRoleIds = (discordConfig.adminRoleIds || []).map((id) => String(id));
  if (adminRoleIds.length && message.member?.roles?.cache) {
    return message.member.roles.cache.some((role) => adminRoleIds.includes(String(role.id)));
  }

  return false;
};

export const buildSettingsHelp = (prefix, command) => [
  `Usage: ${prefix}${command} <subcommand>`,
  '',
  'Available subcommands:',
  '- volume <on|off>',
  '- min-volume <amount>',
  '- deposit <amount|clear>',
  '- volume-days <days>',
  '- volume-warning <on|off>',
  '- warning-days <days>',
  '- api add <name> <type> <key> <secret> [passphrase]',
  '- api update <name> <type> <key> <secret> [passphrase]',
  '- api remove <name>',
  '- api list',
  '- affiliate <exchange> <url|clear>',
  '- show'
].join('\n');

export const buildOwnerHelp = (prefix, command) => [
  `Usage: ${prefix}${command} <subcommand>`,
  '',
  'Owner subcommands:',
  '- register <passkey>',
  '- add-admin <userId>',
  '- remove-admin <userId>',
  '- add-role <roleId>',
  '- remove-role <roleId>',
  '- list-admins',
  '- transfer-owner <userId>'
].join('\n');

/**
 * Summarises the Discord bot commands and provides usage examples. Update this
 * helper whenever a new command is introduced so `help` stays current.
 */
export const buildDiscordHelp = ({ prefix, verifyCommand, setupCommand, settingsCommand, ownerCommand, helpCommand }) => [
  'Available commands:',
  `• ${prefix}${verifyCommand} <uid> [exchangeId] [minimumVolume] – Verify a user and confirm their affiliate deposit. Example: ${prefix}${verifyCommand} 123456`,
  `• ${prefix}${setupCommand} – Run the DM setup wizard to link a server, choose the verification channel, and assign the verification role. Start this command in a direct message so the bot can walk you through publishing the verification embed.`,
  `• ${prefix}${settingsCommand} – Manage verification settings (admins only). Example: ${prefix}${settingsCommand} show`,
  `• ${prefix}${ownerCommand} – Manage bot ownership and admin access (owner only). Example: ${prefix}${ownerCommand} list-admins`,
  `• ${prefix}${helpCommand} – Display this command list. Example: ${prefix}${helpCommand}`
].join('\n');

export const normaliseBooleanFlag = (value) => {
  const normalised = String(value || '').trim().toLowerCase();
  if (['on', 'enable', 'enabled', 'true', 'yes'].includes(normalised)) {
    return true;
  }
  if (['off', 'disable', 'disabled', 'false', 'no'].includes(normalised)) {
    return false;
  }
  throw new Error('Boolean flag must be either on or off.');
};

export const handleSettingsCommand = async (message, args, context) => {
  const { discordConfig, volumeVerifier, commandPrefix, settingsCommandName, configUpdater } = context;

  if (!isDiscordAdmin(message, discordConfig)) {
    await message.reply('You are not authorised to manage bot settings.');
    logger.warn('Discord user attempted to access settings without permission.', {
      userId: message.author?.id,
      guildId: message.guild?.id
    });
    return;
  }

  if (args.length === 0) {
    await message.reply(buildSettingsHelp(commandPrefix, settingsCommandName));
    return;
  }

  const subcommand = args.shift().toLowerCase();

  try {
    let updatedConfig;
    switch (subcommand) {
      case 'volume': {
        const enabled = normaliseBooleanFlag(args[0]);
        updatedConfig = await configUpdater.setVolumeCheckEnabled(enabled);
        await message.reply(`Trading volume check has been ${enabled ? 'enabled' : 'disabled'}.`);
        break;
      }
      case 'min-volume': {
        const amount = args[0];
        updatedConfig = await configUpdater.setMinimumVolume(amount);
        await message.reply(`Minimum trading volume requirement updated to ${updatedConfig.verification.minimumVolume}.`);
        break;
      }
      case 'deposit': {
        const value = args[0];
        const amount = ['clear', 'none', 'off'].includes(String(value).toLowerCase()) ? null : value;
        updatedConfig = await configUpdater.setDepositThreshold(amount);
        const { depositThreshold } = updatedConfig.verification;
        await message.reply(depositThreshold === null
          ? 'Deposit threshold cleared.'
          : `Deposit threshold set to ${depositThreshold}.`);
        break;
      }
      case 'volume-days': {
        const days = args[0];
        updatedConfig = await configUpdater.setVolumeCheckDays(days);
        await message.reply(`Trading volume window updated to ${updatedConfig.verification.volumeCheckDays} days.`);
        break;
      }
      case 'volume-warning': {
        const enabled = normaliseBooleanFlag(args[0]);
        updatedConfig = await configUpdater.setVolumeWarningEnabled(enabled);
        await message.reply(`Volume warning notifications have been ${enabled ? 'enabled' : 'disabled'}.`);
        break;
      }
      case 'warning-days': {
        const days = args[0];
        updatedConfig = await configUpdater.setVolumeWarningDays(days);
        await message.reply(`Warning lead time updated to ${updatedConfig.verification.volumeWarningDays} days.`);
        break;
      }
      case 'api': {
        const action = (args.shift() || '').toLowerCase();
        if (action === 'add' || action === 'update') {
          const [name, type, apiKey, apiSecret, passphrase] = args;
          if (!name || !type || !apiKey || !apiSecret) {
            throw new Error('Usage: api add|update <name> <type> <key> <secret> [passphrase]');
          }
          updatedConfig = await configUpdater.upsertExchangeCredentials({
            name,
            type,
            apiKey,
            apiSecret,
            passphrase
          });
          await message.reply(`Credentials ${action === 'add' ? 'created' : 'updated'} for exchange ${name}.`);
        } else if (action === 'remove' || action === 'delete') {
          const name = args[0];
          if (!name) {
            throw new Error('Usage: api remove <name>');
          }
          updatedConfig = await configUpdater.removeExchange(name);
          await message.reply(`Exchange ${name} removed.`);
        } else if (action === 'list') {
          const exchanges = await configUpdater.listExchanges();
          if (!exchanges.length) {
            await message.reply('No exchanges are configured in the database.');
          } else {
            const lines = exchanges.map((exchange) => `• ${exchange.name} (${exchange.type || 'type unknown'})`);
            await message.reply(['Configured exchanges:', ...lines].join('\n'));
          }
          return;
        } else {
          throw new Error('Unknown api action. Use add, update, remove, or list.');
        }
        break;
      }
      case 'affiliate': {
        const name = args.shift();
        if (!name || !args.length) {
          throw new Error('Usage: affiliate <exchange> <url|clear>');
        }

        const rawLink = args.join(' ').trim();
        const shouldClear = ['clear', 'none', 'off'].includes(rawLink.toLowerCase());
        const linkValue = shouldClear ? null : rawLink;
        updatedConfig = await configUpdater.setExchangeAffiliateLink(name, linkValue);
        await message.reply(linkValue
          ? `Affiliate link for ${name} updated.`
          : `Affiliate link for ${name} cleared.`);
        break;
      }
      case 'show': {
        const config = await loadRuntimeConfig();
        const { verification } = config;
        const summary = [
          `Volume check: ${verification.volumeCheckEnabled ? 'enabled' : 'disabled'}`,
          `Minimum volume: ${verification.minimumVolume}`,
          `Deposit threshold: ${verification.depositThreshold ?? 'not set'}`,
          `Volume window (days): ${verification.volumeCheckDays}`,
          `Warning notifications: ${verification.volumeWarningEnabled !== false ? 'enabled' : 'disabled'}`,
          `Warning lead time (days): ${verification.volumeWarningDays}`
        ];
        await message.reply(summary.join('\n'));
        return;
      }
      default:
        await message.reply(buildSettingsHelp(commandPrefix, settingsCommandName));
        return;
    }

    if (updatedConfig) {
      try {
        volumeVerifier.refresh(updatedConfig);
      } catch (refreshError) {
        logger.error(`Failed to refresh volume verifier after Discord settings update: ${refreshError.message}`);
      }
    }
  } catch (error) {
    logger.error(`Discord settings command failed: ${error.message}`);
    await message.reply(`Settings update failed: ${error.message}`);
  }
};

export const handleOwnerCommand = async (message, args, context) => {
  const { discordConfig, commandPrefix, ownerCommandName, configUpdater } = context;

  if (args.length === 0) {
    await message.reply(buildOwnerHelp(commandPrefix, ownerCommandName));
    return;
  }

  const subcommand = args.shift().toLowerCase();

  try {
    if (subcommand === 'register') {
      const passkey = args[0];
      if (!passkey) {
        await message.reply(`Usage: ${commandPrefix}${ownerCommandName} register <passkey>`);
        return;
      }

      await configUpdater.registerOwner({ platform: 'discord', userId: message.author.id, passkey });
      discordConfig.ownerId = String(message.author.id);
      logger.info('Discord owner registered successfully.', { userId: message.author.id });
      await message.reply('Ownership registered. You may now manage admins and ownership transfers.');
      return;
    }

    await configUpdater.requireOwner('discord', message.author.id);

    switch (subcommand) {
      case 'add-admin': {
        const adminId = args[0];
        if (!adminId) {
          await message.reply(`Usage: ${commandPrefix}${ownerCommandName} add-admin <userId>`);
          return;
        }
        const result = await configUpdater.addDiscordAdminUser(adminId);
        if (result.config?.discord) {
          discordConfig.adminUserIds = result.config.discord.adminUserIds;
          discordConfig.adminRoleIds = result.config.discord.adminRoleIds;
        } else {
          discordConfig.adminUserIds = result.userIds;
        }
        const summary = discordConfig.adminUserIds?.length ? discordConfig.adminUserIds.join(', ') : 'none';
        await message.reply(`Added Discord admin user ${adminId}. Current admin users: ${summary}.`);
        return;
      }
      case 'remove-admin': {
        const adminId = args[0];
        if (!adminId) {
          await message.reply(`Usage: ${commandPrefix}${ownerCommandName} remove-admin <userId>`);
          return;
        }
        const result = await configUpdater.removeDiscordAdminUser(adminId);
        if (result.config?.discord) {
          discordConfig.adminUserIds = result.config.discord.adminUserIds;
          discordConfig.adminRoleIds = result.config.discord.adminRoleIds;
        } else {
          discordConfig.adminUserIds = result.userIds;
        }
        const summary = discordConfig.adminUserIds?.length ? discordConfig.adminUserIds.join(', ') : 'none';
        await message.reply(`Removed Discord admin user ${adminId}. Current admin users: ${summary}.`);
        return;
      }
      case 'add-role': {
        const roleId = args[0];
        if (!roleId) {
          await message.reply(`Usage: ${commandPrefix}${ownerCommandName} add-role <roleId>`);
          return;
        }
        const result = await configUpdater.addDiscordAdminRole(roleId);
        if (result.config?.discord) {
          discordConfig.adminRoleIds = result.config.discord.adminRoleIds;
        } else {
          discordConfig.adminRoleIds = result.roleIds;
        }
        const summary = discordConfig.adminRoleIds?.length ? discordConfig.adminRoleIds.join(', ') : 'none';
        await message.reply(`Added Discord admin role ${roleId}. Current admin roles: ${summary}.`);
        return;
      }
      case 'remove-role': {
        const roleId = args[0];
        if (!roleId) {
          await message.reply(`Usage: ${commandPrefix}${ownerCommandName} remove-role <roleId>`);
          return;
        }
        const result = await configUpdater.removeDiscordAdminRole(roleId);
        if (result.config?.discord) {
          discordConfig.adminRoleIds = result.config.discord.adminRoleIds;
        } else {
          discordConfig.adminRoleIds = result.roleIds;
        }
        const summary = discordConfig.adminRoleIds?.length ? discordConfig.adminRoleIds.join(', ') : 'none';
        await message.reply(`Removed Discord admin role ${roleId}. Current admin roles: ${summary}.`);
        return;
      }
      case 'list-admins': {
        const { userIds, roleIds } = await configUpdater.listDiscordAdmins();
        const lines = [
          'Configured Discord admins:',
          `Users: ${userIds.length ? userIds.join(', ') : 'none'}`,
          `Roles: ${roleIds.length ? roleIds.join(', ') : 'none'}`
        ];
        await message.reply(lines.join('\n'));
        return;
      }
      case 'transfer-owner': {
        const targetId = args[0];
        if (!targetId) {
          await message.reply(`Usage: ${commandPrefix}${ownerCommandName} transfer-owner <userId>`);
          return;
        }
        const { passkey } = await configUpdater.transferOwnership({
          currentPlatform: 'discord',
          currentUserId: message.author.id,
          newOwnerId: targetId,
          newOwnerPlatform: 'discord'
        });
        discordConfig.ownerId = String(targetId);
        const masked = passkey.length > 8 ? `${passkey.slice(0, 4)}…${passkey.slice(-4)}` : passkey;
        await message.reply([
          `Ownership transferred to user ${targetId}.`,
          'Share the new passkey with the incoming owner so they can register:',
          passkey,
          '',
          'Communicate the passkey privately to avoid disclosure.'
        ].join('\n'));
        logger.info('Discord ownership transfer completed.', {
          previousOwner: message.author.id,
          newOwner: targetId,
          passkeyPreview: masked
        });
        return;
      }
      default:
        await message.reply(buildOwnerHelp(commandPrefix, ownerCommandName));
    }
  } catch (error) {
    logger.error(`Discord owner command failed: ${error.message}`);
    await message.reply(`Owner command failed: ${error.message}`);
  }
};

export const handleVerifyCommand = async (message, args, context) => {
  const { commandPrefix, commandName, volumeVerifier } = context;
  const [uid, exchangeId, minVolume] = args;

  if (!uid) {
    await message.reply(`Usage: ${commandPrefix}${commandName} <uid> [exchangeId] [minimumVolume]`);
    return;
  }

  let minimumVolumeOverride;
  if (typeof minVolume !== 'undefined') {
    const parsedMinimumVolume = Number(minVolume);
    if (!Number.isFinite(parsedMinimumVolume)) {
      await message.reply(`Minimum volume must be a number. Usage: ${commandPrefix}${commandName} <uid> [exchangeId] [minimumVolume]`);
      return;
    }
    // Store the parsed override so downstream code receives a validated number instead of a NaN payload.
    minimumVolumeOverride = parsedMinimumVolume;
  }

  try {
    const result = await volumeVerifier.verify(uid, {
      exchangeId: exchangeId || undefined,
      minimumVolume: minimumVolumeOverride
    });
    const exchangeMeta = volumeVerifier.getExchangeConfig ? volumeVerifier.getExchangeConfig(result.exchangeId || exchangeId) : null;
    const affiliateLink = exchangeMeta?.affiliateLink || null;
    const exchangeLabel = exchangeMeta?.description || exchangeMeta?.name || result.exchangeName || result.exchangeId || exchangeId || 'the selected exchange';

    if (!result.passed) {
      const lines = [formatVerificationMessage(result), ''];
      const depositReason = result.deposit?.reason;

      if (depositReason === 'user_not_found') {
        lines.push(`We couldn't find UID ${uid} on ${exchangeLabel}.`);
        if (affiliateLink) {
          lines.push(`Register using this affiliate link, then try again: ${affiliateLink}`);
        } else {
          lines.push('Please register using the official affiliate link before retrying.');
        }
      } else if (depositReason === 'no deposit' || depositReason === 'deposit_not_met') {
        const thresholdText = typeof result.deposit?.threshold === 'number'
          ? `the required deposit of ${result.deposit.threshold}`
          : 'the required deposit';
        lines.push(`We could not confirm ${thresholdText} for this UID. Complete your deposit and try again.`);
      } else if (depositReason === 'deposit_check_failed') {
        lines.push('We could not reach the exchange to confirm your deposit. Please try again shortly.');
      } else {
        lines.push('We could not verify this UID. Double-check the value and try again.');
      }

      await message.reply(lines.join('\n'));
      return;
    }

    try {
      await saveVerifiedUser(result.influencer, uid, {
        exchange: result.exchangeId,
        exchangeId: result.exchangeDbId || null,
        discordUserId: message.author?.id ? String(message.author.id) : null,
        guildId: message.guild?.id ? String(message.guild.id) : null
      });
    } catch (error) {
      if (error instanceof VerifiedUserConflictError) {
        logger.warn(`UID ${uid} already verified for ${result.influencer}.`, {
          influencer: result.influencer,
          discordUserId: message.author?.id,
          guildId: message.guild?.id
        });
        await message.reply('This UID has already been verified by another account. Please supply a different UID.');
        return;
      }
      throw error;
    }

    await message.reply(formatVerificationMessage(result));
  } catch (error) {
    if (error instanceof VerifiedUserConflictError) {
      return;
    }
    logger.error(`Discord verification failed: ${error.message}`);
    await message.reply(`Unable to verify UID ${uid}. ${error.message}`);
  }
};

export const createDiscordBot = (discordConfig, volumeVerifier, dependencies = {}) => {
  if (!discordConfig?.enabled) {
    logger.info('Discord integration disabled.');
    return null;
  }

  if (!discordConfig.token) {
    throw new Error('Discord bot token is required when Discord integration is enabled.');
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel]
  });

  const commandName = discordConfig.commandName || 'verify';
  const commandPrefix = discordConfig.commandPrefix || '!';
  const settingsCommandName = discordConfig.settingsCommandName || 'settings';
  const ownerCommandName = discordConfig.ownerCommandName || 'owner';
  const helpCommandName = discordConfig.helpCommandName || 'help';
  const setupCommandName = discordConfig.setupCommandName || 'setup';
  const configUpdater = dependencies.configUpdater || configUpdateService;
  const setupWizard = createDiscordSetupWizard({
    client,
    configUpdater,
    volumeVerifier,
    discordConfig
  });

  client.once('ready', () => {
    logger.info(`Discord bot logged in as ${client.user.tag}`);
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) {
      return;
    }

    if (!message.content.startsWith(commandPrefix)) {
      return;
    }

    const content = message.content.slice(commandPrefix.length).trim();
    const [receivedCommand, ...args] = content.split(/\s+/);

    if (receivedCommand === setupCommandName) {
      await setupWizard.handleSetupMessage(message);
      return;
    }

    if (receivedCommand === commandName) {
      await handleVerifyCommand(message, args, { commandPrefix, commandName, volumeVerifier });
      return;
    }

    if (receivedCommand === settingsCommandName) {
      await handleSettingsCommand(message, args, {
        discordConfig,
        volumeVerifier,
        commandPrefix,
        settingsCommandName,
        configUpdater
      });
      return;
    }

    if (receivedCommand === ownerCommandName) {
      await handleOwnerCommand(message, args, {
        discordConfig,
        commandPrefix,
        ownerCommandName,
        configUpdater
      });
      return;
    }

    if (receivedCommand === helpCommandName) {
      logger.info('Discord help command invoked.', {
        userId: message.author?.id,
        guildId: message.guild?.id
      });
      await message.reply(buildDiscordHelp({
        prefix: commandPrefix,
        verifyCommand: commandName,
        setupCommand: setupCommandName,
        settingsCommand: settingsCommandName,
        ownerCommand: ownerCommandName,
        helpCommand: helpCommandName
      }));
    }
  });

  client.on('interactionCreate', async (interaction) => {
    if (await setupWizard.handleInteraction(interaction)) {
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith(`${VERIFICATION_BUTTON_PREFIX}:`)) {
      const parts = interaction.customId.split(':');
      const guildId = parts[1];
      const exchangeId = parts[2];

      if (!exchangeId || parts[1] === 'disabled') {
        await interaction.reply({
          content: 'Verification is not available because no exchanges are configured. Please contact an administrator.',
          ephemeral: true
        });
        return;
      }

      const exchangeMeta = volumeVerifier.getExchangeConfig ? volumeVerifier.getExchangeConfig(exchangeId) : null;
      if (!exchangeMeta) {
        await interaction.reply({
          content: 'This exchange is not currently configured. Please reach out to an administrator.',
          ephemeral: true
        });
        return;
      }

      const exchangeLabel = exchangeMeta.description || exchangeMeta.name || exchangeId;
      const modal = new ModalBuilder()
        .setCustomId(`${VERIFICATION_MODAL_PREFIX}:${guildId}:${exchangeId}`)
        .setTitle(`${exchangeLabel} verification`)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('uid')
              .setLabel('Exchange UID')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('Enter your UID exactly as it appears on the exchange')
              .setRequired(true)
          )
        );

      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith(`${VERIFICATION_MODAL_PREFIX}:`)) {
      const [, guildId, exchangeId] = interaction.customId.split(':');
      const uid = interaction.fields.getTextInputValue('uid');

      await interaction.deferReply({ ephemeral: true });

      try {
        const result = await volumeVerifier.verify(uid, { exchangeId });
        const exchangeMeta = volumeVerifier.getExchangeConfig ? volumeVerifier.getExchangeConfig(exchangeId) : null;
        const affiliateLink = exchangeMeta?.affiliateLink || null;
        const exchangeLabel = exchangeMeta?.description || exchangeMeta?.name || result.exchangeName || exchangeId;

        if (!result.passed) {
          const failureMessage = buildFailureResponse({
            result,
            uid,
            exchangeLabel,
            affiliateLink
          });
          // Attempt DM delivery first so we can fall back to the modal reply when Discord blocks DMs.
          const delivery = await sendDirectMessage(interaction.user, failureMessage);

          if (delivery.delivered) {
            await interaction.editReply('Verification failed. Please check your DMs for details.');
          } else {
            const fallbackLines = [
              failureMessage,
              '',
              `⚠️ We couldn't send a DM with this result${delivery.error ? `: ${delivery.error}` : ''}. Update your privacy settings and try again if you need another copy.`
            ];
            await interaction.editReply(fallbackLines.join('\n'));
          }

          logger.info('Discord verification failed through modal interaction.', {
            userId: interaction.user.id,
            guildId: guildId || interaction.guildId,
            exchangeId,
            reason: result.deposit?.reason || 'unknown',
            dmDelivered: delivery.delivered,
            dmError: delivery.error || undefined
          });
          return;
        }

        try {
          await saveVerifiedUser(result.influencer, uid, {
            exchange: result.exchangeId,
            exchangeId: result.exchangeDbId || null,
            discordUserId: interaction.user.id,
            guildId: guildId || interaction.guildId || null
          });
        } catch (error) {
          if (error instanceof VerifiedUserConflictError) {
            const conflictMessage = 'This UID has already been verified by another account. Please contact support if you believe this is an error.';
            await interaction.editReply(conflictMessage);
            await sendDirectMessage(interaction.user, conflictMessage);
            return;
          }
          throw error;
        }

        let roleAssigned = false;
        let roleName = null;
        const guildConfig = findGuildConfiguration(discordConfig, guildId || interaction.guildId);
        const targetGuildId = guildId || interaction.guildId;

        if (guildConfig?.verifiedRoleId && targetGuildId) {
          try {
            const guild = interaction.guild ?? await client.guilds.fetch(targetGuildId);
            const member = await guild.members.fetch(interaction.user.id);
            await member.roles.add(guildConfig.verifiedRoleId, 'Verified via UID check');
            roleAssigned = true;
            roleName = guild.roles.cache.get(guildConfig.verifiedRoleId)?.name || guildConfig.verifiedRoleName || null;
          } catch (roleError) {
            logger.error(`Failed to assign verified role on Discord: ${roleError.message}`);
          }
        } else {
          logger.warn('Verified role not configured for guild; skipping role assignment.', {
            guildId: targetGuildId
          });
        }

        let volumeWarningEnabled = true;
        try {
          const runtimeConfig = await loadRuntimeConfig();
          volumeWarningEnabled = runtimeConfig.verification?.volumeWarningEnabled !== false;
        } catch (configError) {
          logger.warn('Failed to load runtime configuration during verification response.', {
            error: configError.message
          });
        }

        const successMessage = buildSuccessResponse({
          result,
          roleName,
          volumeWarningEnabled
        });

        // Deliver the detailed result privately when possible; otherwise, surface it in the modal reply.
        const delivery = await sendDirectMessage(interaction.user, successMessage);

        if (delivery.delivered) {
          if (roleAssigned) {
            await interaction.editReply('Verification successful! A confirmation has been sent to your DMs.');
          } else {
            await interaction.editReply('Verification successful! Check your DMs for the result.');
          }
        } else {
          const fallbackLines = [
            successMessage,
            '',
            `⚠️ We couldn't send a DM with this confirmation${delivery.error ? `: ${delivery.error}` : ''}. Review your privacy settings and keep this message for your records.`
          ];
          await interaction.editReply(fallbackLines.join('\n'));
        }

        logger.info('Discord verification completed through modal interaction.', {
          userId: interaction.user.id,
          guildId: guildId || interaction.guildId,
          exchangeId,
          roleAssigned,
          dmDelivered: delivery.delivered,
          dmError: delivery.error || undefined
        });
      } catch (error) {
        if (error instanceof VerifiedUserConflictError) {
          return;
        }
        logger.error(`Discord modal verification failed: ${error.message}`);
        await interaction.editReply(`Unable to verify UID ${uid}. ${error.message}`);
      }
    }
  });

  client.login(discordConfig.token).catch((error) => {
    logger.error(`Discord login failed: ${error.message}`);
  });

  return client;
};

export default createDiscordBot;
