import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { getModels } from '../database/index.js';

export const defaultConfig = {
  owner: {
    telegramId: null,
    discordId: null,
    passkey: null,
    passkeyGeneratedAt: null,
    registeredAt: null
  },
  translation: {
    locale: 'en',
    fallbackLocale: 'en'
  },
  discord: {
    enabled: false,
    token: '',
    applicationId: '',
    guildId: '',
    commandPrefix: '!',
    commandName: 'verify',
    settingsCommandName: 'settings',
    statsCommandName: 'stats',
    guilds: [],
    adminUserIds: [],
    adminRoleIds: [],
    ownerCommandName: 'owner',
    ownerId: null
  },
  telegram: {
    enabled: false,
    token: '',
    joinMessage: '',
    admins: [],
    groupId: '',
    groupIds: [],
    ownerId: null
  },
  http: {
    enabled: true,
    port: 3000,
    authToken: ''
  },
  verification: {
    volumeCheckEnabled: true,
    minimumVolume: 1000,
    depositThreshold: null,
    volumeCheckDays: 30,
    volumeWarningEnabled: true,
    volumeWarningDays: 2,
    defaultExchange: 'blofin',
    exchanges: {
      blofin: {
        type: 'blofin',
        volumes: {
          'demo-user': 2500
        }
      }
    }
  }
};

const CONFIG_PATH = path.resolve(process.cwd(), 'config.json');
let cachedConfig = null;

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const deepMerge = (target, source) => {
  const result = { ...target };
  Object.keys(source || {}).forEach((key) => {
    const targetValue = result[key];
    const sourceValue = source[key];
    if (sourceValue === undefined) {
      return;
    }
    if (isObject(targetValue) && isObject(sourceValue)) {
      result[key] = deepMerge(targetValue, sourceValue);
    } else {
      result[key] = sourceValue;
    }
  });
  return result;
};

const parseGroupIds = (rawGroupIds) => {
  if (typeof rawGroupIds === 'undefined' || rawGroupIds === null) {
    return undefined;
  }

  if (Array.isArray(rawGroupIds)) {
    return rawGroupIds.map((value) => String(value).trim()).filter(Boolean);
  }

  const normalised = String(rawGroupIds).trim();
  if (!normalised) {
    return [];
  }

  if (normalised.startsWith('[')) {
    try {
      const parsed = JSON.parse(normalised);
      if (Array.isArray(parsed)) {
        return parsed.map((value) => String(value).trim()).filter(Boolean);
      }
    } catch (error) {
      logger.debug(`Failed to parse group IDs as JSON: ${error.message}`);
    }
  }

  return normalised
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
};

const applyEnvironmentOverrides = (config) => {
  // Support multiple env var names to "generate" discord config from various setups.
  const discordToken = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
  const discordAppId = process.env.DISCORD_APPLICATION_ID || process.env.DISCORD_CLIENT_ID;
  const overrides = {
    translation: {
      locale: process.env.TRANSLATION_LOCALE,
      fallbackLocale: process.env.TRANSLATION_FALLBACK_LOCALE
    },
    discord: {
      token: discordToken,
      applicationId: discordAppId,
      guildId: process.env.DISCORD_GUILD_ID,
      // Allow enabling via env if a token is provided
      enabled: typeof process.env.DISCORD_ENABLED !== 'undefined'
        ? String(process.env.DISCORD_ENABLED).toLowerCase() === 'true'
        : undefined,
      commandPrefix: process.env.DISCORD_COMMAND_PREFIX,
      commandName: process.env.DISCORD_COMMAND_NAME,
      statsCommandName: process.env.DISCORD_STATS_COMMAND_NAME
    },
    telegram: {
      token: process.env.TELEGRAM_BOT_TOKEN,
      joinMessage: process.env.TELEGRAM_JOIN_MESSAGE,
      groupId: process.env.TELEGRAM_GROUP_ID,
      groupIds: parseGroupIds(process.env.TELEGRAM_GROUP_IDS)
    },
    http: {
      port: process.env.HTTP_PORT ? Number(process.env.HTTP_PORT) : undefined,
      authToken: process.env.HTTP_AUTH_TOKEN
    },
    verification: {
      volumeCheckEnabled: typeof process.env.VOLUME_CHECK_ENABLED !== 'undefined'
        ? String(process.env.VOLUME_CHECK_ENABLED).toLowerCase() === 'true'
        : undefined,
      minimumVolume: process.env.VERIFICATION_MIN_VOLUME ? Number(process.env.VERIFICATION_MIN_VOLUME) : undefined,
      defaultExchange: process.env.VERIFICATION_DEFAULT_EXCHANGE,
      depositThreshold: process.env.VERIFICATION_DEPOSIT_THRESHOLD ? Number(process.env.VERIFICATION_DEPOSIT_THRESHOLD) : undefined,
      volumeCheckDays: process.env.VOLUME_CHECK_DAYS ? Number(process.env.VOLUME_CHECK_DAYS) : undefined,
      volumeWarningEnabled: typeof process.env.VOLUME_WARNING_ENABLED !== 'undefined'
        ? String(process.env.VOLUME_WARNING_ENABLED).toLowerCase() === 'true'
        : undefined,
      volumeWarningDays: process.env.VOLUME_WARNING_DAYS ? Number(process.env.VOLUME_WARNING_DAYS) : undefined
    }
  };

  return deepMerge(config, overrides);
};

const validateConfig = (config) => {
  if (!config) {
    throw new Error('Configuration could not be loaded.');
  }

  const { translation, discord, telegram, http, verification } = config;

  if (!translation || typeof translation.locale !== 'string' || !translation.locale.trim()) {
    throw new Error('translation.locale must be a non-empty string.');
  }

  if (typeof translation.fallbackLocale !== 'undefined' && translation.fallbackLocale !== null) {
    if (typeof translation.fallbackLocale !== 'string' || !translation.fallbackLocale.trim()) {
      throw new Error('translation.fallbackLocale must be a non-empty string when specified.');
    }
  }
  if (!discord.enabled && !telegram.enabled && !http.enabled) {
    throw new Error('At least one interface (Discord, Telegram, or HTTP API) must be enabled.');
  }

  if (discord.enabled && !discord.token) {
    throw new Error('Discord token is required when discord.enabled is true.');
  }

  if (telegram.enabled && !telegram.token) {
    throw new Error('Telegram token is required when telegram.enabled is true.');
  }

  if (http.enabled) {
    if (!http.port || Number.isNaN(Number(http.port))) {
      throw new Error('HTTP port must be a valid number when http.enabled is true.');
    }
    if (http.port <= 0 || http.port > 65535) {
      throw new Error('HTTP port must be between 1 and 65535.');
    }
  }

  if (verification.minimumVolume <= 0) {
    throw new Error('verification.minimumVolume must be greater than zero.');
  }

  if (typeof verification.depositThreshold === 'number' && verification.depositThreshold < 0) {
    throw new Error('verification.depositThreshold cannot be negative.');
  }

  if (typeof verification.volumeCheckDays === 'number' && verification.volumeCheckDays <= 0) {
    throw new Error('verification.volumeCheckDays must be greater than zero when specified.');
  }

  if (typeof verification.volumeWarningDays === 'number' && verification.volumeWarningDays <= 0) {
    throw new Error('verification.volumeWarningDays must be greater than zero when specified.');
  }

  if (!verification.defaultExchange || !verification.exchanges[verification.defaultExchange]) {
    throw new Error('verification.defaultExchange must refer to an exchange defined under verification.exchanges.');
  }

  Object.entries(verification.exchanges).forEach(([exchangeId, exchangeConfig]) => {
    if (!exchangeConfig.type) {
      throw new Error(`Exchange "${exchangeId}" is missing a type.`);
    }
    if (exchangeConfig.type === 'rest' && !exchangeConfig.apiBaseUrl) {
      throw new Error(`Exchange "${exchangeId}" requires an apiBaseUrl when using the rest type.`);
    }
    if (exchangeConfig.type === 'mock' && !isObject(exchangeConfig.volumes)) {
      throw new Error(`Exchange "${exchangeId}" must provide a volumes object when using the mock type.`);
    }
  });
};

const parseAdmins = (rawAdmins) => {
  if (!rawAdmins) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawAdmins);
    if (Array.isArray(parsed)) {
      return parsed.filter(Boolean);
    }
  } catch {
    // Ignore JSON parse errors and fall back to comma-separated values.
  }

  return String(rawAdmins)
    .split(',')
    .map((admin) => admin.trim())
    .filter(Boolean);
};

const buildDatabaseOverrides = async () => {
  try {
    const { Configuration, DiscordConfig, Exchange } = getModels();
    const configurationRecord = await Configuration.findOne({
      include: [{ model: DiscordConfig, as: 'discordGuilds' }]
    });

    const exchangeRecords = await Exchange.findAll();

    if (!configurationRecord && exchangeRecords.length === 0) {
      return {};
    }

    const overrides = {};

    if (configurationRecord) {
      const configuration = configurationRecord.get({ plain: true });
      const telegramOwnerId = configuration.owner_telegram_id
        || (configuration.owner_platform === 'telegram' ? configuration.owner_id : null);
      const discordOwnerId = configuration.owner_discord_id
        || (configuration.owner_platform === 'discord' ? configuration.owner_id : null);

      overrides.telegram = {
        enabled: Boolean(configuration.telegram_bot_token),
        token: configuration.telegram_bot_token || '',
        joinMessage: configuration.telegram_join_message || '',
        admins: parseAdmins(configuration.telegram_admins),
        groupId: configuration.telegram_group_id || '',
        groupIds: parseGroupIds(configuration.telegram_group_id),
        ownerId: telegramOwnerId
      };

      overrides.discord = {
        enabled: Boolean(configuration.discord_bot_token),
        token: configuration.discord_bot_token || '',
        adminUserIds: parseAdmins(configuration.discord_admin_user_ids),
        adminRoleIds: parseAdmins(configuration.discord_admin_role_ids),
        ownerId: discordOwnerId
      };

      overrides.verification = {
        volumeCheckEnabled: typeof configuration.trading_volume_check_enabled === 'boolean'
          ? configuration.trading_volume_check_enabled
          : undefined,
        minimumVolume: configuration.trading_volume_threshold || undefined,
        depositThreshold: configuration.deposit_threshold || undefined,
        volumeCheckDays: configuration.trading_volume_check_days_duration || undefined,
        volumeWarningEnabled: typeof configuration.trading_volume_warning_enabled === 'boolean'
          ? configuration.trading_volume_warning_enabled
          : undefined,
        volumeWarningDays: configuration.trading_volume_warning_days || undefined
      };

      overrides.owner = {
        telegramId: telegramOwnerId,
        discordId: discordOwnerId,
        passkey: configuration.owner_passkey || null,
        passkeyGeneratedAt: configuration.owner_passkey_generated_at
          ? new Date(configuration.owner_passkey_generated_at).toISOString()
          : null,
        registeredAt: configuration.owner_registered_at
          ? new Date(configuration.owner_registered_at).toISOString()
          : null
      };

      if (configurationRecord.discordGuilds?.length) {
        overrides.discord = {
          ...overrides.discord,
          guilds: configurationRecord.discordGuilds.map((guild) => ({
            id: guild.guild_id,
            verificationChannelId: guild.verification_channel_id,
            verifiedRoleId: guild.verified_role_id,
            verifiedRoleName: guild.verified_role_name,
            language: guild.language,
            help: guild.help,
            embed: {
              title: guild.embed_title,
              description: guild.embed_description,
              color: guild.embed_color,
              buttonStyle: guild.embed_button_style,
              buttonEmoji: guild.embed_button_emoji,
              image: guild.embed_image
            },
            messageContent: guild.message_content,
            attachment: guild.attachment
          }))
        };
      }
    }

    if (exchangeRecords.length) {
      overrides.verification = overrides.verification || {};
      overrides.verification.exchanges = overrides.verification.exchanges || {};

      const exchangeMap = {};
      for (const exchange of exchangeRecords) {
        const name = exchange.name || `exchange-${exchange.id}`;
        const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || `exchange-${exchange.id}`;
        if (!exchange.type) {
          logger.warn(`Exchange ${name} is missing a type and will be ignored during configuration merge.`);
          continue;
        }
        exchangeMap[key] = {
          id: exchange.id,
          name,
          type: exchange.type,
          apiKey: exchange.api_key,
          apiSecret: exchange.api_secret,
          passphrase: exchange.passphrase,
          agentOpenId: exchange.agent_open_id,
          subAffiliateInvitees: Boolean(exchange.sub_affiliate_invitees),
          inviterUid: exchange.inviter_uid,
          affiliateLink: exchange.affiliate_link || null
        };
      }

      if (Object.keys(exchangeMap).length > 0) {
        overrides.verification.exchanges = exchangeMap;

        if (!overrides.verification.defaultExchange) {
          overrides.verification.defaultExchange = Object.keys(exchangeMap)[0];
        }
      }
    }

    return overrides;
  } catch (error) {
    if (error.message?.includes('not initialised')) {
      logger.debug('Database models not initialised. Falling back to file-based configuration.');
    } else {
      logger.error(`Failed to load configuration from the database: ${error.message}`);
    }
    return {};
  }
};

export const loadConfig = async (configPath = CONFIG_PATH) => {
  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      if (raw.trim().length > 0) {
        fileConfig = JSON.parse(raw);
      }
    } catch (error) {
      logger.error(`Failed to read configuration file: ${error.message}`);
      throw error;
    }
  } else {
    logger.warn(`Configuration file not found at ${configPath}. Using default configuration.`);
  }

  const mergedConfig = deepMerge(defaultConfig, fileConfig);
  const databaseOverrides = await buildDatabaseOverrides();
  const configWithDb = deepMerge(mergedConfig, databaseOverrides);
  const configWithEnv = applyEnvironmentOverrides(configWithDb);
  validateConfig(configWithEnv);
  return configWithEnv;
};

export const getConfig = async () => {
  if (!cachedConfig) {
    cachedConfig = await loadConfig();
  }
  return cachedConfig;
};

export const resetConfigCache = () => {
  cachedConfig = null;
};

export default getConfig;
