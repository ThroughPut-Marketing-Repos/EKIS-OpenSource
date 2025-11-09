import crypto from 'crypto';
import TelegramBot from 'node-telegram-bot-api';
import logger from '../utils/logger.js';
import configUpdateService from '../services/configUpdateService.js';
import { getConfig as loadRuntimeConfig } from '../config/configManager.js';
import { saveVerifiedUser, VerifiedUserConflictError } from '../services/verificationService.js';
import statisticsService from '../services/statisticsService.js';
import { normaliseStartMessages, START_MESSAGE_DELIMITER } from '../utils/startMessage.js';

const STEPS = {
  AWAITING_EXCHANGE: 'awaiting_exchange',
  AWAITING_UID: 'awaiting_uid'
};

const GROUP_SETUP_CODE_TTL_MS = 15 * 60 * 1000;

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

const ensureTranslator = (translator) => {
  if (!translator || typeof translator.t !== 'function') {
    throw new Error('A translator instance exposing t(key, vars) is required for Telegram localisation.');
  }
  return (key, vars) => translator.t(key, vars);
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

  // if (typeof result.volume === 'number' && !Number.isNaN(result.volume)) {
  //   lines.push(translate('common.verification.recordedVolume', { volume: result.volume }));
  //   if (result.volumeMet === false) {
  //     lines.push(translate('common.verification.volumeTargetNotMet', { minimum: result.minimumVolume }));
  //   } else if (result.volumeMet === true) {
  //     lines.push(translate('common.verification.volumeTargetMet', { minimum: result.minimumVolume }));
  //   } else if (result.skipped) {
  //     lines.push(translate('common.verification.volumeTargetSkipped', { minimum: result.minimumVolume }));
  //   }
  // } else if (result.skipped) {
  //   lines.push(translate('common.verification.volumeTrackingDisabled'));
  // }

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

  // lines.push(translate('common.verification.checkedAt', { timestamp: result.timestamp }));
  return lines.join('\n');
};

// Treat the registered owner as an implicit admin so they can always reach privileged commands.
export const isTelegramAdmin = (telegramConfig, msg) => {
  const callerId = msg?.from?.id;
  if (typeof callerId === 'undefined' || callerId === null) {
    return false;
  }

  const callerIdentifier = String(callerId);
  const ownerId = telegramConfig?.ownerId ? String(telegramConfig.ownerId) : null;
  if (ownerId && ownerId === callerIdentifier) {
    return true;
  }

  const adminIds = (telegramConfig.admins || []).map((id) => String(id));
  return adminIds.includes(callerIdentifier);
};

export const buildSettingsHelp = (translator) => {
  const translate = ensureTranslator(translator);
  const lines = translate('telegram.settings.help');
  return Array.isArray(lines) ? lines.join('\n') : lines;
};

export const buildOwnerHelp = (translator) => {
  const translate = ensureTranslator(translator);
  const lines = translate('telegram.owner.help');
  return Array.isArray(lines) ? lines.join('\n') : lines;
};

/**
 * Provides a consolidated overview of the Telegram bot commands. Keep this
 * list synchronised with new commands to ensure `/help` remains accurate.
 */
export const buildHelpMessage = (translator) => {
  const translate = ensureTranslator(translator);
  const lines = translate('telegram.help.commands');
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

export const parseArgs = (text) => {
  if (!text) {
    return [];
  }
  return text.trim().split(/\s+/);
};

// Normalises configuration so a single string or an array of identifiers can be
// treated uniformly when generating invite links. Legacy deployments stored the
// value as JSON text inside `telegram.groupId`, so we attempt to parse and
// sanitise those representations before falling back to comma-separated values.
export const normaliseGroupIds = (telegramConfig) => {
  const groups = new Set();

  const addGroupId = (value) => {
    if (typeof value === 'undefined' || value === null) {
      return;
    }
    const trimmed = String(value).trim();
    if (trimmed) {
      groups.add(trimmed);
    }
  };

  if (Array.isArray(telegramConfig?.groupIds)) {
    telegramConfig.groupIds.forEach(addGroupId);
  }

  const rawGroupId = telegramConfig?.groupId;
  if (typeof rawGroupId !== 'undefined' && rawGroupId !== null) {
    const text = String(rawGroupId).trim();
    if (text) {
      let parsed = false;

      if (text.startsWith('[') || text.startsWith('{')) {
        try {
          const candidate = JSON.parse(text);
          if (Array.isArray(candidate)) {
            candidate.forEach(addGroupId);
            parsed = true;
          } else {
            addGroupId(candidate);
            parsed = true;
          }
        } catch (error) {
          logger.warn('Unable to parse legacy Telegram group ID value as JSON.', {
            rawGroupId: text,
            error: error.message
          });
        }
      }

      if (!parsed) {
        text
          .split(',')
          .map((groupId) => groupId.replace(/^[\[]+|[\]]+$/g, '').trim())
          .map((groupId) => groupId.replace(/^['"]+|['"]+$/g, '').trim())
          .forEach(addGroupId);
      }
    }
  }

  return Array.from(groups);
};

const buildExchangeKeyboard = (exchanges) => {
  const inlineKeyboard = [];
  for (let index = 0; index < exchanges.length; index += 2) {
    const first = exchanges[index];
    const second = exchanges[index + 1];
    const firstLabel = first.description || first.name || first.id;
    const row = [{ text: firstLabel, callback_data: `exchange:${first.id}` }];
    if (second) {
      const secondLabel = second.description || second.name || second.id;
      row.push({ text: secondLabel, callback_data: `exchange:${second.id}` });
    }
    inlineKeyboard.push(row);
  }
  return inlineKeyboard;
};

// Build human-friendly labels for invite buttons. Usernames prefixed with @ are
// shown directly so recipients can recognise the destination, whereas numeric
// identifiers fall back to a generic label that still differentiates multiple
// groups when more than one invite is available.
const buildInviteButtonLabel = (groupId, index, total) => {
  if (groupId && groupId.startsWith('@')) {
    return `Join ${groupId}`;
  }

  if (total === 1) {
    return 'Join Telegram space';
  }

  return `Join space ${index + 1}`;
};

// Inline keyboard payload that pairs generated invite links with descriptive
// button captions, ensuring users receive tappable buttons instead of raw URLs.
const buildInviteKeyboard = (invites) => invites.map((invite, index, all) => [{
  text: buildInviteButtonLabel(invite.groupId, index, all.length),
  url: invite.link
}]);

const START_MESSAGE_PLACEHOLDER_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

const renderStartMessageTemplate = (template, context) => template.replace(
  START_MESSAGE_PLACEHOLDER_PATTERN,
  (match, key) => (Object.prototype.hasOwnProperty.call(context, key) ? context[key] ?? '' : match)
);

const hasCustomStartMessage = (telegramConfig) => {
  if (!telegramConfig) {
    return false;
  }

  if (Array.isArray(telegramConfig.startMessage)) {
    return telegramConfig.startMessage.length > 0;
  }

  return typeof telegramConfig.startMessage === 'string' && telegramConfig.startMessage.trim().length > 0;
};

const buildVerificationPrompt = ({ telegramConfig, translator, exchangeConfig }) => {
  const translate = ensureTranslator(translator);
  const exchangeLabel = exchangeConfig.description || exchangeConfig.name || exchangeConfig.id;
  const depositThreshold = typeof exchangeConfig.depositThreshold === 'number'
    && !Number.isNaN(exchangeConfig.depositThreshold)
    ? exchangeConfig.depositThreshold
    : null;
  const affiliateLink = exchangeConfig.affiliateLink || null;

  const buildDefaultPrompt = () => {
    const messageLines = [
      translate('telegram.verification.singleExchangeWelcome', { exchange: exchangeLabel }),
      translate('telegram.verification.singleExchangeSummary', { exchange: exchangeLabel }),
      translate('telegram.verification.sendUidInstruction')
    ];

    if (depositThreshold !== null) {
      messageLines.splice(2, 0, translate('telegram.verification.minimumDeposit', { amount: depositThreshold }));
    }

    if (affiliateLink) {
      messageLines.push('', translate('telegram.verification.affiliateLinkLabel', { link: affiliateLink }));
    }

    return [messageLines.join('\n')];
  };

  if (hasCustomStartMessage(telegramConfig)) {
    const context = {
      exchange: exchangeLabel,
      deposit: depositThreshold !== null ? String(depositThreshold) : '',
      minimumDepositLine: depositThreshold !== null
        ? translate('telegram.verification.minimumDeposit', { amount: depositThreshold })
        : '',
      affiliateLink: affiliateLink || '',
      affiliateLinkLine: affiliateLink
        ? translate('telegram.verification.affiliateLinkLabel', { link: affiliateLink })
        : ''
    };

    const templates = Array.isArray(telegramConfig.startMessage)
      ? telegramConfig.startMessage
      : [telegramConfig.startMessage];
    const renderedMessages = templates
      .map((template) => renderStartMessageTemplate(template, context).trim())
      .filter((message) => message.length > 0);

    if (affiliateLink) {
      const includesAffiliateLink = renderedMessages.some((message) => message.includes(affiliateLink));
      if (!includesAffiliateLink && context.affiliateLinkLine) {
        renderedMessages.push(context.affiliateLinkLine);
      }
    }

    if (renderedMessages.length > 0) {
      return renderedMessages;
    }
  }

  return buildDefaultPrompt();
};

// Deliver multi-part prompts as individual Telegram messages so administrators can
// craft onboarding sequences without resorting to complex Markdown layouts.
const sendPromptMessages = async (bot, chatId, messages, baseOptions = {}) => {
  const queue = (messages || []).filter((message) => typeof message === 'string' && message.trim().length > 0);
  for (let index = 0; index < queue.length; index += 1) {
    const message = queue[index];
    const isLast = index === queue.length - 1;
    const options = isLast ? baseOptions : { ...baseOptions, reply_markup: undefined };
    const cleanedOptions = Object.entries(options || {}).reduce((accumulator, [key, value]) => {
      if (typeof value !== 'undefined') {
        accumulator[key] = value;
      }
      return accumulator;
    }, {});
    await bot.sendMessage(chatId, message, Object.keys(cleanedOptions).length ? cleanedOptions : undefined);
  }
};

export const createTelegramSettingsHandler = ({ bot, telegramConfig, volumeVerifier, configUpdater, translator }) => async (msg, argsText) => {
  const translate = ensureTranslator(translator);
  const chatId = msg.chat.id;

  if (!isTelegramAdmin(telegramConfig, msg)) {
    await bot.sendMessage(chatId, translate('telegram.settings.unauthorised'));
    logger.warn('Telegram user attempted to access settings without permission.', {
      telegramUserId: msg.from?.id,
      chatId
    });
    return;
  }

  const args = parseArgs(argsText);
  if (!args.length) {
    await bot.sendMessage(chatId, buildSettingsHelp(translator));
    return;
  }

  const subcommand = args.shift().toLowerCase();

  try {
    let updatedConfig;
    switch (subcommand) {
      case 'volume': {
        const enabled = normaliseBooleanFlag(args[0], translator);
        updatedConfig = await configUpdater.setVolumeCheckEnabled(enabled);
        await bot.sendMessage(chatId, translate(`telegram.settings.volume${enabled ? 'Enabled' : 'Disabled'}`));
        break;
      }
      case 'min_volume': {
        const amount = args[0];
        updatedConfig = await configUpdater.setMinimumVolume(amount);
        await bot.sendMessage(chatId, translate('telegram.settings.minimumVolumeUpdated', {
          amount: updatedConfig.verification.minimumVolume
        }));
        break;
      }
      case 'deposit': {
        const value = args[0];
        const amount = ['clear', 'none', 'off'].includes(String(value).toLowerCase()) ? null : value;
        updatedConfig = await configUpdater.setDepositThreshold(amount);
        const { depositThreshold } = updatedConfig.verification;
        await bot.sendMessage(chatId, depositThreshold === null
          ? translate('telegram.settings.depositCleared')
          : translate('telegram.settings.depositUpdated', { amount: depositThreshold }));
        break;
      }
      case 'volume_days': {
        const days = args[0];
        updatedConfig = await configUpdater.setVolumeCheckDays(days);
        await bot.sendMessage(chatId, translate('telegram.settings.volumeDaysUpdated', {
          days: updatedConfig.verification.volumeCheckDays
        }));
        break;
      }
      case 'volume_warning': {
        const enabled = normaliseBooleanFlag(args[0], translator);
        updatedConfig = await configUpdater.setVolumeWarningEnabled(enabled);
        await bot.sendMessage(chatId, translate(`telegram.settings.volumeWarning${enabled ? 'Enabled' : 'Disabled'}`));
        break;
      }
      case 'warning_days': {
        const days = args[0];
        updatedConfig = await configUpdater.setVolumeWarningDays(days);
        await bot.sendMessage(chatId, translate('telegram.settings.warningDaysUpdated', {
          days: updatedConfig.verification.volumeWarningDays
        }));
        break;
      }
      case 'start_message': {
        const rawMessage = (argsText || '').replace(/^\s*start_message\s*/i, '');
        const trimmedInput = rawMessage.trim();
        const usageMessage = translate('telegram.settings.startMessageUsage', {
          delimiter: START_MESSAGE_DELIMITER
        });

        if (!trimmedInput) {
          throw new Error(usageMessage);
        }

        const shouldClear = ['clear', 'none', 'default', 'reset'].includes(trimmedInput.toLowerCase());
        const normalisedMessages = shouldClear
          ? []
          : normaliseStartMessages(rawMessage.replace(/\\n/g, '\n'));

        if (!shouldClear && normalisedMessages.length === 0) {
          throw new Error(usageMessage);
        }

        updatedConfig = await configUpdater.setTelegramStartMessage(normalisedMessages);
        telegramConfig.startMessage = updatedConfig.telegram?.startMessage || [];
        await bot.sendMessage(chatId, normalisedMessages.length
          ? translate('telegram.settings.startMessageUpdated', { count: normalisedMessages.length })
          : translate('telegram.settings.startMessageCleared'));
        break;
      }
      case 'api': {
        const action = (args.shift() || '').toLowerCase();
        if (action === 'add' || action === 'update') {
          const [name, type, apiKey, apiSecret, passphrase] = args;
          if (!name || !type || !apiKey || !apiSecret) {
            throw new Error(translate('telegram.settings.api.usageAddUpdate'));
          }
          updatedConfig = await configUpdater.upsertExchangeCredentials({
            name,
            type,
            apiKey,
            apiSecret,
            passphrase
          });
          await bot.sendMessage(chatId, translate(`telegram.settings.api.credentials${action === 'add' ? 'Created' : 'Updated'}`, { name }));
        } else if (action === 'remove' || action === 'delete') {
          const name = args[0];
          if (!name) {
            throw new Error(translate('telegram.settings.api.usageRemove'));
          }
          updatedConfig = await configUpdater.removeExchange(name);
          await bot.sendMessage(chatId, translate('telegram.settings.api.exchangeRemoved', { name }));
        } else if (action === 'list') {
          const exchanges = await configUpdater.listExchanges();
          if (!exchanges.length) {
            await bot.sendMessage(chatId, translate('telegram.settings.api.listEmpty'));
          } else {
            const lines = exchanges.map((exchange) => translate('telegram.settings.api.listItem', {
              name: exchange.name,
              type: exchange.type || translate('telegram.settings.api.typeUnknown')
            }));
            await bot.sendMessage(chatId, [translate('telegram.settings.api.listHeader'), ...lines].join('\n'));
          }
          return;
        } else {
          throw new Error(translate('telegram.settings.api.unknownAction'));
        }
        break;
      }
      case 'affiliate': {
        const name = args.shift();
        if (!name || !args.length) {
          throw new Error(translate('telegram.settings.affiliate.usage'));
        }

        const rawLink = args.join(' ').trim();
        const shouldClear = ['clear', 'none', 'off'].includes(rawLink.toLowerCase());
        const linkValue = shouldClear ? null : rawLink;
        updatedConfig = await configUpdater.setExchangeAffiliateLink(name, linkValue);
        await bot.sendMessage(chatId, linkValue
          ? translate('telegram.settings.affiliate.updated', { name })
          : translate('telegram.settings.affiliate.cleared', { name }));
        break;
      }
      case 'show': {
        const config = await loadRuntimeConfig();
        const { verification } = config;
        const summary = translate('telegram.settings.show', {
          volumeCheck: translate(`common.states.${verification.volumeCheckEnabled ? 'enabled' : 'disabled'}`),
          minimumVolume: verification.minimumVolume,
          depositThreshold: verification.depositThreshold ?? translate('common.labels.notSet'),
          volumeDays: verification.volumeCheckDays,
          warningStatus: translate(`common.states.${verification.volumeWarningEnabled !== false ? 'enabled' : 'disabled'}`),
          warningDays: verification.volumeWarningDays
        });
        await bot.sendMessage(chatId, Array.isArray(summary) ? summary.join('\n') : summary);
        return;
      }
      default:
        await bot.sendMessage(chatId, buildSettingsHelp(translator));
        return;
    }

    if (updatedConfig) {
      try {
        volumeVerifier.refresh(updatedConfig);
      } catch (refreshError) {
        logger.error(`Failed to refresh volume verifier after Telegram settings update: ${refreshError.message}`);
      }
    }
  } catch (error) {
    logger.error(`Telegram settings command failed: ${error.message}`);
    await bot.sendMessage(chatId, translate('telegram.settings.error', { message: error.message }));
  }
};

export const createTelegramStatsHandler = ({ bot, telegramConfig, volumeVerifier, translator }) => async (msg, argsText) => {
  const translate = ensureTranslator(translator);
  const chatId = msg.chat.id;

  if (!isTelegramAdmin(telegramConfig, msg)) {
    await bot.sendMessage(chatId, translate('telegram.stats.unauthorised'));
    logger.warn('Telegram user attempted to access /stats without permission.', {
      telegramUserId: msg.from?.id,
      chatId
    });
    return;
  }

  const args = parseArgs(argsText);
  if (args.length && ['help', '?'].includes(args[0].toLowerCase())) {
    await bot.sendMessage(chatId, translate('telegram.stats.usage'));
    return;
  }

  let exchangeFilter = null;
  let scopeLabel = translate('telegram.stats.scopeAll');

  if (args.length) {
    const candidate = args[0].toLowerCase();
    if (candidate !== 'all') {
      const exchangeConfig = volumeVerifier.getExchangeConfig ? volumeVerifier.getExchangeConfig(candidate) : null;
      if (!exchangeConfig) {
        await bot.sendMessage(chatId, translate('telegram.stats.unknownExchange', { exchange: args[0] }));
        return;
      }
      exchangeFilter = candidate;
      scopeLabel = exchangeConfig.description || exchangeConfig.name || candidate;
    }
  }

  try {
    const stats = await statisticsService.getTradingVolumeStats({ exchangeId: exchangeFilter });

    if (!stats.exchanges.length) {
      await bot.sendMessage(chatId, translate('telegram.stats.noData', { scope: scopeLabel }));
      return;
    }

    const responseLines = [translate('telegram.stats.header', { scope: scopeLabel })];

    stats.exchanges.forEach((entry) => {
      const exchangeConfig = volumeVerifier.getExchangeConfig ? volumeVerifier.getExchangeConfig(entry.exchange) : null;
      const name = exchangeConfig?.description || exchangeConfig?.name || entry.exchange;
      const lastUpdated = entry.lastSnapshotIso
        ? translate('telegram.stats.lastUpdated', { timestamp: entry.lastSnapshotIso })
        : translate('telegram.stats.lastUpdatedUnknown');
      const exchangeVolumeDisplay = entry.exchangeTotalAvailable
        ? entry.exchangeTotalVolumeFormatted
        : translate('telegram.stats.exchangeTotalUnavailable');
      const inviteeDisplay = entry.exchangeTotalAvailable
        ? (Number.isFinite(entry.exchangeInviteeCount)
          ? entry.exchangeInviteeCount
          : translate('telegram.stats.exchangeInviteesUnknown'))
        : translate('telegram.stats.exchangeTotalUnavailable');
      const exchangeRefreshed = entry.exchangeTotalAvailable
        ? (entry.exchangeTotalsFetchedAtIso
          ? translate('telegram.stats.exchangeRefreshed', { timestamp: entry.exchangeTotalsFetchedAtIso })
          : translate('telegram.stats.exchangeRefreshedUnknown'))
        : translate('telegram.stats.exchangeTotalUnavailable');

      responseLines.push(translate('telegram.stats.exchangeLine', {
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
      responseLines.push('', translate('telegram.stats.overallLine', {
        volume: stats.grandTotalVolumeFormatted,
        accounts: stats.grandTotalAccounts
      }));

      if (stats.exchangeTotalsAvailableCount > 0 && stats.grandExchangeVolumeFormatted) {
        const aggregateInvitees = Number.isFinite(stats.grandExchangeInvitees)
          ? stats.grandExchangeInvitees
          : translate('telegram.stats.exchangeInviteesUnknown');
        responseLines.push(translate('telegram.stats.overallExchangeLine', {
          volume: stats.grandExchangeVolumeFormatted,
          invitees: aggregateInvitees,
          exchanges: stats.exchangeTotalsAvailableCount
        }));
      }
    }

    await bot.sendMessage(chatId, responseLines.join('\n'));
  } catch (error) {
    logger.error(`Telegram stats command failed: ${error.message}`);
    await bot.sendMessage(chatId, translate('telegram.stats.error', { message: error.message }));
  }
};

export const createTelegramOwnerHandler = ({ bot, telegramConfig, configUpdater, translator }) => async (msg, argsText) => {
  const translate = ensureTranslator(translator);
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!userId) {
    await bot.sendMessage(chatId, translate('telegram.owner.unableToDetermineUserId'));
    return;
  }

  const args = parseArgs(argsText);
  if (!args.length) {
    await bot.sendMessage(chatId, buildOwnerHelp(translator));
    return;
  }

  const subcommand = args.shift().toLowerCase();

  try {
    switch (subcommand) {
      case 'register': {
        const passkey = args[0];
        if (!passkey) {
          await bot.sendMessage(chatId, translate('telegram.owner.usage.register'));
          return;
        }

        await configUpdater.registerOwner({ platform: 'telegram', userId, passkey });
        telegramConfig.ownerId = String(userId);
        logger.info('Telegram owner registered successfully.', { telegramUserId: userId });
        await bot.sendMessage(chatId, translate('telegram.owner.registered'));
        return;
      }
      case 'add-admin': {
        await configUpdater.requireOwner('telegram', userId);
        const adminId = args[0];
        if (!adminId) {
          await bot.sendMessage(chatId, translate('telegram.owner.usage.addAdmin'));
          return;
        }
        const result = await configUpdater.addTelegramAdmin(adminId);
        if (result.config?.telegram) {
          telegramConfig.admins = result.config.telegram.admins;
        } else {
          telegramConfig.admins = result.admins;
        }
        const summary = result.admins.length ? result.admins.join(', ') : translate('common.labels.none');
        await bot.sendMessage(chatId, translate('telegram.owner.adminAdded', { adminId, summary }));
        return;
      }
      case 'remove-admin': {
        await configUpdater.requireOwner('telegram', userId);
        const adminId = args[0];
        if (!adminId) {
          await bot.sendMessage(chatId, translate('telegram.owner.usage.removeAdmin'));
          return;
        }
        const result = await configUpdater.removeTelegramAdmin(adminId);
        if (result.config?.telegram) {
          telegramConfig.admins = result.config.telegram.admins;
        } else {
          telegramConfig.admins = result.admins;
        }
        const summary = result.admins.length ? result.admins.join(', ') : translate('common.labels.none');
        await bot.sendMessage(chatId, translate('telegram.owner.adminRemoved', { adminId, summary }));
        return;
      }
      case 'list-admins': {
        await configUpdater.requireOwner('telegram', userId);
        const admins = await configUpdater.listTelegramAdmins();
        if (!admins.length) {
          await bot.sendMessage(chatId, translate('telegram.owner.listEmpty'));
        } else {
          const lines = admins.map((admin) => translate('telegram.owner.listItem', { admin }));
          await bot.sendMessage(chatId, [translate('telegram.owner.listHeader'), ...lines].join('\n'));
        }
        return;
      }
      case 'transfer-owner': {
        await configUpdater.requireOwner('telegram', userId);
        const targetId = args[0];
        if (!targetId) {
          await bot.sendMessage(chatId, translate('telegram.owner.usage.transferOwner'));
          return;
        }
        const { passkey } = await configUpdater.transferOwnership({
          currentPlatform: 'telegram',
          currentUserId: userId,
          newOwnerId: targetId,
          newOwnerPlatform: 'telegram'
        });
        telegramConfig.ownerId = String(targetId);
        const masked = passkey.length > 8 ? `${passkey.slice(0, 4)}…${passkey.slice(-4)}` : passkey;
        const lines = translate('telegram.owner.transfer', {
          targetId,
          passkey
        });
        await bot.sendMessage(chatId, Array.isArray(lines) ? lines.join('\n') : lines);
        logger.info('Telegram ownership transfer completed.', {
          previousOwner: userId,
          newOwner: targetId,
          passkeyPreview: masked
        });
        return;
      }
      default:
        await bot.sendMessage(chatId, buildOwnerHelp(translator));
    }
  } catch (error) {
    logger.error(`Telegram owner command failed: ${error.message}`);
    await bot.sendMessage(chatId, translate('telegram.owner.error', { message: error.message }));
  }
};

export const createTelegramBot = (telegramConfig, volumeVerifier, dependencies = {}) => {
  if (!telegramConfig?.enabled) {
    logger.info('Telegram integration disabled.');
    return null;
  }

  if (!telegramConfig.token) {
    throw new Error('Telegram bot token is required when Telegram integration is enabled.');
  }

  const translator = dependencies.translator;
  const translate = ensureTranslator(translator);
  const loadConfig = dependencies.loadConfig || loadRuntimeConfig;

  // Normalise legacy string configuration into an array so downstream logic can
  // iterate predictable message segments regardless of the source format.
  if (!Array.isArray(telegramConfig.startMessage)) {
    telegramConfig.startMessage = normaliseStartMessages(telegramConfig.startMessage);
  }

  const bot = new TelegramBot(telegramConfig.token, { polling: true });
  // Recover gracefully from transient polling failures such as ECONNRESET by restarting the
  // long-poll loop with exponential backoff. Without this guard the bot surfaces EFATAL errors
  // and stops receiving Telegram updates until the process is manually restarted.
  const pollingRecoveryState = {
    restartAttempts: 0,
    restartTimer: null
  };

  const restartPolling = async () => {
    try {
      await bot.stopPolling();
    } catch (stopError) {
      logger.debug(`Ignoring Telegram stopPolling error during recovery: ${stopError.message}`);
    }

    try {
      await bot.startPolling();
      pollingRecoveryState.restartAttempts = 0;
      logger.info('Telegram polling restarted successfully after connection reset.');
    } catch (startError) {
      logger.error(`Failed to restart Telegram polling after connection reset: ${startError.message}`);
      schedulePollingRestart();
    }
  };

  const schedulePollingRestart = () => {
    if (pollingRecoveryState.restartTimer) {
      logger.debug('Telegram polling restart already scheduled; skipping duplicate request.');
      return;
    }

    const attempt = pollingRecoveryState.restartAttempts;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
    pollingRecoveryState.restartAttempts = attempt + 1;

    const timer = setTimeout(async () => {
      pollingRecoveryState.restartTimer = null;
      await restartPolling();
    }, delay);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    pollingRecoveryState.restartTimer = timer;
    logger.debug(`Telegram polling restart scheduled in ${delay}ms.`, { attempt: pollingRecoveryState.restartAttempts });
  };

  bot.on('polling_error', (error = {}) => {
    const { code, message = 'Unknown polling error', stack } = error;
    const context = { code, message };

    if (code === 'EFATAL' && /ECONNRESET/i.test(message)) {
      logger.warn('Telegram polling connection reset detected. Scheduling restart.', context);
      schedulePollingRestart();
      return;
    }

    logger.error('Telegram polling encountered an unrecoverable error.', { ...context, stack });
  });
  // Track conversational state per chat so multiple users can progress through
  // the verification flow concurrently without stepping on each other.
  const sessions = new Map();
  // Track temporary group setup codes requested by administrators. Each entry is keyed by
  // the one-time code and contains metadata so we can validate who issued the request and
  // whether the code is still valid when it appears inside a group conversation.
  const pendingGroupLinks = new Map();
  // Track anonymous admin confirmation requests when Telegram hides the issuer's identity.
  // These entries remain active until the owner explicitly approves or the original setup
  // code expires, whichever occurs first.
  const pendingAnonymousConfirmations = new Map();
  const configUpdater = dependencies.configUpdater || configUpdateService;

  const generateGroupSetupCode = () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = crypto.randomBytes(3).toString('hex').toUpperCase();
      if (!pendingGroupLinks.has(code)) {
        return code;
      }
    }
    // In the highly unlikely event that all attempts collided, fall back to a timestamp based code.
    return `TG${Date.now().toString(36).toUpperCase()}`;
  };

  const cleanupExpiredGroupLinks = () => {
    const now = Date.now();
    for (const [code, record] of pendingGroupLinks.entries()) {
      if (record.expiresAt <= now) {
        pendingGroupLinks.delete(code);
        pendingAnonymousConfirmations.delete(code);
      }
    }

    for (const [code, confirmation] of pendingAnonymousConfirmations.entries()) {
      if (confirmation.expiresAt <= now || !pendingGroupLinks.has(code)) {
        pendingAnonymousConfirmations.delete(code);
      }
    }
  };

  const findPendingGroupLinkByAdmin = (adminId) => {
    const identifier = String(adminId);
    for (const [code, record] of pendingGroupLinks.entries()) {
      if (record.adminId === identifier) {
        return { code, record };
      }
    }
    return null;
  };

  const sendExchangePrompt = async (chatId) => {
    const exchanges = volumeVerifier.getExchanges ? volumeVerifier.getExchanges() : [];

    if (!exchanges.length) {
      logger.warn('Telegram verification requested but no exchanges are configured.');
      sessions.set(chatId, { step: STEPS.AWAITING_EXCHANGE });
      await bot.sendMessage(chatId, translate('telegram.verification.noExchangesConfigured'));
      return;
    }

    if (exchanges.length === 1) {
      const [singleExchange] = exchanges;
      const exchangeId = singleExchange.id;
      const exchangeLabel = singleExchange.description || singleExchange.name || exchangeId;
      const affiliateLink = singleExchange.affiliateLink || null;

      // Skip the selection keyboard when only one exchange is available so the user can
      // immediately provide their UID. This keeps the conversation concise without
      // changing the downstream verification behaviour.
      sessions.set(chatId, {
        step: STEPS.AWAITING_UID,
        exchangeId,
        exchangeName: exchangeLabel,
        affiliateLink
      });

      logger.info('Bypassing Telegram exchange selection: single exchange configured.', {
        chatId,
        exchangeId
      });
      const promptMessages = buildVerificationPrompt({
        telegramConfig,
        translator,
        exchangeConfig: singleExchange
      });

      await sendPromptMessages(bot, chatId, promptMessages, { parse_mode: 'Markdown' });
      return;
    }

    sessions.set(chatId, { step: STEPS.AWAITING_EXCHANGE });

    const messageLines = [
      translate('telegram.verification.welcome'),
      translate('telegram.verification.selectExchangePrompt')
    ];

    await bot.sendMessage(chatId, messageLines.join('\n'), {
      reply_markup: {
        inline_keyboard: buildExchangeKeyboard(exchanges)
      }
    });
  };

  const handleVerification = async (msg, session) => {
    const chatId = msg.chat.id;
    const uid = msg.text.trim();

    if (!uid) {
      await bot.sendMessage(chatId, translate('telegram.verification.sendValidUid'));
      return;
    }

    const { exchangeId } = session;
    logger.info(`Starting Telegram verification for UID ${uid} on exchange ${exchangeId}.`, {
      telegramUserId: msg.from?.id,
      chatId
    });

    try {
      const result = await volumeVerifier.verify(uid, { exchangeId });
      const exchangeMeta = volumeVerifier.getExchangeConfig ? volumeVerifier.getExchangeConfig(exchangeId) : null;
      const affiliateLink = exchangeMeta?.affiliateLink ?? session.affiliateLink ?? null;
      const exchangeLabel = exchangeMeta?.description || exchangeMeta?.name || session.exchangeName || exchangeId;

      if (!result.passed) {
        logger.info(`Verification failed for UID ${uid} on exchange ${exchangeId}.`, {
          depositReason: result.deposit?.reason || null,
          depositMet: result.deposit?.met,
          volume: result.volume
        });
        const messageParts = [formatVerificationMessage(result, translator), ''];
        const depositReason = result.deposit?.reason;

        if (depositReason === 'user_not_found') {
          messageParts.push(translate('telegram.verification.userNotFound', { uid, exchange: exchangeLabel }));
          if (affiliateLink) {
            messageParts.push(translate('telegram.verification.userNotFoundAffiliate'));
            messageParts.push(affiliateLink);
          } else {
            messageParts.push(translate('telegram.verification.userNotFoundNoAffiliate'));
          }
        } else if (depositReason === 'no deposit' || depositReason === 'deposit_not_met') {
          const thresholdText = typeof result.deposit?.threshold === 'number'
            ? translate('telegram.verification.depositRequirementWithAmount', { amount: result.deposit.threshold })
            : translate('telegram.verification.depositRequirementGeneric');
          messageParts.push(translate('telegram.verification.depositNotMet', { requirement: thresholdText }));
        } else if (depositReason === 'deposit_check_failed') {
          messageParts.push(translate('telegram.verification.depositCheckFailed'));
        } else {
          messageParts.push(translate('telegram.verification.verificationFailed'));
        }

        await bot.sendMessage(chatId, messageParts.join('\n'), {
          disable_web_page_preview: Boolean(affiliateLink)
        });
        return;
      }

      try {
        await saveVerifiedUser(result.influencer, uid, {
          exchange: result.exchangeId,
          exchangeId: result.exchangeDbId || null,
          telegramId: msg.from?.id ? String(msg.from.id) : null
        });
      } catch (error) {
        if (error instanceof VerifiedUserConflictError) {
          logger.warn(`UID ${uid} already verified for ${result.influencer}.`, {
            influencer: result.influencer,
            telegramId: msg.from?.id,
            exchangeId
          });
          await bot.sendMessage(chatId, [
            translate('telegram.verification.alreadyVerified'),
            translate('telegram.verification.alreadyVerifiedHelp')
          ].join('\n'));
          return;
        }
        throw error;
      }

      const inviteLinks = [];
      const failedInvites = [];
      const groupIds = normaliseGroupIds(telegramConfig);

      for (const groupId of groupIds) {
        try {
          const invite = await bot.createChatInviteLink(groupId, { member_limit: 1 });
          inviteLinks.push({ link: invite.invite_link, groupId });
          logger.info(`Generated one-time invite link for Telegram group ${groupId}.`, {
            exchangeId,
            uid,
            telegramUserId: msg.from?.id
          });
        } catch (error) {
          const message = error?.message || 'Unknown error creating invite link.';
          failedInvites.push({ groupId, message });
          logger.error(`Failed to create invite link for Telegram group ${groupId}: ${message}`);
        }
      }

      const responseLines = [
        formatVerificationMessage(result, translator),
        '',
        translate('telegram.verification.verified')
      ];

      if (telegramConfig.joinMessage) {
        responseLines.push('', telegramConfig.joinMessage);
      }

      if (inviteLinks.length) {
        responseLines.push('', translate('telegram.verification.tapToJoin'));
      } else {
        responseLines.push('', translate('telegram.verification.noGroupsConfigured'));
      }

      if (failedInvites.length) {
        responseLines.push('', translate('telegram.verification.inviteCreationFailed'));
        failedInvites.forEach((failure) => {
          responseLines.push(`• ${failure.groupId} – ${failure.message}`);
        });
      }

      const messageOptions = { disable_web_page_preview: true };

      if (inviteLinks.length) {
        messageOptions.reply_markup = { inline_keyboard: buildInviteKeyboard(inviteLinks) };
      }

      await bot.sendMessage(chatId, responseLines.join('\n'), messageOptions);
      sessions.delete(chatId);
    } catch (error) {
      if (error instanceof VerifiedUserConflictError) {
        // Already handled above, but guard in case future refactors move logic.
        return;
      }
      logger.error(`Telegram verification failed: ${error.message}`, {
        telegramUserId: msg.from?.id,
        chatId,
        exchangeId
      });
      await bot.sendMessage(chatId, translate('telegram.verification.verificationFailed', { uid, message: error.message }));
    }
  };

  const handleSettingsCommand = createTelegramSettingsHandler({ bot, telegramConfig, volumeVerifier, configUpdater, translator });
  const handleStatsCommand = createTelegramStatsHandler({ bot, telegramConfig, volumeVerifier, translator });
  const handleOwnerCommand = createTelegramOwnerHandler({ bot, telegramConfig, configUpdater, translator });

  const handleGroupSetupCommand = async (msg, argsText) => {
    cleanupExpiredGroupLinks();

    if (!isTelegramAdmin(telegramConfig, msg)) {
      await bot.sendMessage(msg.chat.id, translate('telegram.setupGroup.unauthorised'));
      logger.warn('Telegram user attempted to access /setupgroup without permission.', {
        telegramUserId: msg.from?.id,
        chatId: msg.chat?.id
      });
      return;
    }

    const adminId = msg.from?.id;
    if (!adminId) {
      await bot.sendMessage(msg.chat.id, translate('telegram.setupGroup.unableToDetermineUserId'));
      return;
    }

    const args = parseArgs(argsText);
    const existing = findPendingGroupLinkByAdmin(adminId);

    if (args.length && args[0].toLowerCase() === 'cancel') {
      if (existing) {
        pendingGroupLinks.delete(existing.code);
        pendingAnonymousConfirmations.delete(existing.code);
        const adminReplyOptions = {};
        if (msg.message_thread_id) {
          adminReplyOptions.message_thread_id = msg.message_thread_id;
        }
        await bot.sendMessage(msg.chat.id, translate('telegram.setupGroup.cancelled', { code: existing.code }), adminReplyOptions);
        logger.info('Telegram admin cancelled a pending group setup code.', {
          telegramUserId: adminId,
          code: existing.code
        });
      } else {
        await bot.sendMessage(msg.chat.id, translate('telegram.setupGroup.noActiveCode'));
      }
      return;
    }

    if (args.length && args[0].toLowerCase() === 'confirm') {
      const rawCode = args[1];
      if (!rawCode) {
        await bot.sendMessage(msg.chat.id, translate('telegram.setupGroup.confirmUsage'));
        return;
      }

      const code = String(rawCode).toUpperCase();
      const pendingRecord = pendingGroupLinks.get(code);

      if (!pendingRecord) {
        await bot.sendMessage(msg.chat.id, translate('telegram.setupGroup.confirmCodeNotFound', { code }));
        return;
      }

      if (pendingRecord.adminId !== String(adminId)) {
        await bot.sendMessage(msg.chat.id, translate('telegram.setupGroup.confirmWrongAdmin'));
        return;
      }

      const now = Date.now();
      if (pendingRecord.expiresAt <= now) {
        pendingGroupLinks.delete(code);
        pendingAnonymousConfirmations.delete(code);
        await bot.sendMessage(msg.chat.id, translate('telegram.setupGroup.confirmExpired', { code }));
        return;
      }

      const confirmation = pendingAnonymousConfirmations.get(code);
      if (!confirmation) {
        await bot.sendMessage(msg.chat.id, translate('telegram.setupGroup.confirmMissingConfirmation'));
        return;
      }

      if (args[2]) {
        const expectedChatId = String(confirmation.chatId);
        if (String(args[2]) !== expectedChatId) {
          await bot.sendMessage(
            msg.chat.id,
            translate('telegram.setupGroup.confirmChatMismatch', { expected: expectedChatId })
          );
          return;
        }
      }

      await finaliseGroupLink({
        code,
        record: pendingRecord,
        chatId: confirmation.chatId,
        chatType: confirmation.chatType,
        groupIdentifier: confirmation.groupIdentifier,
        chatTitle: confirmation.chatTitle,
        initiatorId: String(adminId)
      });

      logger.info('Telegram admin approved anonymous setup code via confirmation command.', {
        telegramUserId: adminId,
        code,
        chatId: confirmation.chatId
      });

      return;
    }

    if (existing) {
      pendingGroupLinks.delete(existing.code);
      pendingAnonymousConfirmations.delete(existing.code);
    }

    const code = generateGroupSetupCode();
    const now = Date.now();
    const expiresAt = now + GROUP_SETUP_CODE_TTL_MS;
    const record = {
      adminId: String(adminId),
      adminChatId: msg.chat.id,
      messageThreadId: msg.message_thread_id || null,
      requestedAt: now,
      expiresAt
    };
    pendingGroupLinks.set(code, record);

    const existingGroups = normaliseGroupIds(telegramConfig);
    const groupSummary = existingGroups.length
      ? ['Currently linked spaces:', ...existingGroups.map((groupId) => `• ${groupId}`)]
      : ['No Telegram groups or channels are linked yet.'];

    const minutes = Math.round(GROUP_SETUP_CODE_TTL_MS / 60000);
    const steps = [
      '🚀 Telegram space onboarding assistant',
      '',
      'Here is how to link a new group or channel:',
      '1. Add this bot as an administrator in the destination with permission to create invite links.',
      '2. Post the one-time setup code below in that space. Only you can complete the link.',
      '3. I will reply in the group and confirm here once everything is saved.',
      '',
      `One-time setup code (valid for ${minutes} minutes): ${code}`,
      '',
      'Need to start over? Send /setupgroup cancel to invalidate this code.',
      '',
      'After linking, verified members will automatically receive invite links for every saved space.',
      '',
      ...groupSummary
    ];

    const adminReplyOptions = { disable_web_page_preview: true };
    if (msg.message_thread_id) {
      adminReplyOptions.message_thread_id = msg.message_thread_id;
    }

    await bot.sendMessage(msg.chat.id, steps.join('\n'), adminReplyOptions);
    logger.info('Issued Telegram group setup code.', {
      code,
      expiresAt,
      telegramUserId: adminId,
      chatId: msg.chat.id
    });
  };

  const finaliseGroupLink = async ({ code, record, chatId, chatType, groupIdentifier, chatTitle, initiatorId }) => {
    const existingGroups = normaliseGroupIds(telegramConfig);

    if (existingGroups.includes(groupIdentifier)) {
      pendingGroupLinks.delete(code);
      pendingAnonymousConfirmations.delete(code);

      await bot.sendMessage(chatId, translate('telegram.setupGroup.alreadyLinked'));

      if (record.adminChatId) {
        const adminReplyOptions = { disable_web_page_preview: true };
        if (record.messageThreadId) {
          adminReplyOptions.message_thread_id = record.messageThreadId;
        }
        await bot.sendMessage(
          record.adminChatId,
          translate('telegram.setupGroup.alreadyLinkedNotification', { identifier: groupIdentifier }).join('\n'),
          adminReplyOptions
        );
      }
      return;
    }

    try {
      const { groupIds } = await configUpdater.addTelegramGroup({ groupId: groupIdentifier, label: chatTitle });
      telegramConfig.groupIds = groupIds;
      telegramConfig.groupId = groupIds.length ? groupIds[0] : '';
      pendingGroupLinks.delete(code);
      pendingAnonymousConfirmations.delete(code);

      await bot.sendMessage(chatId, translate('telegram.setupGroup.linkSuccess').join('\n'));

      if (record.adminChatId && record.adminChatId !== chatId) {
        const adminReplyOptions = { disable_web_page_preview: true };
        if (record.messageThreadId) {
          adminReplyOptions.message_thread_id = record.messageThreadId;
        }
        await bot.sendMessage(
          record.adminChatId,
          translate('telegram.setupGroup.linkSuccessNotification', {
            title: chatTitle,
            identifier: groupIdentifier
          }).join('\n'),
          adminReplyOptions
        );
      }

      logger.info('Telegram group linked via setup code.', {
        code,
        groupId: groupIdentifier,
        chatType,
        telegramUserId: initiatorId || record.adminId
      });
    } catch (error) {
      pendingGroupLinks.delete(code);
      pendingAnonymousConfirmations.delete(code);
      const message = error?.message || 'Unknown error while saving the group.';
      logger.error(`Failed to persist Telegram group ${groupIdentifier}: ${message}`);
      await bot.sendMessage(chatId, translate('telegram.setupGroup.linkFailed', { message }));
      if (record.adminChatId) {
        const adminReplyOptions = { disable_web_page_preview: true };
        if (record.messageThreadId) {
          adminReplyOptions.message_thread_id = record.messageThreadId;
        }
        await bot.sendMessage(
          record.adminChatId,
          translate('telegram.setupGroup.linkFailedNotification', { message }).join('\n'),
          adminReplyOptions
        );
      }
    }
  };

  const handleGroupSetupCodeMessage = async (msg, code, record) => {
    const chatId = msg.chat?.id;
    if (!chatId) {
      return;
    }

    const chatType = msg.chat?.type || 'unknown';
    if (!['group', 'supergroup', 'channel'].includes(chatType)) {
      await bot.sendMessage(chatId, translate('telegram.setupGroup.codePostedInWrongPlace'));
      return;
    }

    const now = Date.now();
    if (record.expiresAt <= now) {
      pendingGroupLinks.delete(code);
      pendingAnonymousConfirmations.delete(code);
      await bot.sendMessage(chatId, translate('telegram.setupGroup.codeExpired'));
      if (record.adminChatId) {
        const adminReplyOptions = { disable_web_page_preview: true };
        if (record.messageThreadId) {
          adminReplyOptions.message_thread_id = record.messageThreadId;
        }
        await bot.sendMessage(
          record.adminChatId,
          translate('telegram.setupGroup.codeExpiredNotification', { code }),
          adminReplyOptions
        );
      }
      return;
    }

    const groupIdentifier = msg.chat?.username ? `@${msg.chat.username}` : String(chatId);
    const chatTitle = msg.chat?.title || msg.chat?.username || groupIdentifier;
    const isAnonymousSender = msg.sender_chat?.id === chatId
      || msg.sender_chat?.type === 'channel'
      || msg.from?.username === 'GroupAnonymousBot';

    const senderId = msg.from?.id ? String(msg.from.id) : null;

    // Telegram omits msg.from when posting as a channel. Treat those messages as anonymous so
    // the issuing admin can approve the request instead of rejecting it outright.
    if (!senderId && !isAnonymousSender) {
      await bot.sendMessage(chatId, translate('telegram.setupGroup.postFromPersonalAccount'));
      return;
    }

    if (senderId !== record.adminId && !isAnonymousSender) {
      await bot.sendMessage(chatId, translate('telegram.setupGroup.wrongSender'));
      if (record.adminChatId) {
        const adminReplyOptions = { disable_web_page_preview: true };
        if (record.messageThreadId) {
          adminReplyOptions.message_thread_id = record.messageThreadId;
        }
        await bot.sendMessage(
          record.adminChatId,
          translate('telegram.setupGroup.wrongSenderNotification', { code }).join('\n'),
          adminReplyOptions
        );
      }
      return;
    }

    if (isAnonymousSender && senderId !== record.adminId) {
      pendingAnonymousConfirmations.set(code, {
        code,
        adminId: record.adminId,
        chatId,
        chatType,
        groupIdentifier,
        chatTitle,
        expiresAt: record.expiresAt
      });

      await bot.sendMessage(chatId, translate('telegram.setupGroup.anonymousPostDetected'));

      if (record.adminChatId) {
        const adminReplyOptions = { disable_web_page_preview: true };
        if (record.messageThreadId) {
          adminReplyOptions.message_thread_id = record.messageThreadId;
        }
        const confirmCommand = `/setupgroup confirm ${code} ${chatId}`;
        const confirmationLines = translate('telegram.setupGroup.anonymousConfirmationPrompt', {
          code,
          title: chatTitle,
          identifier: groupIdentifier,
          command: confirmCommand
        });
        await bot.sendMessage(
          record.adminChatId,
          Array.isArray(confirmationLines) ? confirmationLines.join('\n') : confirmationLines,
          {
            ...adminReplyOptions,
            reply_markup: {
              inline_keyboard: [[{
                text: translate('telegram.setupGroup.anonymousConfirmationButton'),
                callback_data: `confirm_group:${code}:${chatId}`
              }]]
            }
          }
        );
      }

      logger.info('Telegram setup code redemption requires admin confirmation due to anonymous sender.', {
        code,
        chatId,
        chatType,
        telegramUserId: senderId,
        adminId: record.adminId
      });

      return;
    }

    await finaliseGroupLink({
      code,
      record,
      chatId,
      chatType,
      groupIdentifier,
      chatTitle,
      initiatorId: senderId || record.adminId
    });
  };

  bot.onText(/\/start/i, async (msg) => {
    const chatId = msg.chat.id;
    const chatType = msg.chat?.type || 'unknown';
    logger.info('Received /start command from Telegram user.', {
      telegramUserId: msg.from?.id,
      chatId,
      chatType
    });

    if (chatType !== 'private') {
      logger.info('Ignored Telegram /start command outside a direct message.', {
        telegramUserId: msg.from?.id,
        chatId,
        chatType
      });
      await bot.sendMessage(chatId, translate('telegram.verification.dmRequired'));
      return;
    }

    await sendExchangePrompt(chatId);
  });

  bot.onText(/\/help(?:@[\w_]+)?/, async (msg) => {
    const chatId = msg.chat.id;
    logger.info('Received /help command from Telegram user.', {
      telegramUserId: msg.from?.id,
      chatId
    });
    await bot.sendMessage(chatId, [
      buildHelpMessage(translator),
      '',
      translate('telegram.help.detailedHelp')
    ].join('\n'));
  });

  bot.onText(/\/stats(?:@[\w_]+)?(?:\s+([\s\S]*))?/, async (msg, match) => {
    await handleStatsCommand(msg, match?.[1]);
  });

  bot.onText(/\/settings(?:@[\w_]+)?(?:\s+([\s\S]*))?/, async (msg, match) => {
    await handleSettingsCommand(msg, match?.[1]);
  });

  bot.onText(/\/owner(?:@[\w_]+)?(?:\s+([\s\S]*))?/, async (msg, match) => {
    await handleOwnerCommand(msg, match?.[1]);
  });

  bot.onText(/\/setupgroup(?:@[\w_]+)?(?:\s+([\s\S]*))?/, async (msg, match) => {
    await handleGroupSetupCommand(msg, match?.[1]);
  });

  bot.on('callback_query', async (callbackQuery) => {
    const { message, data, id, from } = callbackQuery;

    const acknowledge = async (payload) => {
      try {
        await bot.answerCallbackQuery(id, payload);
      } catch (error) {
        logger.warn(`Failed to acknowledge callback query: ${error.message}`);
      }
    };

    if (data?.startsWith('confirm_group:')) {
      const [, rawCode, targetChatId] = data.split(':');
      const code = String(rawCode || '').toUpperCase();
      const pendingRecord = pendingGroupLinks.get(code);

      if (!pendingRecord) {
        await acknowledge({
          text: translate('telegram.setupGroup.confirmCodeNotFound', { code }),
          show_alert: true
        });
        return;
      }

      if (pendingRecord.adminId !== String(from?.id)) {
        await acknowledge({
          text: translate('telegram.setupGroup.confirmWrongAdmin'),
          show_alert: true
        });
        return;
      }

      const now = Date.now();
      if (pendingRecord.expiresAt <= now) {
        pendingGroupLinks.delete(code);
        pendingAnonymousConfirmations.delete(code);
        await acknowledge({
          text: translate('telegram.setupGroup.confirmExpired', { code }),
          show_alert: true
        });
        return;
      }

      const confirmation = pendingAnonymousConfirmations.get(code);
      if (!confirmation) {
        await acknowledge({
          text: translate('telegram.setupGroup.confirmMissingConfirmation'),
          show_alert: true
        });
        return;
      }

      const expectedChatId = String(confirmation.chatId);
      if (targetChatId && targetChatId !== expectedChatId) {
        await acknowledge({
          text: translate('telegram.setupGroup.confirmChatMismatch', { expected: expectedChatId }),
          show_alert: true
        });
        return;
      }

      await finaliseGroupLink({
        code,
        record: pendingRecord,
        chatId: confirmation.chatId,
        chatType: confirmation.chatType,
        groupIdentifier: confirmation.groupIdentifier,
        chatTitle: confirmation.chatTitle,
        initiatorId: String(from?.id)
      });

      logger.info('Telegram admin approved anonymous setup code via callback confirmation.', {
        telegramUserId: from?.id,
        code,
        chatId: confirmation.chatId
      });

      await acknowledge({
        text: translate('telegram.setupGroup.confirmAccepted'),
        show_alert: false
      });
      return;
    }

    if (!message?.chat || !data?.startsWith('exchange:')) {
      return;
    }

    const chatId = message.chat.id;
    const chatType = message.chat?.type || 'unknown';
    const exchangeId = data.split(':')[1];

    if (chatType !== 'private') {
      await acknowledge({
        text: translate('telegram.verification.dmRequired'),
        show_alert: true
      });
      logger.warn('Received Telegram exchange selection from non-private chat. Ignoring.', {
        telegramUserId: message.from?.id,
        chatId,
        chatType,
        exchangeId
      });
      return;
    }

    await acknowledge();

    const exchanges = volumeVerifier.getExchanges ? volumeVerifier.getExchanges() : [];
    const selectedExchange = exchanges.find((exchange) => exchange.id === exchangeId);

    if (!selectedExchange) {
      logger.warn(`Telegram user selected unknown exchange ${exchangeId}.`, { chatId });
      await bot.sendMessage(chatId, translate('telegram.verification.exchangeNotAvailable'));
      await sendExchangePrompt(chatId);
      return;
    }

    const exchangeLabel = selectedExchange.description || selectedExchange.name || exchangeId;
    sessions.set(chatId, {
      step: STEPS.AWAITING_UID,
      exchangeId,
      exchangeName: exchangeLabel,
      affiliateLink: selectedExchange.affiliateLink || null
    });
    logger.info(`Telegram user selected exchange ${exchangeId}.`, {
      telegramUserId: message.from?.id,
      chatId
    });

    const followUpMessage = translate('telegram.verification.exchangeSelected', { exchange: exchangeLabel });

    const promptMessages = buildVerificationPrompt({
      telegramConfig,
      translator,
      exchangeConfig: selectedExchange
    });

    await bot.sendMessage(chatId, followUpMessage);
    await sendPromptMessages(bot, chatId, promptMessages, { parse_mode: 'Markdown' });
  });

  bot.on('message', async (msg) => {
    if (!msg.text) {
      return;
    }

    const trimmedText = msg.text.trim();

    if (trimmedText) {
      cleanupExpiredGroupLinks();
      const pendingRecord = pendingGroupLinks.get(trimmedText);
      if (pendingRecord) {
        await handleGroupSetupCodeMessage(msg, trimmedText, pendingRecord);
        return;
      }
    }

    const chatId = msg.chat.id;
    const chatType = msg.chat?.type || 'unknown';
    let session = sessions.get(chatId);

    if (msg.text.startsWith('/start')) {
      // The /start handler already processed this message.
      return;
    }

    if (chatType !== 'private') {
      logger.debug('Ignoring Telegram message outside a direct chat for verification handling.', {
        telegramUserId: msg.from?.id,
        chatId,
        chatType
      });
      return;
    }

    if (!session || session.step !== STEPS.AWAITING_UID) {
      const exchanges = volumeVerifier.getExchanges ? volumeVerifier.getExchanges() : [];
      let selectedExchange = null;

      if (exchanges.length === 1) {
        [selectedExchange] = exchanges;
      } else if (exchanges.length > 1) {
        try {
          const runtimeConfig = await loadConfig();
          const defaultExchangeId = runtimeConfig?.verification?.defaultExchange || null;
          if (defaultExchangeId) {
            selectedExchange = exchanges.find((exchange) => exchange.id === defaultExchangeId) || null;
          }
        } catch (configError) {
          logger.warn(`Unable to resolve default exchange while processing direct UID message: ${configError.message}`);
        }
      }

      if (selectedExchange) {
        const exchangeLabel = selectedExchange.description || selectedExchange.name || selectedExchange.id;
        sessions.set(chatId, {
          step: STEPS.AWAITING_UID,
          exchangeId: selectedExchange.id,
          exchangeName: exchangeLabel,
          affiliateLink: selectedExchange.affiliateLink || null
        });
        session = sessions.get(chatId);
        logger.info('Received UID before /start; defaulting to configured exchange.', {
          telegramUserId: msg.from?.id,
          chatId,
          exchangeId: selectedExchange.id
        });
      }
    }

    if (!session || session.step !== STEPS.AWAITING_UID) {
      return;
    }

    if (msg.text.startsWith('/')) {
      if (msg.text.toLowerCase().startsWith('/settings')) {
        return;
      }
      await bot.sendMessage(chatId, translate('telegram.verification.sendUidPrompt'));
      return;
    }

    await handleVerification(msg, session);
  });

  logger.info('Telegram bot started and polling for messages.');
  return bot;
};

export default createTelegramBot;
