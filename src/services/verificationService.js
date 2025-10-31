import logger from '../utils/logger.js';
import { getModels } from '../database/index.js';

export const VERIFIED_USERS_CACHE_KEY = 'verified_users';

export const getVerifiedUsers = async () => {
  const { VerifiedUser } = getModels();
  const verified = {};

  try {
    const dbUsers = await VerifiedUser.findAll();
    for (const user of dbUsers) {
      if (!verified[user.influencer]) {
        verified[user.influencer] = {};
      }

      if (!verified[user.influencer][user.uid]) {
        verified[user.influencer][user.uid] = {
          userId: user.userId,
          telegramId: user.telegramId,
          discordUserId: user.discordUserId,
          guildId: user.guildId,
          verifiedAt: user.verifiedAt,
          volumeWarningDate: user.volumeWarningDate,
          exchange: user.exchange,
          apiKeyId: user.apiKeyId,
          exchangeId: user.exchangeId
        };
      }
    }
  } catch (error) {
    logger.error(`Error retrieving verified users from the database: ${error.message}`);
  }

  return verified;
};

export class VerifiedUserConflictError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'VerifiedUserConflictError';
    this.code = 'VERIFICATION_CONFLICT';
    this.context = context;
  }
}

const hasIdentityConflict = (existing, data) => {
  if (!existing) {
    return false;
  }

  const conflicts = [];

  if (data.userId && existing.userId && String(existing.userId) !== String(data.userId)) {
    conflicts.push('userId');
  }

  if (data.discordUserId && existing.discordUserId && String(existing.discordUserId) !== String(data.discordUserId)) {
    conflicts.push('discordUserId');
  }

  if (data.telegramId && existing.telegramId && String(existing.telegramId) !== String(data.telegramId)) {
    conflicts.push('telegramId');
  }

  return conflicts.length ? conflicts : false;
};

export const saveVerifiedUser = async (influencer, uid, data) => {
  const { VerifiedUser } = getModels();

  try {
    const existingRecord = await VerifiedUser.findOne({ where: { influencer, uid } });

    if (existingRecord) {
      const conflicts = hasIdentityConflict(existingRecord, data);
      if (conflicts) {
        logger.warn(
          `Attempt to overwrite verified UID ${uid} for ${influencer} blocked due to conflicting identity fields: ${conflicts.join(', ')}`,
          {
            influencer,
            uid,
            conflicts,
            existingUserId: existingRecord.userId,
            existingDiscordUserId: existingRecord.discordUserId,
            existingTelegramId: existingRecord.telegramId
          }
        );
        throw new VerifiedUserConflictError('This UID has already been verified by another account.', {
          influencer,
          uid,
          conflicts
        });
      }

      const updatePayload = {
        exchange: data.exchange ?? existingRecord.exchange,
        exchangeId: data.exchangeId ?? existingRecord.exchangeId,
        apiKeyId: data.apiKeyId ?? existingRecord.apiKeyId,
        guildId: data.guildId ?? existingRecord.guildId,
        volumeWarningDate: data.volumeWarningDate ?? existingRecord.volumeWarningDate
      };

      if (!existingRecord.userId && data.userId) {
        updatePayload.userId = data.userId;
      }
      if (!existingRecord.discordUserId && data.discordUserId) {
        updatePayload.discordUserId = data.discordUserId;
      }
      if (!existingRecord.telegramId && data.telegramId) {
        updatePayload.telegramId = data.telegramId;
      }

      if (Object.keys(updatePayload).length) {
        updatePayload.verifiedAt = existingRecord.verifiedAt || Date.now();
        await existingRecord.update(updatePayload);
        logger.info(`Updated verified UID ${uid} for ${influencer} with additional metadata without altering identity fields.`);
      }

      return existingRecord;
    }

    const payload = {
      influencer,
      uid,
      exchange: data.exchange || null,
      exchangeId: data.exchangeId || null,
      apiKeyId: data.apiKeyId || null,
      userId: data.userId || null,
      telegramId: data.telegramId || null,
      discordUserId: data.discordUserId || null,
      guildId: data.guildId || null,
      verifiedAt: Date.now(),
      volumeWarningDate: data.volumeWarningDate || null
    };

    await VerifiedUser.create(payload);
    logger.info(`Created new verified UID ${uid} for ${influencer}.`, {
      influencer,
      uid,
      userId: payload.userId,
      discordUserId: payload.discordUserId,
      telegramId: payload.telegramId
    });
    return payload;
  } catch (error) {
    if (error instanceof VerifiedUserConflictError) {
      throw error;
    }

    // A SequelizeUniqueConstraintError is wrapped in a generic ValidationError message.
    // When this happens we attempt to look up the existing record so we can
    // return it (if the identity information matches) or raise a conflict error.
    if (error?.name === 'SequelizeUniqueConstraintError') {
      try {
        const existingRecord = await VerifiedUser.findOne({ where: { influencer, uid } });

        if (existingRecord) {
          const conflicts = hasIdentityConflict(existingRecord, data);
          if (conflicts) {
            logger.warn(
              `Unique constraint violation detected for verified UID ${uid} belonging to ${influencer} with conflicting identity fields: ${conflicts.join(', ')}`,
              {
                influencer,
                uid,
                conflicts,
                existingUserId: existingRecord.userId,
                existingDiscordUserId: existingRecord.discordUserId,
                existingTelegramId: existingRecord.telegramId
              }
            );
            throw new VerifiedUserConflictError('This UID has already been verified by another account.', {
              influencer,
              uid,
              conflicts
            });
          }

          logger.info(
            `Verified UID ${uid} for ${influencer} already exists. Returning persisted record after unique constraint violation.`,
            {
              influencer,
              uid,
              userId: existingRecord.userId,
              discordUserId: existingRecord.discordUserId,
              telegramId: existingRecord.telegramId
            }
          );
          return existingRecord;
        }
      } catch (lookupError) {
        logger.error(
          `Failed to resolve verified user after unique constraint violation for UID ${uid} on ${influencer}: ${lookupError.message}`
        );
      }
    }

    logger.error(`Error saving verified user to the database: ${error.message}`);
    throw error;
  }
};

export const isUserVerified = async (influencer, identifiers) => {
  const { VerifiedUser } = getModels();

  const where = { influencer };
  if (identifiers.telegramId) {
    where.telegramId = String(identifiers.telegramId);
  }
  if (identifiers.discordUserId) {
    where.discordUserId = String(identifiers.discordUserId);
  }

  try {
    const record = await VerifiedUser.findOne({ where });
    return Boolean(record);
  } catch (error) {
    logger.error(`Error checking verification state for influencer ${influencer}: ${error.message}`);
    throw error;
  }
};

export const removeVerifiedUser = async (influencer, uid) => {
  const { VerifiedUser } = getModels();

  try {
    const removed = await VerifiedUser.destroy({ where: { influencer, uid } });

    if (removed) {
      logger.info(`Removed verified UID ${uid} for influencer ${influencer} from the database.`);
    } else {
      logger.warn(`Attempted to remove UID ${uid} for influencer ${influencer}, but no record was found.`);
    }

    return removed;
  } catch (error) {
    logger.error(`Error removing verified user ${uid} for influencer ${influencer}: ${error.message}`);
    throw error;
  }
};

export default {
  getVerifiedUsers,
  saveVerifiedUser,
  isUserVerified,
  removeVerifiedUser,
  VerifiedUserConflictError
};
