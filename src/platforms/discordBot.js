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
import statisticsService from '../services/statisticsService.js';

const normaliseDepositReason = (reason, translator) => {
  if (!reason) {
    return null;
  }

  const key = `common.verification.depositReasons.${reason}`;
  if (translator?.t) {
    const translated = translator.t(key);
    if (translated && translated !== key) {
      return translated;
    }
  }

  const text = String(reason).replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export const formatVerificationMessage = (result, translator) => {
  const translate = ensureTranslator(translator);

  const status = result.passed
    ? translate('common.verification.status.passed')
    : translate('common.verification.status.failed');
  const exchangeLabel = result.exchangeName || result.exchangeId || translate('common.labels.notAvailable');
  const lines = [
    status,
    translate('common.verification.uid', { uid: result.uid }),
    translate('common.verification.exchange', { label: exchangeLabel })
  ];

  if (typeof result.volume === 'number' && !Number.isNaN(result.volume)) {
    lines.push(translate('common.verification.recordedVolume', { volume: result.volume }));
    if (result.volumeMet === false) {
      lines.push(translate('common.verification.volumeTargetNotMet', { minimum: result.minimumVolume }));
    } else if (result.volumeMet === true) {
      lines.push(translate('common.verification.volumeTargetMet', { minimum: result.minimumVolume }));
    } else if (result.skipped) {
      lines.push(translate('common.verification.volumeTargetSkipped', { minimum: result.minimumVolume }));
    }
  } else if (result.skipped) {
    lines.push(translate('common.verification.volumeTrackingDisabled'));
  }

  const depositThreshold = result.deposit?.threshold;
  const depositMet = result.deposit?.met !== false;
  const amount = typeof result.deposit?.amount === 'number' ? result.deposit.amount : null;

  if (typeof depositThreshold !== 'undefined' && depositThreshold !== null) {
    const statusText = depositMet
      ? translate('common.verification.depositStatus.met')
      : translate('common.verification.depositStatus.notMet');
    if (amount !== null) {
      lines.push(translate('common.verification.depositSummary', {
        amount,
        threshold: depositThreshold,
        status: statusText
      }));
    } else {
      lines.push(translate('common.verification.depositThreshold', {
        threshold: depositThreshold,
        status: statusText
      }));
    }
  } else if (amount !== null) {
    lines.push(translate('common.verification.depositAmount', { amount }));
  }

  if (!depositMet && result.deposit?.reason) {
    const reasonText = normaliseDepositReason(result.deposit.reason, translator);
    if (reasonText) {
      lines.push(translate('common.verification.depositReason', { reason: reasonText }));
    }
  }

  lines.push(translate('common.verification.checkedAt', { timestamp: result.timestamp }));
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

const ensureTranslator = (translator) => {
  if (!translator || typeof translator.t !== 'function') {
    throw new Error('A translator instance exposing t(key, vars) is required for Discord localisation.');
  }
  return (key, vars) => translator.t(key, vars);
};

const hasGuildSetupPermission = (member) => {
  if (!member?.permissions) {
    return false;
  }
  return member.permissions.has(PermissionFlagsBits.Administrator)
    || member.permissions.has(PermissionFlagsBits.ManageGuild);
};

export const buildVerificationEmbedPayload = ({ guildName, exchanges, guildId, translator }) => {
  const translate = ensureTranslator(translator);
  const descriptionLines = translate('discord.verification.embed.description');
  const description = Array.isArray(descriptionLines) ? descriptionLines.join('\n') : descriptionLines;
  const embed = new EmbedBuilder()
    .setTitle(translate('discord.verification.embed.title'))
    .setDescription(description)
    .setColor(0x5865F2)
    .setFooter({
      text: guildName
        ? translate('discord.verification.embed.footerWithGuild', { guildName })
        : translate('discord.verification.embed.footerDefault')
    })
    .setTimestamp();

  const affiliateLines = exchanges
    .filter((exchange) => exchange.affiliateLink)
    .map((exchange) => translate('discord.verification.embed.affiliateLine', {
      name: exchange.name || exchange.description || exchange.id,
      link: exchange.affiliateLink
    }));

  if (affiliateLines.length) {
    embed.addFields({
      name: translate('discord.verification.embed.affiliateLinksTitle'),
      value: affiliateLines.join('\n')
    });
  }

  const rows = [];
  let currentRow = new ActionRowBuilder();

  if (exchanges.length === 0) {
    const button = new ButtonBuilder()
      .setCustomId(`${VERIFICATION_BUTTON_PREFIX}:disabled:${guildId || 'unknown'}`)
      .setLabel(translate('discord.verification.embed.noExchangesLabel'))
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

export const publishVerificationEmbed = async ({ guild, channelId, volumeVerifier, translator }) => {
  const translate = ensureTranslator(translator);
  if (!guild || !channelId) {
    throw new Error(translate('discord.verification.embed.missingContextError'));
  }

  const channel = await guild.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error(translate('discord.verification.embed.invalidChannelError'));
  }

  const exchanges = volumeVerifier.getExchanges ? volumeVerifier.getExchanges() : [];
  const payload = buildVerificationEmbedPayload({
    guildName: guild.name,
    guildId: guild.id,
    exchanges,
    translator
  });

  await channel.send(payload);
  logger.info('Published verification embed to Discord channel.', {
    guildId: guild.id,
    channelId: channel.id,
    exchanges: exchanges.map((exchange) => exchange.id)
  });
};

export const createDiscordSetupWizard = ({
  client,
  configUpdater,
  volumeVerifier,
  discordConfig,
  publishEmbed = publishVerificationEmbed,
  translator
}) => {
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

  const buildGuildMenu = (guilds, translator) => {
    const translate = ensureTranslator(translator);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(SETUP_SELECT_GUILD)
      .setPlaceholder(translate('discord.setup.guildMenu.placeholder'))
      .addOptions(guilds.slice(0, 25).map((guild) => ({
        label: guild.name.length > 100 ? `${guild.name.slice(0, 97)}…` : guild.name,
        value: guild.id
      })));

    return new ActionRowBuilder().addComponents(menu);
  };

  const buildChannelMenu = (channels, translator) => {
    const translate = ensureTranslator(translator);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(SETUP_SELECT_CHANNEL)
      .setPlaceholder(translate('discord.setup.channelMenu.placeholder'));

    for (const channel of channels.slice(0, 24)) {
      menu.addOptions({
        label: `#${channel.name}`,
        value: channel.id
      });
    }

    menu.addOptions({
      label: translate('discord.setup.channelMenu.createNew'),
      value: CREATE_CHANNEL_VALUE
    });

    return new ActionRowBuilder().addComponents(menu);
  };

  const buildRoleMenu = (roles, translator) => {
    const translate = ensureTranslator(translator);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(SETUP_SELECT_ROLE)
      .setPlaceholder(translate('discord.setup.roleMenu.placeholder'));

    for (const role of roles.slice(0, 24)) {
      menu.addOptions({
        label: role.name,
        value: role.id
      });
    }

    menu.addOptions({
      label: translate('discord.setup.roleMenu.createNew'),
      value: CREATE_ROLE_VALUE
    });

    return new ActionRowBuilder().addComponents(menu);
  };

  const promptForChannel = async (session, translator) => {
    const translate = ensureTranslator(translator);
    const channels = [];
    const fetched = await session.guild.channels.fetch();
    for (const channel of fetched.values()) {
      if (channel.type === ChannelType.GuildText) {
        channels.push(channel);
      }
    }

    if (!channels.length) {
      await session.dmChannel.send(translate('discord.setup.channelMenu.noTextChannels'));
    }

    await session.dmChannel.send({
      content: translate('discord.setup.channelMenu.prompt'),
      components: [buildChannelMenu(channels, translator)]
    });
    session.stage = 'channel';
  };

  const promptForRole = async (session, translator) => {
    const translate = ensureTranslator(translator);
    const roles = [];
    const fetched = await session.guild.roles.fetch();
    for (const role of fetched.values()) {
      if (!role.managed) {
        roles.push(role);
      }
    }

    if (!roles.length) {
      await session.dmChannel.send(translate('discord.setup.roleMenu.noRoles'));
    }

    await session.dmChannel.send({
      content: translate('discord.setup.roleMenu.prompt'),
      components: [buildRoleMenu(roles, translator)]
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
    const translate = ensureTranslator(translator);
    if (message.guild) {
      await message.reply(translate('discord.setup.dmPrompt'));
      return;
    }

    const userId = message.author.id;
    const eligibleGuilds = await fetchEligibleGuilds(userId);

    if (!eligibleGuilds.length) {
      await message.reply(translate('discord.setup.noEligibleGuilds'));
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
      content: translate('discord.setup.introMessage'),
      components: [buildGuildMenu(eligibleGuilds, translator)]
    });
  };

  const handleSelectMenuInteraction = async (interaction) => {
    const translate = ensureTranslator(translator);
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
      const content = translate('discord.setup.guildSelected', { guildName: guild.name });
      await interaction.update({
        content,
        components: []
      });
      await promptForChannel(session, translator);
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
        const response = translate('discord.setup.channelCreated', { channelId: channel.id });
        await interaction.update({
          content: response,
          components: []
        });
      } else {
        channel = await session.guild.channels.fetch(choice);
        const response = translate('discord.setup.channelSelected', { channelId: channel.id });
        await interaction.update({
          content: response,
          components: []
        });
      }

      session.channel = channel;
      await promptForRole(session, translator);
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
        const response = translate('discord.setup.roleCreated', { roleName: role.name });
        await interaction.update({
          content: response,
          components: []
        });
      } else {
        role = await session.guild.roles.fetch(choice);
        const response = translate('discord.setup.roleSelected', { roleName: role.name });
        await interaction.update({
          content: response,
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
          volumeVerifier,
          translator
        });
        await session.dmChannel.send(translate('discord.setup.complete'));
      } catch (error) {
        logger.error(`Failed to publish verification embed during setup: ${error.message}`);
        await session.dmChannel.send(translate('discord.setup.embedPublishFailed'));
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
        const translate = ensureTranslator(translator);
        const content = translate('discord.setup.genericError');
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content, ephemeral: true });
        } else {
          await interaction.reply({ content, ephemeral: true });
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

const buildFailureResponse = ({ result, uid, exchangeLabel, affiliateLink, translator }) => {
  const translate = ensureTranslator(translator);
  const lines = [formatVerificationMessage(result, translator), ''];
  const depositReason = result.deposit?.reason;

  if (depositReason === 'user_not_found') {
    lines.push(translate('discord.verification.failure.userNotFound', {
      uid,
      exchange: exchangeLabel
    }));
    if (affiliateLink) {
      lines.push(translate('discord.verification.failure.userNotFoundAffiliate', { link: affiliateLink }));
    } else {
      lines.push(translate('discord.verification.failure.userNotFoundNoAffiliate'));
    }
  } else if (depositReason === 'no deposit' || depositReason === 'deposit_not_met') {
    const thresholdText = typeof result.deposit?.threshold === 'number'
      ? translate('discord.verification.failure.depositRequirementWithAmount', { amount: result.deposit.threshold })
      : translate('discord.verification.failure.depositRequirementGeneric');
    lines.push(translate('discord.verification.failure.depositNotMet', { requirement: thresholdText }));
  } else if (depositReason === 'deposit_check_failed') {
    lines.push(translate('discord.verification.failure.depositCheckFailed'));
  } else {
    lines.push(translate('discord.verification.failure.generic'));
  }

  lines.push(translate('discord.verification.failure.retainAccess'));
  return lines.join('\n');
};

const buildSuccessResponse = ({ result, roleName, volumeWarningEnabled, translator }) => {
  const translate = ensureTranslator(translator);
  const lines = [formatVerificationMessage(result, translator)];

  if (roleName) {
    lines.push(translate('discord.verification.success.roleGranted', { roleName }));
  }

  if (result.volumeMet === false) {
    lines.push(translate('discord.verification.success.volumeBelow'));
    if (volumeWarningEnabled !== false) {
      lines.push(translate('discord.verification.success.volumeWarningPending'));
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

export const buildSettingsHelp = (prefix, command, translator) => {
  const translate = ensureTranslator(translator);
  const lines = translate('discord.settings.help', { prefix, command });
  return Array.isArray(lines) ? lines.join('\n') : lines;
};

export const buildOwnerHelp = (prefix, command, translator) => {
  const translate = ensureTranslator(translator);
  const lines = translate('discord.owner.help', { prefix, command });
  return Array.isArray(lines) ? lines.join('\n') : lines;
};

/**
 * Summarises the Discord bot commands and provides usage examples. Update this
 * helper whenever a new command is introduced so `help` stays current.
 */
export const buildDiscordHelp = ({
  prefix,
  verifyCommand,
  setupCommand,
  settingsCommand,
  statsCommand,
  ownerCommand,
  helpCommand,
  translator
}) => {
  const translate = ensureTranslator(translator);
  const lines = translate('discord.help.lines', {
    prefix,
    verifyCommand,
    setupCommand,
    settingsCommand,
    statsCommand,
    ownerCommand,
    helpCommand
  });
  return Array.isArray(lines) ? lines.join('\n') : lines;
};

export const normaliseBooleanFlag = (value, translator) => {
  const normalised = String(value || '').trim().toLowerCase();
  if (['on', 'enable', 'enabled', 'true', 'yes'].includes(normalised)) {
    return true;
  }
  if (['off', 'disable', 'disabled', 'false', 'no'].includes(normalised)) {
    return false;
  }
  const translate = ensureTranslator(translator);
  throw new Error(translate('common.errors.booleanFlag'));
};

export const handleSettingsCommand = async (message, args, context) => {
  const {
    discordConfig,
    volumeVerifier,
    commandPrefix,
    settingsCommandName,
    configUpdater,
    translator
  } = context;
  const translate = ensureTranslator(translator);

  if (!isDiscordAdmin(message, discordConfig)) {
    await message.reply(translate('discord.settings.unauthorised'));
    logger.warn('Discord user attempted to access settings without permission.', {
      userId: message.author?.id,
      guildId: message.guild?.id
    });
    return;
  }

  if (args.length === 0) {
    await message.reply(buildSettingsHelp(commandPrefix, settingsCommandName, translator));
    return;
  }

  const subcommand = args.shift().toLowerCase();

  try {
    let updatedConfig;
    switch (subcommand) {
      case 'volume': {
        const enabled = normaliseBooleanFlag(args[0], translator);
        updatedConfig = await configUpdater.setVolumeCheckEnabled(enabled);
        await message.reply(translate(`discord.settings.volumeToggle.${enabled ? 'enabled' : 'disabled'}`));
        break;
      }
      case 'min-volume': {
        const amount = args[0];
        updatedConfig = await configUpdater.setMinimumVolume(amount);
        await message.reply(translate('discord.settings.minimumVolumeUpdated', {
          amount: updatedConfig.verification.minimumVolume
        }));
        break;
      }
      case 'deposit': {
        const value = args[0];
        const amount = ['clear', 'none', 'off'].includes(String(value).toLowerCase()) ? null : value;
        updatedConfig = await configUpdater.setDepositThreshold(amount);
        const { depositThreshold } = updatedConfig.verification;
        await message.reply(depositThreshold === null
          ? translate('discord.settings.depositCleared')
          : translate('discord.settings.depositUpdated', { amount: depositThreshold }));
        break;
      }
      case 'volume-days': {
        const days = args[0];
        updatedConfig = await configUpdater.setVolumeCheckDays(days);
        await message.reply(translate('discord.settings.volumeDaysUpdated', {
          days: updatedConfig.verification.volumeCheckDays
        }));
        break;
      }
      case 'volume-warning': {
        const enabled = normaliseBooleanFlag(args[0], translator);
        updatedConfig = await configUpdater.setVolumeWarningEnabled(enabled);
        await message.reply(translate(`discord.settings.volumeWarningToggle.${enabled ? 'enabled' : 'disabled'}`));
        break;
      }
      case 'warning-days': {
        const days = args[0];
        updatedConfig = await configUpdater.setVolumeWarningDays(days);
        await message.reply(translate('discord.settings.warningDaysUpdated', {
          days: updatedConfig.verification.volumeWarningDays
        }));
        break;
      }
      case 'api': {
        const action = (args.shift() || '').toLowerCase();
        if (action === 'add' || action === 'update') {
          const [name, type, apiKey, apiSecret, passphrase] = args;
          if (!name || !type || !apiKey || !apiSecret) {
            throw new Error(translate('discord.settings.api.usageAddUpdate'));
          }
          updatedConfig = await configUpdater.upsertExchangeCredentials({
            name,
            type,
            apiKey,
            apiSecret,
            passphrase
          });
          await message.reply(translate(`discord.settings.api.credentials.${action === 'add' ? 'created' : 'updated'}`, { name }));
        } else if (action === 'remove' || action === 'delete') {
          const name = args[0];
          if (!name) {
            throw new Error(translate('discord.settings.api.usageRemove'));
          }
          updatedConfig = await configUpdater.removeExchange(name);
          await message.reply(translate('discord.settings.api.exchangeRemoved', { name }));
        } else if (action === 'list') {
          const exchanges = await configUpdater.listExchanges();
          if (!exchanges.length) {
            await message.reply(translate('discord.settings.api.listEmpty'));
          } else {
            const lines = exchanges.map((exchange) => translate('discord.settings.api.listItem', {
              name: exchange.name,
              type: exchange.type || translate('discord.settings.api.typeUnknown')
            }));
            await message.reply([translate('discord.settings.api.listHeader'), ...lines].join('\n'));
          }
          return;
        } else {
          throw new Error(translate('discord.settings.api.unknownAction'));
        }
        break;
      }
      case 'affiliate': {
        const name = args.shift();
        if (!name || !args.length) {
          throw new Error(translate('discord.settings.affiliate.usage'));
        }

        const rawLink = args.join(' ').trim();
        const shouldClear = ['clear', 'none', 'off'].includes(rawLink.toLowerCase());
        const linkValue = shouldClear ? null : rawLink;
        updatedConfig = await configUpdater.setExchangeAffiliateLink(name, linkValue);
        await message.reply(linkValue
          ? translate('discord.settings.affiliate.updated', { name })
          : translate('discord.settings.affiliate.cleared', { name }));
        break;
      }
      case 'show': {
        const config = await loadRuntimeConfig();
        const { verification } = config;
        const summary = translate('discord.settings.show.lines', {
          volumeCheck: translate(`common.states.${verification.volumeCheckEnabled ? 'enabled' : 'disabled'}`),
          minimumVolume: verification.minimumVolume,
          depositThreshold: verification.depositThreshold ?? translate('common.labels.notSet'),
          volumeDays: verification.volumeCheckDays,
          warningStatus: translate(`common.states.${verification.volumeWarningEnabled !== false ? 'enabled' : 'disabled'}`),
          warningDays: verification.volumeWarningDays
        });
        await message.reply(Array.isArray(summary) ? summary.join('\n') : summary);
        return;
      }
      default:
        await message.reply(buildSettingsHelp(commandPrefix, settingsCommandName, translator));
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
    await message.reply(translate('discord.settings.error', { message: error.message }));
  }
};


export const handleVerifyCommand = async (message, args, context) => {
  const { commandPrefix, commandName, volumeVerifier, translator } = context;
  const translate = ensureTranslator(translator);
  const [uid, exchangeId, minVolume] = args;

  if (!uid) {
    await message.reply(translate('discord.verify.usage', { prefix: commandPrefix, command: commandName }));
    return;
  }

  let minimumVolumeOverride;
  if (typeof minVolume !== 'undefined') {
    const parsedMinimumVolume = Number(minVolume);
    if (!Number.isFinite(parsedMinimumVolume)) {
      await message.reply(translate('discord.verify.minimumVolumeInvalid', {
        prefix: commandPrefix,
        command: commandName
      }));
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
    const exchangeLabel = exchangeMeta?.description
      || exchangeMeta?.name
      || result.exchangeName
      || result.exchangeId
      || exchangeId
      || translate('common.labels.unknownExchange');

    if (!result.passed) {
      const failureMessage = buildFailureResponse({
        result,
        uid,
        exchangeLabel,
        affiliateLink,
        translator
      });
      await message.reply(failureMessage);
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
        await message.reply(translate('discord.verify.alreadyVerified'));
        return;
      }
      throw error;
    }

    await message.reply(formatVerificationMessage(result, translator));
  } catch (error) {
    if (error instanceof VerifiedUserConflictError) {
      return;
    }
    logger.error(`Discord verification failed: ${error.message}`);
    await message.reply(translate('discord.verify.error', {
      uid,
      message: error.message
    }));
  }
};

export const handleStatsCommand = async (message, args, context) => {
  const {
    discordConfig,
    commandPrefix,
    statsCommandName,
    translator,
    volumeVerifier,
    statsService = statisticsService
  } = context;

  const translate = ensureTranslator(translator);

  if (!isDiscordAdmin(message, discordConfig)) {
    await message.reply(translate('discord.stats.unauthorised'));
    logger.warn('Discord user attempted to access stats without permission.', {
      userId: message.author?.id,
      guildId: message.guild?.id
    });
    return;
  }

  if (args.length && ['help', '?'].includes(args[0].toLowerCase())) {
    await message.reply(translate('discord.stats.usage', {
      prefix: commandPrefix,
      command: statsCommandName
    }));
    return;
  }

  let exchangeFilter = null;
  let scopeLabel = translate('discord.stats.scopeAll');

  if (args.length) {
    const candidate = args[0].toLowerCase();
    if (candidate !== 'all') {
      const exchangeConfig = volumeVerifier.getExchangeConfig ? volumeVerifier.getExchangeConfig(candidate) : null;
      if (!exchangeConfig) {
        await message.reply(translate('discord.stats.unknownExchange', { exchange: args[0] }));
        return;
      }
      exchangeFilter = candidate;
      scopeLabel = exchangeConfig.description || exchangeConfig.name || candidate;
    }
  }

  try {
    const stats = await statsService.getTradingVolumeStats({ exchangeId: exchangeFilter });

    if (!stats.exchanges.length) {
      await message.reply(translate('discord.stats.noData', { scope: scopeLabel }));
      return;
    }

    const lines = [translate('discord.stats.header', { scope: scopeLabel })];

    stats.exchanges.forEach((entry) => {
      const exchangeConfig = volumeVerifier.getExchangeConfig ? volumeVerifier.getExchangeConfig(entry.exchange) : null;
      const name = exchangeConfig?.description || exchangeConfig?.name || entry.exchange;
      const lastUpdated = entry.lastSnapshotIso
        ? translate('discord.stats.lastUpdated', { timestamp: entry.lastSnapshotIso })
        : translate('discord.stats.lastUpdatedUnknown');
      const exchangeVolumeDisplay = entry.exchangeTotalAvailable
        ? entry.exchangeTotalVolumeFormatted
        : translate('discord.stats.exchangeTotalUnavailable');
      const inviteeDisplay = entry.exchangeTotalAvailable
        ? (Number.isFinite(entry.exchangeInviteeCount)
          ? entry.exchangeInviteeCount
          : translate('discord.stats.exchangeInviteesUnknown'))
        : translate('discord.stats.exchangeTotalUnavailable');
      const exchangeRefreshed = entry.exchangeTotalAvailable
        ? (entry.exchangeTotalsFetchedAtIso
          ? translate('discord.stats.exchangeRefreshed', { timestamp: entry.exchangeTotalsFetchedAtIso })
          : translate('discord.stats.exchangeRefreshedUnknown'))
        : translate('discord.stats.exchangeTotalUnavailable');

      lines.push(translate('discord.stats.exchangeLine', {
        name,
        verifiedVolume: entry.totalVolumeFormatted,
        accounts: entry.accountCount,
        lastUpdated,
        exchangeVolume: exchangeVolumeDisplay,
        invitees: inviteeDisplay,
        exchangeRefreshed
      }));
    });

    if (stats.exchanges.length > 1) {
      lines.push('', translate('discord.stats.overallLine', {
        volume: stats.grandTotalVolumeFormatted,
        accounts: stats.grandTotalAccounts
      }));

      if (stats.exchangeTotalsAvailableCount > 0 && stats.grandExchangeVolumeFormatted) {
        const aggregateInvitees = Number.isFinite(stats.grandExchangeInvitees)
          ? stats.grandExchangeInvitees
          : translate('discord.stats.exchangeInviteesUnknown');
        lines.push(translate('discord.stats.overallExchangeLine', {
          volume: stats.grandExchangeVolumeFormatted,
          invitees: aggregateInvitees,
          exchanges: stats.exchangeTotalsAvailableCount
        }));
      }
    }

    await message.reply(lines.join('\n'));
  } catch (error) {
    logger.error(`Discord stats command failed: ${error.message}`);
    await message.reply(translate('discord.stats.error', { message: error.message }));
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

  const translator = dependencies.translator;
  const translate = ensureTranslator(translator);

  const commandName = discordConfig.commandName || 'verify';
  const commandPrefix = discordConfig.commandPrefix || '!';
  const settingsCommandName = discordConfig.settingsCommandName || 'settings';
  const statsCommandName = discordConfig.statsCommandName || 'stats';
  const ownerCommandName = discordConfig.ownerCommandName || 'owner';
  const helpCommandName = discordConfig.helpCommandName || 'help';
  const setupCommandName = discordConfig.setupCommandName || 'setup';
  const configUpdater = dependencies.configUpdater || configUpdateService;
  const setupWizard = createDiscordSetupWizard({
    client,
    configUpdater,
    volumeVerifier,
    discordConfig,
    translator
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
      await handleVerifyCommand(message, args, {
        commandPrefix,
        commandName,
        volumeVerifier,
        translator
      });
      return;
    }

    if (receivedCommand === settingsCommandName) {
      await handleSettingsCommand(message, args, {
        discordConfig,
        volumeVerifier,
        commandPrefix,
        settingsCommandName,
        configUpdater,
        translator
      });
      return;
    }

    if (receivedCommand === statsCommandName) {
      await handleStatsCommand(message, args, {
        discordConfig,
        commandPrefix,
        statsCommandName,
        translator,
        volumeVerifier,
        statsService: dependencies.statsService || statisticsService
      });
      return;
    }

    if (receivedCommand === ownerCommandName) {
      await handleOwnerCommand(message, args, {
        discordConfig,
        commandPrefix,
        ownerCommandName,
        configUpdater,
        translator
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
        statsCommand: statsCommandName,
        ownerCommand: ownerCommandName,
        helpCommand: helpCommandName,
        translator
      }));
    }
  });

  client.on('interactionCreate', async (interaction) => {
    const translateInteraction = translate;
    if (await setupWizard.handleInteraction(interaction)) {
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith(`${VERIFICATION_BUTTON_PREFIX}:`)) {
      const parts = interaction.customId.split(':');
      const guildId = parts[1];
      const exchangeId = parts[2];

      if (!exchangeId || parts[1] === 'disabled') {
        await interaction.reply({
          content: translateInteraction('discord.modal.unavailableNoExchanges'),
          ephemeral: true
        });
        return;
      }

      const exchangeMeta = volumeVerifier.getExchangeConfig ? volumeVerifier.getExchangeConfig(exchangeId) : null;
      if (!exchangeMeta) {
        await interaction.reply({
          content: translateInteraction('discord.modal.exchangeNotConfigured'),
          ephemeral: true
        });
        return;
      }

      const exchangeLabel = exchangeMeta.description || exchangeMeta.name || exchangeId;
      const modal = new ModalBuilder()
        .setCustomId(`${VERIFICATION_MODAL_PREFIX}:${guildId}:${exchangeId}`)
        .setTitle(translateInteraction('discord.modal.title', { exchange: exchangeLabel }))
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('uid')
              .setLabel(translateInteraction('discord.modal.uidLabel'))
              .setStyle(TextInputStyle.Short)
              .setPlaceholder(translateInteraction('discord.modal.uidPlaceholder'))
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
        const exchangeLabel = exchangeMeta?.description
          || exchangeMeta?.name
          || result.exchangeName
          || exchangeId;

        if (!result.passed) {
          const failureMessage = buildFailureResponse({
            result,
            uid,
            exchangeLabel,
            affiliateLink,
            translator
          });
          // Attempt DM delivery first so we can fall back to the modal reply when Discord blocks DMs.
          const delivery = await sendDirectMessage(interaction.user, failureMessage);

          if (delivery.delivered) {
            await interaction.editReply(translateInteraction('discord.modal.dmFailureDelivered'));
          } else {
            const fallbackLines = [
              failureMessage,
              '',
              translateInteraction('discord.modal.dmFailureFallback', {
                error: delivery.error ? `: ${delivery.error}` : ''
              })
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
            const conflictMessage = translateInteraction('discord.verify.conflict');
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
          volumeWarningEnabled,
          translator
        });

        // Deliver the detailed result privately when possible; otherwise, surface it in the modal reply.
        const delivery = await sendDirectMessage(interaction.user, successMessage);

        if (delivery.delivered) {
          if (roleAssigned) {
            await interaction.editReply(translateInteraction('discord.modal.successWithRole'));
          } else {
            await interaction.editReply(translateInteraction('discord.modal.successNoRole'));
          }
        } else {
          const fallbackLines = [
            successMessage,
            '',
            translateInteraction('discord.modal.successFallback', {
              error: delivery.error ? `: ${delivery.error}` : ''
            })
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
        await interaction.editReply(translateInteraction('discord.verify.error', {
          uid,
          message: error.message
        }));
      }
    }
  });

  client.login(discordConfig.token).catch((error) => {
    logger.error(`Discord login failed: ${error.message}`);
  });

  return client;
};

export default createDiscordBot;
export const handleOwnerCommand = async (message, args, context) => {
  const {
    discordConfig,
    commandPrefix,
    ownerCommandName,
    configUpdater,
    translator
  } = context;
  const translate = ensureTranslator(translator);

  if (args.length === 0) {
    await message.reply(buildOwnerHelp(commandPrefix, ownerCommandName, translator));
    return;
  }

  const subcommand = args.shift().toLowerCase();

  try {
    if (subcommand === 'register') {
      const passkey = args[0];
      if (!passkey) {
        await message.reply(translate('discord.owner.usage.register', {
          prefix: commandPrefix,
          command: ownerCommandName
        }));
        return;
      }

      await configUpdater.registerOwner({ platform: 'discord', userId: message.author.id, passkey });
      discordConfig.ownerId = String(message.author.id);
      logger.info('Discord owner registered successfully.', { userId: message.author.id });
      await message.reply(translate('discord.owner.registered'));
      return;
    }

    await configUpdater.requireOwner('discord', message.author.id);

    switch (subcommand) {
      case 'add-admin': {
        const adminId = args[0];
        if (!adminId) {
          await message.reply(translate('discord.owner.usage.addAdmin', {
            prefix: commandPrefix,
            command: ownerCommandName
          }));
          return;
        }
        const result = await configUpdater.addDiscordAdminUser(adminId);
        if (result.config?.discord) {
          discordConfig.adminUserIds = result.config.discord.adminUserIds;
          discordConfig.adminRoleIds = result.config.discord.adminRoleIds;
        } else {
          discordConfig.adminUserIds = result.userIds;
        }
        const summary = discordConfig.adminUserIds?.length
          ? discordConfig.adminUserIds.join(', ')
          : translate('common.labels.none');
        await message.reply(translate('discord.owner.adminAdded', { adminId, summary }));
        return;
      }
      case 'remove-admin': {
        const adminId = args[0];
        if (!adminId) {
          await message.reply(translate('discord.owner.usage.removeAdmin', {
            prefix: commandPrefix,
            command: ownerCommandName
          }));
          return;
        }
        const result = await configUpdater.removeDiscordAdminUser(adminId);
        if (result.config?.discord) {
          discordConfig.adminUserIds = result.config.discord.adminUserIds;
          discordConfig.adminRoleIds = result.config.discord.adminRoleIds;
        } else {
          discordConfig.adminUserIds = result.userIds;
        }
        const summary = discordConfig.adminUserIds?.length
          ? discordConfig.adminUserIds.join(', ')
          : translate('common.labels.none');
        await message.reply(translate('discord.owner.adminRemoved', { adminId, summary }));
        return;
      }
      case 'add-role': {
        const roleId = args[0];
        if (!roleId) {
          await message.reply(translate('discord.owner.usage.addRole', {
            prefix: commandPrefix,
            command: ownerCommandName
          }));
          return;
        }
        const result = await configUpdater.addDiscordAdminRole(roleId);
        if (result.config?.discord) {
          discordConfig.adminRoleIds = result.config.discord.adminRoleIds;
        } else {
          discordConfig.adminRoleIds = result.roleIds;
        }
        const summary = discordConfig.adminRoleIds?.length
          ? discordConfig.adminRoleIds.join(', ')
          : translate('common.labels.none');
        await message.reply(translate('discord.owner.roleAdded', { roleId, summary }));
        return;
      }
      case 'remove-role': {
        const roleId = args[0];
        if (!roleId) {
          await message.reply(translate('discord.owner.usage.removeRole', {
            prefix: commandPrefix,
            command: ownerCommandName
          }));
          return;
        }
        const result = await configUpdater.removeDiscordAdminRole(roleId);
        if (result.config?.discord) {
          discordConfig.adminRoleIds = result.config.discord.adminRoleIds;
        } else {
          discordConfig.adminRoleIds = result.roleIds;
        }
        const summary = discordConfig.adminRoleIds?.length
          ? discordConfig.adminRoleIds.join(', ')
          : translate('common.labels.none');
        await message.reply(translate('discord.owner.roleRemoved', { roleId, summary }));
        return;
      }
      case 'list-admins': {
        const { userIds, roleIds } = await configUpdater.listDiscordAdmins();
        const lines = translate('discord.owner.list.lines', {
          userSummary: userIds.length ? userIds.join(', ') : translate('common.labels.none'),
          roleSummary: roleIds.length ? roleIds.join(', ') : translate('common.labels.none')
        });
        await message.reply(Array.isArray(lines) ? lines.join('\n') : lines);
        return;
      }
      case 'transfer-owner': {
        const targetId = args[0];
        if (!targetId) {
          await message.reply(translate('discord.owner.usage.transferOwner', {
            prefix: commandPrefix,
            command: ownerCommandName
          }));
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
        const lines = translate('discord.owner.transfer.lines', {
          targetId,
          passkey
        });
        await message.reply(Array.isArray(lines) ? lines.join('\n') : lines);
        logger.info('Discord ownership transfer completed.', {
          previousOwner: message.author.id,
          newOwner: targetId,
          passkeyPreview: masked
        });
        return;
      }
      default:
        await message.reply(buildOwnerHelp(commandPrefix, ownerCommandName, translator));
    }
  } catch (error) {
    logger.error(`Discord owner command failed: ${error.message}`);
    await message.reply(translate('discord.owner.error', { message: error.message }));
  }
};
