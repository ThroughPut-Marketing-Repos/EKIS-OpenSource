import crypto from 'crypto';
import TelegramBot from 'node-telegram-bot-api';
import logger from '../utils/logger.js';
import configUpdateService from '../services/configUpdateService.js';
import { getConfig as loadRuntimeConfig } from '../config/configManager.js';
import { saveVerifiedUser, VerifiedUserConflictError } from '../services/verificationService.js';

const STEPS = {
  AWAITING_EXCHANGE: 'awaiting_exchange',
  AWAITING_UID: 'awaiting_uid'
};

const GROUP_SETUP_CODE_TTL_MS = 15 * 60 * 1000;

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

export const buildSettingsHelp = () => [
  'Available settings commands:',
  '/settings volume <on|off>',
  '/settings min_volume <amount>',
  '/settings deposit <amount|clear>',
  '/settings volume_days <days>',
  '/settings volume_warning <on|off>',
  '/settings warning_days <days>',
  '/settings api add <name> <type> <key> <secret> [passphrase]',
  '/settings api update <name> <type> <key> <secret> [passphrase]',
  '/settings api remove <name>',
  '/settings api list',
  '/settings affiliate <exchange> <url|clear>',
  '/settings show'
].join('\n');

export const buildOwnerHelp = () => [
  'Owner command usage:',
  '/owner register <passkey>',
  '/owner add-admin <telegramUserId>',
  '/owner remove-admin <telegramUserId>',
  '/owner list-admins',
  '/owner transfer-owner <telegramUserId>'
].join('\n');

/**
 * Provides a consolidated overview of the Telegram bot commands. Keep this
 * list synchronised with new commands to ensure `/help` remains accurate.
 */
export const buildHelpMessage = () => [
  'Available commands:',
  '• /start – Begin the verification flow. Usage: /start',
  '• /help – Display this command reference. Usage: /help',
  '• /setupgroup – Link a new Telegram group or channel (admins only). Usage: /setupgroup',
  '• /settings – Manage verification settings (admins only). Usage: /settings show',
  '• /owner – Manage bot ownership and admin access (owner only). Usage: /owner list-admins'
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

export const parseArgs = (text) => {
  if (!text) {
    return [];
  }
  return text.trim().split(/\s+/);
};

// Normalises configuration so a single string or an array of identifiers can be
// treated uniformly when generating invite links.
const normaliseGroupIds = (telegramConfig) => {
  const groups = new Set();

  if (Array.isArray(telegramConfig?.groupIds)) {
    telegramConfig.groupIds
      .map((groupId) => (groupId ? String(groupId).trim() : ''))
      .filter(Boolean)
      .forEach((groupId) => groups.add(groupId));
  }

  const rawGroupId = telegramConfig?.groupId;
  if (rawGroupId) {
    String(rawGroupId)
      .split(',')
      .map((groupId) => groupId.trim())
      .filter(Boolean)
      .forEach((groupId) => groups.add(groupId));
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

export const createTelegramSettingsHandler = ({ bot, telegramConfig, volumeVerifier, configUpdater }) => async (msg, argsText) => {
  const chatId = msg.chat.id;

  if (!isTelegramAdmin(telegramConfig, msg)) {
    await bot.sendMessage(chatId, 'You are not authorised to manage settings.');
    logger.warn('Telegram user attempted to access settings without permission.', {
      telegramUserId: msg.from?.id,
      chatId
    });
    return;
  }

  const args = parseArgs(argsText);
  if (!args.length) {
    await bot.sendMessage(chatId, buildSettingsHelp());
    return;
  }

  const subcommand = args.shift().toLowerCase();

  try {
    let updatedConfig;
    switch (subcommand) {
      case 'volume': {
        const enabled = normaliseBooleanFlag(args[0]);
        updatedConfig = await configUpdater.setVolumeCheckEnabled(enabled);
        await bot.sendMessage(chatId, `Trading volume check has been ${enabled ? 'enabled' : 'disabled'}.`);
        break;
      }
      case 'min_volume': {
        const amount = args[0];
        updatedConfig = await configUpdater.setMinimumVolume(amount);
        await bot.sendMessage(chatId, `Minimum trading volume requirement updated to ${updatedConfig.verification.minimumVolume}.`);
        break;
      }
      case 'deposit': {
        const value = args[0];
        const amount = ['clear', 'none', 'off'].includes(String(value).toLowerCase()) ? null : value;
        updatedConfig = await configUpdater.setDepositThreshold(amount);
        const { depositThreshold } = updatedConfig.verification;
        await bot.sendMessage(chatId, depositThreshold === null
          ? 'Deposit threshold cleared.'
          : `Deposit threshold set to ${depositThreshold}.`);
        break;
      }
      case 'volume_days': {
        const days = args[0];
        updatedConfig = await configUpdater.setVolumeCheckDays(days);
        await bot.sendMessage(chatId, `Trading volume window updated to ${updatedConfig.verification.volumeCheckDays} days.`);
        break;
      }
      case 'volume_warning': {
        const enabled = normaliseBooleanFlag(args[0]);
        updatedConfig = await configUpdater.setVolumeWarningEnabled(enabled);
        await bot.sendMessage(chatId, `Volume warning notifications have been ${enabled ? 'enabled' : 'disabled'}.`);
        break;
      }
      case 'warning_days': {
        const days = args[0];
        updatedConfig = await configUpdater.setVolumeWarningDays(days);
        await bot.sendMessage(chatId, `Warning lead time updated to ${updatedConfig.verification.volumeWarningDays} days.`);
        break;
      }
      case 'api': {
        const action = (args.shift() || '').toLowerCase();
        if (action === 'add' || action === 'update') {
          const [name, type, apiKey, apiSecret, passphrase] = args;
          if (!name || !type || !apiKey || !apiSecret) {
            throw new Error('Usage: /settings api add|update <name> <type> <key> <secret> [passphrase]');
          }
          updatedConfig = await configUpdater.upsertExchangeCredentials({
            name,
            type,
            apiKey,
            apiSecret,
            passphrase
          });
          await bot.sendMessage(chatId, `Credentials ${action === 'add' ? 'created' : 'updated'} for exchange ${name}.`);
        } else if (action === 'remove' || action === 'delete') {
          const name = args[0];
          if (!name) {
            throw new Error('Usage: /settings api remove <name>');
          }
          updatedConfig = await configUpdater.removeExchange(name);
          await bot.sendMessage(chatId, `Exchange ${name} removed.`);
        } else if (action === 'list') {
          const exchanges = await configUpdater.listExchanges();
          if (!exchanges.length) {
            await bot.sendMessage(chatId, 'No exchanges are configured in the database.');
          } else {
            const lines = exchanges.map((exchange) => `• ${exchange.name} (${exchange.type || 'type unknown'})`);
            await bot.sendMessage(chatId, ['Configured exchanges:', ...lines].join('\n'));
          }
          return;
        } else {
          throw new Error('Unknown api action. Use add, update, remove, or list.');
        }
        break;
      }
      case 'affiliate': {
        const name = args.shift();
        if (!name) {
          throw new Error('Usage: /settings affiliate <exchange> <url|clear>');
        }

        if (!args.length) {
          throw new Error('Usage: /settings affiliate <exchange> <url|clear>');
        }

        const rawLink = args.join(' ').trim();
        const shouldClear = ['clear', 'none', 'off'].includes(rawLink.toLowerCase());
        const linkValue = shouldClear ? null : rawLink;

        updatedConfig = await configUpdater.setExchangeAffiliateLink(name, linkValue);
        await bot.sendMessage(chatId, linkValue
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
        await bot.sendMessage(chatId, summary.join('\n'));
        return;
      }
      default:
        await bot.sendMessage(chatId, buildSettingsHelp());
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
    await bot.sendMessage(chatId, `Settings update failed: ${error.message}`);
  }
};

export const createTelegramOwnerHandler = ({ bot, telegramConfig, configUpdater }) => async (msg, argsText) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!userId) {
    await bot.sendMessage(chatId, 'Unable to determine your Telegram user ID.');
    return;
  }

  const args = parseArgs(argsText);
  if (!args.length) {
    await bot.sendMessage(chatId, buildOwnerHelp());
    return;
  }

  const subcommand = args.shift().toLowerCase();

  try {
    switch (subcommand) {
      case 'register': {
        const passkey = args[0];
        if (!passkey) {
          await bot.sendMessage(chatId, 'Usage: /owner register <passkey>');
          return;
        }

        await configUpdater.registerOwner({ platform: 'telegram', userId, passkey });
        telegramConfig.ownerId = String(userId);
        logger.info('Telegram owner registered successfully.', { telegramUserId: userId });
        await bot.sendMessage(chatId, 'Ownership registered. You may now manage admins and transfers.');
        return;
      }
      case 'add-admin': {
        await configUpdater.requireOwner('telegram', userId);
        const adminId = args[0];
        if (!adminId) {
          await bot.sendMessage(chatId, 'Usage: /owner add-admin <telegramUserId>');
          return;
        }
        const result = await configUpdater.addTelegramAdmin(adminId);
        if (result.config?.telegram) {
          telegramConfig.admins = result.config.telegram.admins;
        } else {
          telegramConfig.admins = result.admins;
        }
        const summary = result.admins.length ? result.admins.join(', ') : 'none';
        await bot.sendMessage(chatId, `Admin ${adminId} added. Current admins: ${summary}.`);
        return;
      }
      case 'remove-admin': {
        await configUpdater.requireOwner('telegram', userId);
        const adminId = args[0];
        if (!adminId) {
          await bot.sendMessage(chatId, 'Usage: /owner remove-admin <telegramUserId>');
          return;
        }
        const result = await configUpdater.removeTelegramAdmin(adminId);
        if (result.config?.telegram) {
          telegramConfig.admins = result.config.telegram.admins;
        } else {
          telegramConfig.admins = result.admins;
        }
        const summary = result.admins.length ? result.admins.join(', ') : 'none';
        await bot.sendMessage(chatId, `Admin ${adminId} removed. Current admins: ${summary}.`);
        return;
      }
      case 'list-admins': {
        await configUpdater.requireOwner('telegram', userId);
        const admins = await configUpdater.listTelegramAdmins();
        if (!admins.length) {
          await bot.sendMessage(chatId, 'No Telegram admins are currently configured.');
        } else {
          const lines = admins.map((admin) => `• ${admin}`);
          await bot.sendMessage(chatId, ['Configured Telegram admins:', ...lines].join('\n'));
        }
        return;
      }
      case 'transfer-owner': {
        await configUpdater.requireOwner('telegram', userId);
        const targetId = args[0];
        if (!targetId) {
          await bot.sendMessage(chatId, 'Usage: /owner transfer-owner <telegramUserId>');
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
        await bot.sendMessage(chatId, [
          `Ownership transferred to user ${targetId}.`,
          'Share the new passkey with the incoming owner so they can register:',
          passkey,
          '',
          'For production environments, communicate the passkey securely.'
        ].join('\n'));
        logger.info('Telegram ownership transfer completed.', {
          previousOwner: userId,
          newOwner: targetId,
          passkeyPreview: masked
        });
        return;
      }
      default:
        await bot.sendMessage(chatId, buildOwnerHelp());
    }
  } catch (error) {
    logger.error(`Telegram owner command failed: ${error.message}`);
    await bot.sendMessage(chatId, `Owner command failed: ${error.message}`);
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
      await bot.sendMessage(chatId, 'No exchanges are configured for verification at this time.');
      return;
    }

    const messageLines = [
      'Welcome! Select the exchange you want to verify with to continue.',
      'After selecting an exchange, send your UID so we can confirm your affiliate status and qualifying deposit.'
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
      await bot.sendMessage(chatId, 'Please send a valid UID so we can continue the verification process.');
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
        const messageParts = [formatVerificationMessage(result), ''];
        const depositReason = result.deposit?.reason;

        if (depositReason === 'user_not_found') {
          messageParts.push(`We couldn't find UID ${uid} on ${exchangeLabel}.`);
          if (affiliateLink) {
            messageParts.push('Create your account using this affiliate link, then try again:');
            messageParts.push(affiliateLink);
          } else {
            messageParts.push('Please register a new account using the official affiliate link, then retry verification.');
          }
        } else if (depositReason === 'no deposit' || depositReason === 'deposit_not_met') {
          const thresholdText = typeof result.deposit?.threshold === 'number'
            ? `the required deposit of ${result.deposit.threshold}`
            : 'the required deposit';
          messageParts.push(`We could not confirm ${thresholdText} for this UID. Please complete your deposit and try again.`);
        } else if (depositReason === 'deposit_check_failed') {
          messageParts.push('We could not reach the exchange to confirm your deposit. Please try again in a few minutes.');
        } else {
          messageParts.push('We could not verify this UID. Please double-check the value and try again.');
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
            'This UID has already been verified by another account.',
            'If you believe this is incorrect, please contact support or provide a different UID.'
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
        formatVerificationMessage(result),
        '',
        '✅ You are verified!'
      ];

      if (telegramConfig.joinMessage) {
        responseLines.push('', telegramConfig.joinMessage);
      }

      if (inviteLinks.length) {
        responseLines.push('', 'Tap a button below to join your Telegram spaces:');
      } else {
        responseLines.push('', 'No Telegram groups are configured for automated invites. Please contact support for access.');
      }

      if (failedInvites.length) {
        responseLines.push('', '⚠️ We could not create invites for the following groups:');
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
      await bot.sendMessage(chatId, `Unable to verify UID ${uid}. ${error.message}`);
    }
  };

  const handleSettingsCommand = createTelegramSettingsHandler({ bot, telegramConfig, volumeVerifier, configUpdater });
  const handleOwnerCommand = createTelegramOwnerHandler({ bot, telegramConfig, configUpdater });

  const handleGroupSetupCommand = async (msg, argsText) => {
    cleanupExpiredGroupLinks();

    if (!isTelegramAdmin(telegramConfig, msg)) {
      await bot.sendMessage(msg.chat.id, 'You need to be a Telegram admin to prepare group onboarding codes.');
      logger.warn('Telegram user attempted to access /setupgroup without permission.', {
        telegramUserId: msg.from?.id,
        chatId: msg.chat?.id
      });
      return;
    }

    const adminId = msg.from?.id;
    if (!adminId) {
      await bot.sendMessage(msg.chat.id, 'I could not determine your Telegram user ID. Please try again.');
      return;
    }

    const args = parseArgs(argsText);
    const existing = findPendingGroupLinkByAdmin(adminId);

    if (args.length && args[0].toLowerCase() === 'cancel') {
      if (existing) {
        pendingGroupLinks.delete(existing.code);
        const adminReplyOptions = {};
        if (msg.message_thread_id) {
          adminReplyOptions.message_thread_id = msg.message_thread_id;
        }
        await bot.sendMessage(msg.chat.id, `Cancelled setup code ${existing.code}.`, adminReplyOptions);
        logger.info('Telegram admin cancelled a pending group setup code.', {
          telegramUserId: adminId,
          code: existing.code
        });
      } else {
        await bot.sendMessage(msg.chat.id, 'You do not have any active setup codes. Send /setupgroup to generate one.');
      }
      return;
    }

    if (existing) {
      pendingGroupLinks.delete(existing.code);
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

  const handleGroupSetupCodeMessage = async (msg, code, record) => {
    const chatId = msg.chat?.id;
    if (!chatId) {
      return;
    }

    const chatType = msg.chat?.type || 'unknown';
    if (!['group', 'supergroup', 'channel'].includes(chatType)) {
      await bot.sendMessage(chatId, 'This setup code must be posted inside the group or channel you would like to link.');
      return;
    }

    const now = Date.now();
    if (record.expiresAt <= now) {
      pendingGroupLinks.delete(code);
      await bot.sendMessage(chatId, 'This setup code has expired. Please run /setupgroup again to generate a fresh one.');
      if (record.adminChatId) {
        const adminReplyOptions = { disable_web_page_preview: true };
        if (record.messageThreadId) {
          adminReplyOptions.message_thread_id = record.messageThreadId;
        }
        await bot.sendMessage(record.adminChatId, `The setup code ${code} expired before it was used.`, adminReplyOptions);
      }
      return;
    }

    const senderId = msg.from?.id ? String(msg.from.id) : null;
    if (!senderId) {
      await bot.sendMessage(chatId, 'Please post the setup code from your personal account so I can confirm your admin access.');
      return;
    }

    if (senderId !== record.adminId) {
      await bot.sendMessage(chatId, 'Only the administrator who generated this setup code can complete the link. Ask them to post it directly.');
      if (record.adminChatId) {
        const adminReplyOptions = { disable_web_page_preview: true };
        if (record.messageThreadId) {
          adminReplyOptions.message_thread_id = record.messageThreadId;
        }
        await bot.sendMessage(record.adminChatId, [
          'Heads up: someone attempted to use your setup code but the sender ID did not match your account.',
          `Code: ${code}`,
          'The code remains active for you to reuse within the original validity window.'
        ].join('\n'), adminReplyOptions);
      }
      return;
    }

    const groupIdentifier = msg.chat?.username ? `@${msg.chat.username}` : String(chatId);
    const chatTitle = msg.chat?.title || msg.chat?.username || groupIdentifier;
    const existingGroups = normaliseGroupIds(telegramConfig);

    if (existingGroups.includes(groupIdentifier)) {
      pendingGroupLinks.delete(code);
      await bot.sendMessage(chatId, 'ℹ️ This space is already linked. No changes were required, you can delete this code.');
      if (record.adminChatId) {
        const adminReplyOptions = { disable_web_page_preview: true };
        if (record.messageThreadId) {
          adminReplyOptions.message_thread_id = record.messageThreadId;
        }
        await bot.sendMessage(record.adminChatId, [
          'This group was already on the invite list.',
          `Identifier: ${groupIdentifier}`
        ].join('\n'), adminReplyOptions);
      }
      return;
    }

    try {
      const { groupIds } = await configUpdater.addTelegramGroup({ groupId: groupIdentifier, label: chatTitle });
      telegramConfig.groupIds = groupIds;
      telegramConfig.groupId = groupIds.length ? groupIds[0] : '';
      pendingGroupLinks.delete(code);

      await bot.sendMessage(chatId, [
        '✅ Thanks! This space is now linked to the verification flow.',
        'Verified members will automatically receive single-use invite links here.',
        'You can safely delete this setup code message.'
      ].join('\n'));

      if (record.adminChatId && record.adminChatId !== chatId) {
        const adminReplyOptions = { disable_web_page_preview: true };
        if (record.messageThreadId) {
          adminReplyOptions.message_thread_id = record.messageThreadId;
        }
        await bot.sendMessage(record.adminChatId, [
          '🎉 Group linked successfully!',
          `• Title: ${chatTitle}`,
          `• Identifier: ${groupIdentifier}`,
          '',
          'Invite links for verified members will now include this space automatically.',
          'Run /setupgroup again whenever you need to add another group or channel.'
        ].join('\n'), adminReplyOptions);
      }

      logger.info('Telegram group linked via setup code.', {
        code,
        groupId: groupIdentifier,
        chatType,
        telegramUserId: senderId
      });
    } catch (error) {
      pendingGroupLinks.delete(code);
      const message = error?.message || 'Unknown error while saving the group.';
      logger.error(`Failed to persist Telegram group ${groupIdentifier}: ${message}`);
      await bot.sendMessage(chatId, `⚠️ I could not save this space: ${message}`);
      if (record.adminChatId) {
        const adminReplyOptions = { disable_web_page_preview: true };
        if (record.messageThreadId) {
          adminReplyOptions.message_thread_id = record.messageThreadId;
        }
        await bot.sendMessage(record.adminChatId, [
          '⚠️ Something went wrong while saving that group.',
          `Error: ${message}`,
          '',
          'Please resolve the issue and run /setupgroup again when ready.'
        ].join('\n'), adminReplyOptions);
      }
    }
  };

  bot.onText(/\/start/i, async (msg) => {
    const chatId = msg.chat.id;
    sessions.set(chatId, { step: STEPS.AWAITING_EXCHANGE });
    logger.info('Received /start command from Telegram user.', {
      telegramUserId: msg.from?.id,
      chatId
    });
    await sendExchangePrompt(chatId);
  });

  bot.onText(/\/help(?:@[\w_]+)?/, async (msg) => {
    const chatId = msg.chat.id;
    logger.info('Received /help command from Telegram user.', {
      telegramUserId: msg.from?.id,
      chatId
    });
    await bot.sendMessage(chatId, [
      buildHelpMessage(),
      '',
      'Use /settings or /owner without arguments to see detailed subcommand help.'
    ].join('\n'));
  });

  bot.onText(/\/settings(?:@[\w_]+)?(?:\s+(.*))?/, async (msg, match) => {
    await handleSettingsCommand(msg, match?.[1]);
  });

  bot.onText(/\/owner(?:@[\w_]+)?(?:\s+(.*))?/, async (msg, match) => {
    await handleOwnerCommand(msg, match?.[1]);
  });

  bot.onText(/\/setupgroup(?:@[\w_]+)?(?:\s+(.*))?/, async (msg, match) => {
    await handleGroupSetupCommand(msg, match?.[1]);
  });

  bot.on('callback_query', async (callbackQuery) => {
    const { message, data, id } = callbackQuery;
    if (!message?.chat || !data?.startsWith('exchange:')) {
      return;
    }

    const chatId = message.chat.id;
    const exchangeId = data.split(':')[1];

    try {
      await bot.answerCallbackQuery(id);
    } catch (error) {
      logger.warn(`Failed to acknowledge callback query: ${error.message}`);
    }

    const exchanges = volumeVerifier.getExchanges ? volumeVerifier.getExchanges() : [];
    const selectedExchange = exchanges.find((exchange) => exchange.id === exchangeId);

    if (!selectedExchange) {
      logger.warn(`Telegram user selected unknown exchange ${exchangeId}.`, { chatId });
      await bot.sendMessage(chatId, 'That exchange is not available. Please select one of the listed options.');
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

    const followUpLines = [
      `Great choice! ${exchangeLabel} requires an eligible affiliate account.`,
      'Please reply with the UID you would like us to verify.'
    ];

    if (typeof selectedExchange.depositThreshold === 'number' && !Number.isNaN(selectedExchange.depositThreshold)) {
      followUpLines.splice(1, 0, `Minimum deposit: ${selectedExchange.depositThreshold}`);
    }

    if (selectedExchange.affiliateLink) {
      followUpLines.push('', `Affiliate link: ${selectedExchange.affiliateLink}`);
    }
    await bot.sendMessage(chatId, followUpLines.join('\n'));
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
    const session = sessions.get(chatId);

    if (msg.text.startsWith('/start')) {
      // The /start handler already processed this message.
      return;
    }

    if (!session || session.step !== STEPS.AWAITING_UID) {
      return;
    }

    if (msg.text.startsWith('/')) {
      if (msg.text.toLowerCase().startsWith('/settings')) {
        return;
      }
      await bot.sendMessage(chatId, 'Please send your UID to continue the verification process.');
      return;
    }

    await handleVerification(msg, session);
  });

  logger.info('Telegram bot started and polling for messages.');
  return bot;
};

export default createTelegramBot;
