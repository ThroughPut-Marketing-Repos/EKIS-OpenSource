import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Sequelize, DataTypes } from 'sequelize';
import logger from '../utils/logger.js';
import { removeDuplicateVerifiedUsers, removeOrphanedForeignKeys } from './maintenance.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let sequelizeInstance = null;
let initialized = false;

const Models = {};

const ensureStorageDirectory = (storagePath) => {
  if (!storagePath) {
    return;
  }

  const dir = path.dirname(storagePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

// Builds a Sequelize instance based on either DATABASE_URL, explicit connection parameters, or
// an on-disk SQLite database for local development and tests.
const buildSequelize = () => {
  if (sequelizeInstance) {
    return sequelizeInstance;
  }

  if (process.env.DATABASE_URL) {
    sequelizeInstance = new Sequelize(process.env.DATABASE_URL, {
      logging: (msg) => logger.debug(msg)
    });
    return sequelizeInstance;
  }

  const dialect = process.env.DB_DIALECT || 'sqlite';
  if (dialect === 'sqlite') {
    const storage = process.env.DB_STORAGE || path.resolve(__dirname, '../../data/database.sqlite');
    ensureStorageDirectory(storage);
    sequelizeInstance = new Sequelize({
      dialect: 'sqlite',
      storage,
      logging: (msg) => logger.debug(msg)
    });
    return sequelizeInstance;
  }

  sequelizeInstance = new Sequelize(
    process.env.DB_NAME || 'ekisbot',
    process.env.DB_USERNAME || 'ekisbot',
    process.env.DB_PASSWORD || '',
    {
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
      dialect,
      logging: (msg) => logger.debug(msg)
    }
  );

  return sequelizeInstance;
};

// Defines all ORM models used by the application. Associations are declared at the bottom to
// avoid relying on declaration order elsewhere in the codebase.
const defineModels = (sequelize) => {
  Models.ApiKey = sequelize.define('ApiKey', {
    api_key_hash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true
    },
    name: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'Default API Key'
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    last_used_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    expires_at: {
      type: DataTypes.DATE,
      allowNull: true
    }
  }, {
    tableName: 'api_keys'
  });

  Models.Configuration = sequelize.define('Configuration', {
    telegram_bot_token: DataTypes.STRING,
    telegram_start_message: DataTypes.TEXT,
    telegram_join_message: DataTypes.TEXT,
    telegram_admins: DataTypes.TEXT,
    discord_bot_token: DataTypes.STRING,
    discord_admin_user_ids: DataTypes.TEXT,
    discord_admin_role_ids: DataTypes.TEXT,
    trading_volume_threshold: DataTypes.FLOAT,
    trading_volume_check_days_duration: DataTypes.INTEGER,
    trading_volume_check_enabled: DataTypes.BOOLEAN,
    trading_volume_warning_enabled: DataTypes.BOOLEAN,
    trading_volume_warning_days: DataTypes.INTEGER,
    deposit_threshold: DataTypes.FLOAT,
    telegram_group_id: DataTypes.STRING,
    owner_platform: DataTypes.STRING,
    owner_id: DataTypes.STRING,
    owner_telegram_id: DataTypes.STRING,
    owner_discord_id: DataTypes.STRING,
    owner_passkey: DataTypes.STRING,
    owner_passkey_generated_at: DataTypes.DATE,
    owner_registered_at: DataTypes.DATE
  }, {
    tableName: 'configurations'
  });

  Models.DiscordConfig = sequelize.define('DiscordConfig', {
    guild_id: DataTypes.STRING,
    verification_channel_id: DataTypes.STRING,
    verified_role_id: DataTypes.STRING,
    verified_role_name: DataTypes.STRING,
    language: DataTypes.STRING,
    help: DataTypes.TEXT,
    embed_title: DataTypes.STRING,
    embed_description: DataTypes.TEXT,
    embed_color: DataTypes.STRING,
    embed_button_style: DataTypes.STRING,
    embed_button_emoji: DataTypes.STRING,
    message_content: DataTypes.TEXT,
    embed_image: DataTypes.STRING,
    attachment: DataTypes.STRING
  }, {
    tableName: 'discord_configs'
  });

  Models.Exchange = sequelize.define('Exchange', {
    type: DataTypes.STRING,
    name: DataTypes.STRING,
    api_key: DataTypes.STRING,
    api_secret: DataTypes.STRING,
    passphrase: DataTypes.STRING,
    agent_open_id: DataTypes.STRING,
    sub_affiliate_invitees: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    inviter_uid: DataTypes.STRING,
    affiliate_link: {
      type: DataTypes.STRING,
      allowNull: true
    }
  }, {
    tableName: 'exchanges'
  });

  Models.VerifiedUser = sequelize.define('VerifiedUser', {
    influencer: {
      type: DataTypes.STRING,
      allowNull: false
    },
    uid: {
      type: DataTypes.STRING,
      allowNull: false
    },
    exchange: {
      type: DataTypes.STRING,
      allowNull: true
    },
    exchangeId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: Models.Exchange,
        key: 'id'
      }
    },
    apiKeyId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: Models.ApiKey,
        key: 'id'
      }
    },
    userId: DataTypes.INTEGER,
    telegramId: DataTypes.STRING,
    discordUserId: DataTypes.STRING,
    guildId: DataTypes.STRING,
    verifiedAt: DataTypes.BIGINT,
    volumeWarningDate: DataTypes.STRING
  }, {
    tableName: 'verified_users',
    indexes: [
      {
        unique: true,
        fields: ['influencer', 'uid']
      },
      {
        fields: ['telegramId']
      },
      {
        fields: ['discordUserId']
      }
    ]
  });

  Models.VolumeSnapshot = sequelize.define('VolumeSnapshot', {
    uid: {
      type: DataTypes.STRING,
      allowNull: false
    },
    exchange: {
      type: DataTypes.STRING,
      allowNull: false
    },
    exchangeId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: Models.Exchange,
        key: 'id'
      }
    },
    kolName: {
      type: DataTypes.STRING,
      allowNull: true
    },
    totalVolume: {
      type: DataTypes.DECIMAL(30, 8),
      allowNull: false,
      defaultValue: 0
    },
    depositAmount: {
      type: DataTypes.DECIMAL(30, 8),
      allowNull: true,
      defaultValue: 0
    }
  }, {
    tableName: 'volume_snapshots',
    indexes: [
      {
        fields: ['uid', 'exchange']
      }
    ]
  });

  Models.Configuration.hasMany(Models.DiscordConfig, { foreignKey: 'configurationId', as: 'discordGuilds' });
  Models.DiscordConfig.belongsTo(Models.Configuration, { foreignKey: 'configurationId', as: 'configuration' });

  Models.Exchange.hasMany(Models.VolumeSnapshot, { foreignKey: 'exchangeId', as: 'volumeSnapshots' });
  Models.VolumeSnapshot.belongsTo(Models.Exchange, { foreignKey: 'exchangeId', as: 'exchangeRef' });

  Models.Exchange.hasMany(Models.VerifiedUser, { foreignKey: 'exchangeId', as: 'verifiedUsers' });
  Models.VerifiedUser.belongsTo(Models.Exchange, { foreignKey: 'exchangeId', as: 'exchangeRef' });

  Models.ApiKey.hasMany(Models.VerifiedUser, { foreignKey: 'apiKeyId', as: 'verifiedUsers' });
  Models.VerifiedUser.belongsTo(Models.ApiKey, { foreignKey: 'apiKeyId', as: 'apiKey' });
};

export const initializeDatabase = async () => {
  if (initialized) {
    return { sequelize: sequelizeInstance, Models };
  }

  const sequelize = buildSequelize();

  try {
    await sequelize.authenticate();
    logger.info('Database connection established successfully.');
  } catch (error) {
    logger.error(`Failed to connect to the database: ${error.message}`);
    throw error;
  }

  defineModels(sequelize);

  // Clean up historical duplicate rows before enforcing the unique constraint.
  await removeDuplicateVerifiedUsers(sequelize, Models.VerifiedUser);
  await removeOrphanedForeignKeys(sequelize, {
    VerifiedUser: Models.VerifiedUser,
    VolumeSnapshot: Models.VolumeSnapshot
  });

  await sequelize.sync({ alter: true });
  initialized = true;
  return { sequelize, Models };
};

export const getSequelize = () => {
  if (!sequelizeInstance) {
    throw new Error('Database has not been initialised. Call initializeDatabase() first.');
  }
  return sequelizeInstance;
};

export const getModels = () => {
  if (!initialized) {
    throw new Error('Database models are not initialised. Call initializeDatabase() first.');
  }
  return Models;
};

export default initializeDatabase;
