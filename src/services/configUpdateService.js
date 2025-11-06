import crypto from 'crypto';
import logger from '../utils/logger.js';
import { normaliseStartMessages, serialiseStartMessages } from '../utils/startMessage.js';
import { getModels } from '../database/index.js';
import { resetConfigCache, getConfig } from '../config/configManager.js';

const refreshRuntimeConfig = async () => {
  resetConfigCache();
  const config = await getConfig();
  return config;
};

const normaliseToken = (value) => {
  if (typeof value === 'undefined' || value === null) {
    return null;
  }

  const token = String(value).trim();
  return token.length > 0 ? token : null;
};

const maskTokenForLog = (token) => {
  if (!token) {
    return null;
  }

  if (token.length <= 8) {
    return '*'.repeat(token.length);
  }

  return `${token.slice(0, 4)}…${token.slice(-4)}`;
};

const ensureConfigurationRecord = async () => {
  const { Configuration } = getModels();
  const existing = await Configuration.findOne();
  if (existing) {
    return existing;
  }
  logger.info('Configuration record missing. Creating a new default configuration row.');
  return Configuration.create({});
};

// Persist bot tokens sourced from environment variables so operators can supply
// credentials via process managers (e.g. systemd) while keeping the database as
// the ultimate configuration source.
export const syncEnvironmentTokens = async () => {
  const configuration = await ensureConfigurationRecord();

  const discordToken = normaliseToken(process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN);
  const telegramToken = normaliseToken(process.env.TELEGRAM_BOT_TOKEN);

  if (!discordToken && !telegramToken) {
    logger.debug('No bot token environment variables detected during configuration sync.');
    return { updated: false, updates: {} };
  }

  const updates = {};
  const maskedTokens = {};

  const currentDiscordToken = normaliseToken(configuration.discord_bot_token);
  if (discordToken && currentDiscordToken !== discordToken) {
    updates.discord_bot_token = discordToken;
    maskedTokens.discord_bot_token = maskTokenForLog(discordToken);
  }

  const currentTelegramToken = normaliseToken(configuration.telegram_bot_token);
  if (telegramToken && currentTelegramToken !== telegramToken) {
    updates.telegram_bot_token = telegramToken;
    maskedTokens.telegram_bot_token = maskTokenForLog(telegramToken);
  }

  if (Object.keys(updates).length === 0) {
    logger.debug('Environment bot tokens already match the stored configuration.');
    return { updated: false, updates: {} };
  }

  await configuration.update(updates);
  await configuration.reload();
  await refreshRuntimeConfig();

  logger.info('Synchronised bot tokens from environment variables.', {
    updatedFields: Object.keys(updates),
    tokens: maskedTokens
  });

  return { updated: true, updates };
};

const parseNumber = (value, { allowNull = false, integer = false } = {}) => {
  if (value === null && allowNull) {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return integer ? Math.trunc(value) : value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = integer ? parseInt(value, 10) : Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  if (allowNull && (value === undefined || value === '')) {
    return null;
  }

  throw new Error('A numeric value was expected.');
};

const normaliseExchangeName = (rawName) => {
  if (!rawName || typeof rawName !== 'string') {
    throw new Error('Exchange name is required.');
  }
  const name = rawName.trim();
  if (!name) {
    throw new Error('Exchange name cannot be empty.');
  }
  return name;
};

const OWNER_PLATFORMS = new Set(['telegram', 'discord']);
const OWNER_PASSKEY_BYTES = 24;
const OWNER_COLUMN_MAP = {
  telegram: 'owner_telegram_id',
  discord: 'owner_discord_id'
};

const normaliseIdentifier = (value, label) => {
  if (value === null || value === undefined) {
    throw new Error(`${label} is required.`);
  }

  const identifier = String(value).trim();
  if (!identifier) {
    throw new Error(`${label} is required.`);
  }
  return identifier;
};

const normalisePlatform = (value) => {
  const platform = normaliseIdentifier(value, 'Owner platform').toLowerCase();
  if (!OWNER_PLATFORMS.has(platform)) {
    throw new Error('Owner platform must be either telegram or discord.');
  }
  return platform;
};

const generateOwnerPasskey = () => crypto.randomBytes(OWNER_PASSKEY_BYTES).toString('hex');

const getOwnerColumn = (platform) => OWNER_COLUMN_MAP[platform];

const deriveLegacyOwnerId = (configuration, platform) => {
  if (configuration.owner_platform === platform && configuration.owner_id) {
    return configuration.owner_id;
  }
  return null;
};

// Synchronise legacy single-platform owner fields with the new platform-specific columns.
const ensureOwnerColumnsMigrated = async (configuration) => {
  const updates = {};
  for (const platform of OWNER_PLATFORMS) {
    const column = getOwnerColumn(platform);
    if (!configuration[column]) {
      const legacyId = deriveLegacyOwnerId(configuration, platform);
      if (legacyId) {
        updates[column] = legacyId;
      }
    }
  }

  if (Object.keys(updates).length === 0) {
    return;
  }

  logger.info('Migrating legacy owner fields to platform-specific columns.', {
    platforms: Object.keys(updates)
  });
  await configuration.update(updates);
  await configuration.reload();
};

const getRegisteredOwnerId = (configuration, platform) => {
  const column = getOwnerColumn(platform);
  return configuration[column] || deriveLegacyOwnerId(configuration, platform);
};

const parseAdminList = (raw) => {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((value) => String(value)).filter((value) => value.trim().length > 0);
    }
  } catch (error) {
    logger.debug(`Falling back to comma-separated parsing for admin list: ${error.message}`);
  }

  return String(raw)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
};

const serialiseAdminList = (values) => {
  const uniqueValues = Array.from(new Set((values || []).map((value) => String(value).trim()).filter(Boolean)));
  if (uniqueValues.length === 0) {
    return null;
  }
  return JSON.stringify(uniqueValues, null, 2);
};

const parseGroupList = (raw) => {
  if (!raw) {
    return [];
  }

  const trimmed = String(raw).trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((value) => String(value).trim()).filter(Boolean);
      }
    } catch (error) {
      logger.debug(`Falling back to comma-separated parsing for Telegram group list: ${error.message}`);
    }
  }

  return trimmed
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
};

const serialiseGroupList = (values) => {
  const uniqueValues = Array.from(new Set((values || []).map((value) => String(value).trim()).filter(Boolean)));
  if (uniqueValues.length === 0) {
    return null;
  }
  return JSON.stringify(uniqueValues, null, 2);
};

const updateAdminColumn = async (column, mutator) => {
  const configuration = await ensureConfigurationRecord();
  const current = parseAdminList(configuration[column]);
  const updated = mutator([...current]);
  await configuration.update({ [column]: serialiseAdminList(updated) });
  const config = await refreshRuntimeConfig();
  return { values: updated, config };
};

const updateTelegramGroups = async (mutator) => {
  const configuration = await ensureConfigurationRecord();
  const current = parseGroupList(configuration.telegram_group_id);
  const updated = mutator([...current]);
  await configuration.update({ telegram_group_id: serialiseGroupList(updated) });
  const config = await refreshRuntimeConfig();
  return { groupIds: updated, config };
};

export const ensureOwnerPasskey = async () => {
  const configuration = await ensureConfigurationRecord();
  const existing = (configuration.owner_passkey || '').trim();
  if (existing) {
    return {
      passkey: existing,
      created: false,
      generatedAt: configuration.owner_passkey_generated_at || null
    };
  }

  const passkey = generateOwnerPasskey();
  const generatedAt = new Date();
  await configuration.update({
    owner_passkey: passkey,
    owner_passkey_generated_at: generatedAt
  });
  await configuration.reload();
  await refreshRuntimeConfig();
  logger.info('Generated new owner passkey for EKIS bot configuration.');
  return { passkey, created: true, generatedAt };
};

export const rotateOwnerPasskey = async () => {
  const configuration = await ensureConfigurationRecord();
  const passkey = generateOwnerPasskey();
  const generatedAt = new Date();
  await configuration.update({
    owner_passkey: passkey,
    owner_passkey_generated_at: generatedAt
  });
  await configuration.reload();
  await refreshRuntimeConfig();
  logger.info('Owner passkey rotated on demand.');
  return { passkey, generatedAt };
};

export const clearOwnerPasskey = async () => {
  const configuration = await ensureConfigurationRecord();
  await configuration.update({
    owner_passkey: null,
    owner_passkey_generated_at: null
  });
  await configuration.reload();
  await refreshRuntimeConfig();
  logger.warn('Owner passkey cleared from configuration.');
};

export const registerOwner = async ({ platform, userId, passkey }) => {
  const ownerPasskey = normaliseIdentifier(passkey, 'Owner passkey');
  const ownerPlatform = normalisePlatform(platform);
  const ownerId = normaliseIdentifier(userId, 'Owner identifier');

  const configuration = await ensureConfigurationRecord();
  await ensureOwnerColumnsMigrated(configuration);
  const storedPasskey = (configuration.owner_passkey || '').trim();
  if (!storedPasskey) {
    throw new Error('No owner passkey is configured. Restart the service to generate one.');
  }
  if (storedPasskey !== ownerPasskey) {
    throw new Error('Invalid owner passkey provided.');
  }

  const existingOwnerId = getRegisteredOwnerId(configuration, ownerPlatform);
  if (existingOwnerId && existingOwnerId !== ownerId) {
    throw new Error('Ownership is currently bound to a different account for this platform.');
  }

  const updates = {
    [getOwnerColumn(ownerPlatform)]: ownerId,
    owner_registered_at: new Date(),
    owner_id: null,
    owner_platform: null
  };

  await configuration.update(updates);
  await configuration.reload();
  await refreshRuntimeConfig();
  logger.info('Owner registration accepted.', { platform: ownerPlatform, ownerId });
  return {
    ownerIds: {
      telegram: configuration.owner_telegram_id || null,
      discord: configuration.owner_discord_id || null
    },
    registeredAt: configuration.owner_registered_at
  };
};

export const isOwner = async (platform, userId) => {
  const ownerPlatform = normalisePlatform(platform);
  const ownerId = normaliseIdentifier(userId, 'Owner identifier');
  const configuration = await ensureConfigurationRecord();
  await ensureOwnerColumnsMigrated(configuration);
  const registeredOwnerId = getRegisteredOwnerId(configuration, ownerPlatform);
  return Boolean(registeredOwnerId && registeredOwnerId === ownerId);
};

export const requireOwner = async (platform, userId) => {
  const ownerPlatform = normalisePlatform(platform);
  const ownerId = normaliseIdentifier(userId, 'Owner identifier');
  const configuration = await ensureConfigurationRecord();
  await ensureOwnerColumnsMigrated(configuration);
  const registeredOwnerId = getRegisteredOwnerId(configuration, ownerPlatform);
  if (!registeredOwnerId) {
    throw new Error('No owner has been registered for this platform. Submit the owner passkey to claim ownership.');
  }
  if (registeredOwnerId !== ownerId) {
    throw new Error('Only the registered owner may perform this action.');
  }
  return configuration;
};

export const transferOwnership = async ({ currentPlatform, currentUserId, newOwnerId, newOwnerPlatform }) => {
  const platform = normalisePlatform(currentPlatform);
  const currentOwnerId = normaliseIdentifier(currentUserId, 'Current owner identifier');
  const targetOwnerId = normaliseIdentifier(newOwnerId, 'New owner identifier');
  const targetPlatform = newOwnerPlatform ? normalisePlatform(newOwnerPlatform) : platform;

  await requireOwner(platform, currentOwnerId);

  const configuration = await ensureConfigurationRecord();
  await ensureOwnerColumnsMigrated(configuration);
  const passkey = generateOwnerPasskey();
  const generatedAt = new Date();

  const telegramOwnerId = targetPlatform === 'telegram' ? targetOwnerId : null;
  const discordOwnerId = targetPlatform === 'discord' ? targetOwnerId : null;

  await configuration.update({
    owner_id: null,
    owner_platform: null,
    owner_telegram_id: telegramOwnerId,
    owner_discord_id: discordOwnerId,
    owner_passkey: passkey,
    owner_passkey_generated_at: generatedAt,
    owner_registered_at: null
  });

  await configuration.reload();
  await refreshRuntimeConfig();
  logger.info('Ownership transferred to a new account.', {
    fromPlatform: platform,
    fromOwnerId: currentOwnerId,
    toPlatform: targetPlatform,
    toOwnerId: targetOwnerId
  });

  return {
    passkey,
    ownerId: targetOwnerId,
    ownerPlatform: targetPlatform,
    ownerIds: {
      telegram: configuration.owner_telegram_id || null,
      discord: configuration.owner_discord_id || null
    }
  };
};

export const listTelegramAdmins = async () => {
  const configuration = await ensureConfigurationRecord();
  return parseAdminList(configuration.telegram_admins);
};

export const addTelegramAdmin = async (adminId) => {
  const identifier = normaliseIdentifier(adminId, 'Telegram admin identifier');
  const { values, config } = await updateAdminColumn('telegram_admins', (existing) => {
    if (!existing.includes(identifier)) {
      existing.push(identifier);
    }
    return existing;
  });
  logger.info('Telegram admin added via owner command.', { adminId: identifier });
  return { admins: values, config };
};

export const removeTelegramAdmin = async (adminId) => {
  const identifier = normaliseIdentifier(adminId, 'Telegram admin identifier');
  const { values, config } = await updateAdminColumn('telegram_admins', (existing) => existing.filter((id) => id !== identifier));
  logger.info('Telegram admin removed via owner command.', { adminId: identifier });
  return { admins: values, config };
};

export const addTelegramGroup = async ({ groupId, label = null }) => {
  const identifier = normaliseIdentifier(groupId, 'Telegram group identifier');
  const { groupIds, config } = await updateTelegramGroups((existing) => {
    if (!existing.includes(identifier)) {
      existing.push(identifier);
    }
    return existing;
  });
  logger.info('Telegram group linked via setup command.', { groupId: identifier, label });
  return { groupIds, config };
};

export const removeTelegramGroup = async (groupId) => {
  const identifier = normaliseIdentifier(groupId, 'Telegram group identifier');
  const { groupIds, config } = await updateTelegramGroups((existing) => existing.filter((value) => value !== identifier));
  logger.info('Telegram group removed via configuration update.', { groupId: identifier });
  return { groupIds, config };
};

export const listDiscordAdmins = async () => {
  const configuration = await ensureConfigurationRecord();
  return {
    userIds: parseAdminList(configuration.discord_admin_user_ids),
    roleIds: parseAdminList(configuration.discord_admin_role_ids)
  };
};

export const addDiscordAdminUser = async (adminId) => {
  const identifier = normaliseIdentifier(adminId, 'Discord admin user identifier');
  const { values, config } = await updateAdminColumn('discord_admin_user_ids', (existing) => {
    if (!existing.includes(identifier)) {
      existing.push(identifier);
    }
    return existing;
  });
  logger.info('Discord admin user added via owner command.', { adminId: identifier });
  return { userIds: values, config };
};

export const removeDiscordAdminUser = async (adminId) => {
  const identifier = normaliseIdentifier(adminId, 'Discord admin user identifier');
  const { values, config } = await updateAdminColumn('discord_admin_user_ids', (existing) => existing.filter((id) => id !== identifier));
  logger.info('Discord admin user removed via owner command.', { adminId: identifier });
  return { userIds: values, config };
};

export const addDiscordAdminRole = async (roleId) => {
  const identifier = normaliseIdentifier(roleId, 'Discord admin role identifier');
  const { values, config } = await updateAdminColumn('discord_admin_role_ids', (existing) => {
    if (!existing.includes(identifier)) {
      existing.push(identifier);
    }
    return existing;
  });
  logger.info('Discord admin role added via owner command.', { roleId: identifier });
  return { roleIds: values, config };
};

export const removeDiscordAdminRole = async (roleId) => {
  const identifier = normaliseIdentifier(roleId, 'Discord admin role identifier');
  const { values, config } = await updateAdminColumn('discord_admin_role_ids', (existing) => existing.filter((id) => id !== identifier));
  logger.info('Discord admin role removed via owner command.', { roleId: identifier });
  return { roleIds: values, config };
};

export const upsertDiscordGuildConfig = async ({ guildId, verificationChannelId, verifiedRoleId, verifiedRoleName }) => {
  const normaliseValue = (value) => {
    if (!value && value !== 0) {
      return null;
    }
    const stringValue = String(value).trim();
    return stringValue.length ? stringValue : null;
  };

  const guildIdentifier = normaliseIdentifier(guildId, 'Discord guild identifier');

  try {
    const { DiscordConfig } = getModels();
    const [record, created] = await DiscordConfig.findOrCreate({
      where: { guild_id: guildIdentifier },
      defaults: {
        guild_id: guildIdentifier,
        verification_channel_id: normaliseValue(verificationChannelId),
        verified_role_id: normaliseValue(verifiedRoleId),
        verified_role_name: normaliseValue(verifiedRoleName)
      }
    });

    if (!created) {
      await record.update({
        verification_channel_id: normaliseValue(verificationChannelId),
        verified_role_id: normaliseValue(verifiedRoleId),
        verified_role_name: normaliseValue(verifiedRoleName)
      });
    }

    await record.reload();
    const config = await refreshRuntimeConfig();

    logger.info('Discord guild configuration updated.', {
      guildId: guildIdentifier,
      verificationChannelId: record.verification_channel_id || null,
      verifiedRoleId: record.verified_role_id || null,
      created
    });

    return {
      record,
      config
    };
  } catch (error) {
    logger.error(`Failed to update Discord guild configuration for ${guildIdentifier}: ${error.message}`);
    throw error;
  }
};

export const setVolumeCheckEnabled = async (enabled) => {
  if (typeof enabled !== 'boolean') {
    throw new Error('Enabled flag must be a boolean value.');
  }

  try {
    const configuration = await ensureConfigurationRecord();
    await configuration.update({ trading_volume_check_enabled: enabled });
    logger.info(`Trading volume check ${enabled ? 'enabled' : 'disabled'} via configuration update.`);
    return refreshRuntimeConfig();
  } catch (error) {
    logger.error(`Failed to toggle volume check: ${error.message}`);
    throw error;
  }
};

export const setMinimumVolume = async (amount) => {
  const value = parseNumber(amount);
  if (value <= 0) {
    throw new Error('Minimum volume must be greater than zero.');
  }

  try {
    const configuration = await ensureConfigurationRecord();
    await configuration.update({ trading_volume_threshold: value });
    logger.info(`Updated minimum trading volume requirement to ${value}.`);
    return refreshRuntimeConfig();
  } catch (error) {
    logger.error(`Failed to update minimum trading volume: ${error.message}`);
    throw error;
  }
};

export const setDepositThreshold = async (amount) => {
  const value = parseNumber(amount, { allowNull: true });
  if (value !== null && value < 0) {
    throw new Error('Deposit threshold cannot be negative.');
  }

  try {
    const configuration = await ensureConfigurationRecord();
    await configuration.update({ deposit_threshold: value });
    logger.info(value === null
      ? 'Cleared the configured deposit threshold.'
      : `Updated deposit threshold requirement to ${value}.`);
    return refreshRuntimeConfig();
  } catch (error) {
    logger.error(`Failed to update deposit threshold: ${error.message}`);
    throw error;
  }
};

export const setVolumeCheckDays = async (days) => {
  const value = parseNumber(days, { integer: true });
  if (value <= 0) {
    throw new Error('Volume check days must be greater than zero.');
  }

  try {
    const configuration = await ensureConfigurationRecord();
    await configuration.update({ trading_volume_check_days_duration: value });
    logger.info(`Updated rolling volume window to ${value} days.`);
    return refreshRuntimeConfig();
  } catch (error) {
    logger.error(`Failed to update volume check days: ${error.message}`);
    throw error;
  }
};

export const setVolumeWarningEnabled = async (enabled) => {
  if (typeof enabled !== 'boolean') {
    throw new Error('Enabled flag must be a boolean value.');
  }

  try {
    const configuration = await ensureConfigurationRecord();
    await configuration.update({ trading_volume_warning_enabled: enabled });
    logger.info(`Volume warning notifications ${enabled ? 'enabled' : 'disabled'} via configuration update.`);
    return refreshRuntimeConfig();
  } catch (error) {
    logger.error(`Failed to toggle volume warning notifications: ${error.message}`);
    throw error;
  }
};

export const setVolumeWarningDays = async (days) => {
  const value = parseNumber(days, { integer: true });
  if (value <= 0) {
    throw new Error('Warning days must be greater than zero.');
  }

  try {
    const configuration = await ensureConfigurationRecord();
    await configuration.update({ trading_volume_warning_days: value });
    logger.info(`Updated warning lead time to ${value} days.`);
    return refreshRuntimeConfig();
  } catch (error) {
    logger.error(`Failed to update warning days: ${error.message}`);
    throw error;
  }
};

export const setTelegramStartMessage = async (message) => {
  const startMessages = normaliseStartMessages(message);
  const storedValue = serialiseStartMessages(startMessages);

  try {
    const configuration = await ensureConfigurationRecord();
    await configuration.update({ telegram_start_message: storedValue });
    if (startMessages.length) {
      logger.info('Updated Telegram start messages via settings command.', {
        messageCount: startMessages.length,
        preview: startMessages[0].slice(0, 120)
      });
    } else {
      logger.info('Cleared the Telegram start message via settings command.');
    }
    return refreshRuntimeConfig();
  } catch (error) {
    logger.error(`Failed to update Telegram start message: ${error.message}`);
    throw error;
  }
};

export const upsertExchangeCredentials = async (payload) => {
  const name = normaliseExchangeName(payload?.name);
  const type = payload?.type?.trim();
  if (!type) {
    throw new Error('Exchange type is required when adding credentials.');
  }

  try {
    const { Exchange } = getModels();
    const [record, created] = await Exchange.findOrCreate({
      where: { name },
      defaults: {
        name,
        type,
        api_key: payload.apiKey || null,
        api_secret: payload.apiSecret || null,
        passphrase: payload.passphrase || null,
        agent_open_id: payload.agentOpenId || null,
        inviter_uid: payload.inviterUid || null,
        sub_affiliate_invitees: Boolean(payload.subAffiliateInvitees),
        affiliate_link: payload.affiliateLink || null
      }
    });

    if (!created) {
      await record.update({
        type,
        api_key: payload.apiKey || null,
        api_secret: payload.apiSecret || null,
        passphrase: payload.passphrase || null,
        agent_open_id: payload.agentOpenId || null,
        inviter_uid: payload.inviterUid || null,
        sub_affiliate_invitees: Boolean(payload.subAffiliateInvitees),
        affiliate_link: payload.affiliateLink || record.affiliate_link || null
      });
      logger.info(`Updated credentials for exchange ${name}.`);
    } else {
      logger.info(`Created credentials for new exchange ${name}.`);
    }

    return refreshRuntimeConfig();
  } catch (error) {
    logger.error(`Failed to upsert exchange credentials for ${payload?.name}: ${error.message}`);
    throw error;
  }
};

export const removeExchange = async (rawName) => {
  const name = normaliseExchangeName(rawName);

  try {
    const { Exchange } = getModels();
    const removed = await Exchange.destroy({ where: { name } });
    if (!removed) {
      throw new Error(`Exchange ${name} was not found.`);
    }
    logger.info(`Removed exchange credentials for ${name}.`);
    return refreshRuntimeConfig();
  } catch (error) {
    logger.error(`Failed to remove exchange credentials for ${rawName}: ${error.message}`);
    throw error;
  }
};

export const listExchanges = async () => {
  try {
    const { Exchange } = getModels();
    const records = await Exchange.findAll();
    return records.map((record) => ({
      id: record.id,
      name: record.name,
      type: record.type,
      affiliateLink: record.affiliate_link || null
    }));
  } catch (error) {
    logger.error(`Failed to list exchanges: ${error.message}`);
    throw error;
  }
};

export const setExchangeAffiliateLink = async (rawName, link) => {
  const name = normaliseExchangeName(rawName);

  const sanitiseLink = (value) => {
    if (value === null) {
      return null;
    }
    const trimmed = String(value).trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = new URL(trimmed);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Affiliate link must use http or https.');
      }
      return parsed.toString();
    } catch {
      throw new Error('Affiliate link must be a valid URL.');
    }
  };

  const affiliateLink = sanitiseLink(link);

  try {
    const { Exchange } = getModels();
    const record = await Exchange.findOne({ where: { name } });
    if (!record) {
      throw new Error(`Exchange ${name} was not found.`);
    }

    await record.update({ affiliate_link: affiliateLink });
    if (affiliateLink) {
      logger.info(`Set affiliate link for exchange ${name}.`, { affiliateLink });
    } else {
      logger.info(`Cleared affiliate link for exchange ${name}.`);
    }

    return refreshRuntimeConfig();
  } catch (error) {
    logger.error(`Failed to update affiliate link for ${name}: ${error.message}`);
    throw error;
  }
};

export default {
  ensureOwnerPasskey,
  rotateOwnerPasskey,
  clearOwnerPasskey,
  registerOwner,
  isOwner,
  requireOwner,
  transferOwnership,
  listTelegramAdmins,
  addTelegramAdmin,
  removeTelegramAdmin,
  addTelegramGroup,
  removeTelegramGroup,
  listDiscordAdmins,
  addDiscordAdminUser,
  removeDiscordAdminUser,
  addDiscordAdminRole,
  removeDiscordAdminRole,
  upsertDiscordGuildConfig,
  setVolumeCheckEnabled,
  setMinimumVolume,
  setDepositThreshold,
  setVolumeCheckDays,
  setVolumeWarningEnabled,
  setVolumeWarningDays,
  setTelegramStartMessage,
  upsertExchangeCredentials,
  removeExchange,
  listExchanges,
  setExchangeAffiliateLink
};
