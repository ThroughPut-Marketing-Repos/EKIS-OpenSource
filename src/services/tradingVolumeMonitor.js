import cron from 'node-cron';
import logger from '../utils/logger.js';
import { getConfig } from '../config/configManager.js';
import { getModels } from '../database/index.js';
import verificationService from './verificationService.js';
import volumeSnapshotService from './volumeSnapshotService.js';

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CRON_SCHEDULE = '0 0 * * *'; // Midnight UTC every day

const toTimestamp = (value) => {
  if (typeof value === 'number') {
    return value;
  }

  const parsed = Number(value);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }

  const date = new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
};

const normaliseGuildId = (value) => (value ? String(value) : null);

const findGuildConfig = (config, guildId) => {
  if (!guildId) {
    return null;
  }

  const discordConfig = config?.discord;
  if (!discordConfig?.guilds?.length) {
    return null;
  }

  return discordConfig.guilds.find((guild) => String(guild.id) === String(guildId)) || null;
};

const sendDiscordMessage = async (discordClient, record, message) => {
  if (!discordClient || !record.discordUserId) {
    return false;
  }

  try {
    const user = await discordClient.users.fetch(String(record.discordUserId));
    if (!user) {
      logger.warn(`[volumeMonitor] Discord user ${record.discordUserId} could not be fetched for influencer ${record.influencer}.`);
      return false;
    }
    await user.send(message);
    logger.info(`[volumeMonitor] Sent Discord DM to user ${record.discordUserId} for influencer ${record.influencer}.`);
    return true;
  } catch (error) {
    logger.warn(`[volumeMonitor] Failed to send Discord DM to ${record.discordUserId}: ${error.message}`);
    return false;
  }
};

const removeDiscordRole = async (discordClient, record, config) => {
  const guildId = normaliseGuildId(record.guildId);
  if (!discordClient || !record.discordUserId || !guildId) {
    return false;
  }

  const guildConfig = findGuildConfig(config, guildId);
  const verifiedRoleId = guildConfig?.verifiedRoleId;
  if (!verifiedRoleId) {
    logger.debug(`[volumeMonitor] No verified role configured for guild ${guildId}. Skipping role removal.`);
    return false;
  }

  try {
    const guild = await discordClient.guilds.fetch(guildId);
    const member = await guild.members.fetch(String(record.discordUserId));
    if (!member?.roles?.remove) {
      logger.warn(`[volumeMonitor] Member ${record.discordUserId} missing roles API for guild ${guildId}.`);
      return false;
    }
    await member.roles.remove(String(verifiedRoleId));
    logger.info(`[volumeMonitor] Removed verified role from Discord user ${record.discordUserId} in guild ${guildId}.`);
    return true;
  } catch (error) {
    logger.warn(`[volumeMonitor] Failed to remove verified role from Discord user ${record.discordUserId} in guild ${guildId}: ${error.message}`);
    return false;
  }
};

const sendTelegramMessage = async (telegramBot, record, message) => {
  if (!telegramBot || !record.telegramId) {
    return false;
  }

  try {
    await telegramBot.sendMessage(String(record.telegramId), message, { disable_web_page_preview: true });
    logger.info(`[volumeMonitor] Sent Telegram message to user ${record.telegramId} for influencer ${record.influencer}.`);
    return true;
  } catch (error) {
    logger.warn(`[volumeMonitor] Failed to send Telegram message to ${record.telegramId}: ${error.message}`);
    return false;
  }
};

const determineExchangeName = (record, verificationConfig) => {
  if (record.exchange) {
    return record.exchange;
  }

  if (record.exchangeRef?.name) {
    return record.exchangeRef.name;
  }

  return verificationConfig?.defaultExchange || null;
};

const formatWarningMessage = ({ influencer, minimumVolume, volume, deadline, daysRemaining }) => {
  const deadlineText = deadline.toISOString().split('T')[0];
  return [
    `Heads up! Your verified access for ${influencer} is at risk.`,
    `Required volume: ${minimumVolume}. Current recorded volume: ${volume}.`,
    `Please reach the required volume before ${deadlineText} (${daysRemaining} day${daysRemaining === 1 ? '' : 's'} remaining).`
  ].join(' ');
};

const formatRevocationMessage = ({ influencer, minimumVolume, volume, durationDays }) => [
  `Your verified access for ${influencer} has been revoked because the recorded trading volume (${volume})`,
  `did not reach the required ${minimumVolume} within ${durationDays} day${durationDays === 1 ? '' : 's'}.`,
  'Please verify again once you meet the requirement.'
].join(' ');

export const createTradingVolumeMonitor = (dependencies = {}) => {
  const {
    scheduler = cron,
    schedule = DEFAULT_CRON_SCHEDULE,
    configProvider = getConfig,
    modelsProvider = () => getModels(),
    volumeService = volumeSnapshotService,
    verificationActions = verificationService,
    discordClient = null,
    telegramBot = null
  } = dependencies;

  let task = null;
  let running = false;

  // Executes a single compliance pass. The flag prevents overlapping runs when cron triggers
  // faster than the job can complete (for example, during long exchange queries).
  const runComplianceCheck = async () => {
    if (running) {
      logger.warn('[volumeMonitor] Previous compliance check still in progress. Skipping this run.');
      return;
    }

    running = true;

    try {
      const config = await configProvider();
      const verification = config?.verification || {};

      if (verification.volumeCheckEnabled === false) {
        logger.debug('[volumeMonitor] Volume checks are disabled. Skipping compliance run.');
        return;
      }

      const minimumVolume = Number(verification.minimumVolume) || 0;
      const durationDays = Number(verification.volumeCheckDays) || 30;
      const warningEnabled = verification.volumeWarningEnabled !== false;
      const warningDays = Number(verification.volumeWarningDays) || 2;

      const models = await modelsProvider();
      const { VerifiedUser, Exchange } = models;
      if (!VerifiedUser) {
        logger.warn('[volumeMonitor] VerifiedUser model is unavailable.');
        return;
      }

      const verifiedUsers = await VerifiedUser.findAll({
        include: Exchange ? [{ model: Exchange, as: 'exchangeRef' }] : []
      });

      if (!verifiedUsers.length) {
        logger.debug('[volumeMonitor] No verified users found.');
        return;
      }

      const durationMs = durationDays * DAY_IN_MS;
      const warningMs = warningDays * DAY_IN_MS;
      const now = Date.now();

      let warningsSent = 0;
      let usersRevoked = 0;

      for (const record of verifiedUsers) {
        const verifiedAtMs = toTimestamp(record.verifiedAt);
        if (!verifiedAtMs) {
          logger.warn(`[volumeMonitor] Verified user ${record.uid} for ${record.influencer} is missing a valid verification timestamp.`);
          continue;
        }

        const deadlineMs = verifiedAtMs + durationMs;
        const deadline = new Date(deadlineMs);
        const endTime = new Date(Math.min(now, deadlineMs));
        const exchangeName = determineExchangeName(record, verification);

        if (!exchangeName) {
          logger.warn(`[volumeMonitor] Unable to determine exchange for UID ${record.uid} (${record.influencer}).`);
          continue;
        }

        let volume = 0;
        try {
          volume = Number(await volumeService.getVolumeBetween(
            record.uid,
            exchangeName,
            new Date(verifiedAtMs).toISOString(),
            endTime.toISOString()
          )) || 0;
        } catch (error) {
          logger.error(`[volumeMonitor] Failed to calculate volume for UID ${record.uid}: ${error.message}`);
          continue;
        }

        if (volume >= minimumVolume) {
          if (record.volumeWarningDate) {
            await record.update({ volumeWarningDate: null });
          }
          continue;
        }

        if (now >= deadlineMs) {
          const message = formatRevocationMessage({
            influencer: record.influencer,
            minimumVolume,
            volume,
            durationDays
          });

          await sendDiscordMessage(discordClient, record, message);
          await sendTelegramMessage(telegramBot, record, message);
          await removeDiscordRole(discordClient, record, config);

          try {
            await verificationActions.removeVerifiedUser(record.influencer, record.uid);
            logger.info(`[volumeMonitor] Revoked verified access for UID ${record.uid} (${record.influencer}).`);
            usersRevoked += 1;
          } catch (error) {
            logger.error(`[volumeMonitor] Failed to revoke verified user ${record.uid}: ${error.message}`);
          }
          continue;
        }

        if (!warningEnabled) {
          continue;
        }

        const warningStartMs = Math.max(verifiedAtMs, deadlineMs - warningMs);
        if (now < warningStartMs) {
          continue;
        }

        const lastWarningMs = toTimestamp(record.volumeWarningDate);
        if (lastWarningMs && lastWarningMs >= warningStartMs) {
          continue;
        }

        const daysRemaining = Math.max(1, Math.ceil((deadlineMs - now) / DAY_IN_MS));
        const message = formatWarningMessage({
          influencer: record.influencer,
          minimumVolume,
          volume,
          deadline,
          daysRemaining
        });

        const warningDelivered = await Promise.all([
          sendDiscordMessage(discordClient, record, message),
          sendTelegramMessage(telegramBot, record, message)
        ]);

        if (warningDelivered.some(Boolean)) {
          try {
            const warningTimestamp = new Date().toISOString();
            await record.update({ volumeWarningDate: warningTimestamp });
            warningsSent += 1;
            logger.info(`[volumeMonitor] Warning issued to UID ${record.uid} (${record.influencer}).`);
          } catch (error) {
            logger.error(`[volumeMonitor] Failed to persist warning timestamp for UID ${record.uid}: ${error.message}`);
          }
        }
      }

      logger.info(`[volumeMonitor] Compliance run completed. warnings=${warningsSent}, revoked=${usersRevoked}.`);
    } catch (error) {
      logger.error(`[volumeMonitor] Compliance run failed: ${error.message}`);
    } finally {
      running = false;
    }
  };

  const start = () => {
    if (task) {
      return;
    }

    task = scheduler.schedule(schedule, runComplianceCheck, { scheduled: false });
    task.start();
    logger.info(`[volumeMonitor] Scheduled trading volume compliance cron with expression "${schedule}".`);
  };

  const stop = async () => {
    if (task) {
      task.stop();
      task = null;
      logger.info('[volumeMonitor] Trading volume compliance cron stopped.');
    }
  };

  return {
    start,
    stop,
    runNow: runComplianceCheck
  };
};

export default createTradingVolumeMonitor;
