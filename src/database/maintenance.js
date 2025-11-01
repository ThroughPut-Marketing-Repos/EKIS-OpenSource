import { QueryTypes, Op } from 'sequelize';
import logger from '../utils/logger.js';

const TABLE_NAME = 'verified_users';
const MERGE_FIELDS = [
  'exchange',
  'exchangeId',
  'apiKeyId',
  'userId',
  'telegramId',
  'discordUserId',
  'guildId',
  'volumeWarningDate'
];

const hasMeaningfulValue = (value) => {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  return true;
};

const parseTimestamp = (value) => {
  if (!value) {
    return 0;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
};

const scoreRecord = (record) => {
  let score = 0;
  if (hasMeaningfulValue(record.telegramId)) {
    score += 4;
  }
  if (hasMeaningfulValue(record.discordUserId)) {
    score += 4;
  }
  if (hasMeaningfulValue(record.userId)) {
    score += 2;
  }
  if (hasMeaningfulValue(record.exchangeId)) {
    score += 1;
  }
  if (hasMeaningfulValue(record.apiKeyId)) {
    score += 1;
  }
  if (hasMeaningfulValue(record.guildId)) {
    score += 1;
  }
  if (hasMeaningfulValue(record.verifiedAt)) {
    score += 1;
  }
  score += parseTimestamp(record.updatedAt) / 1000;
  score += Number(record.id) || 0;
  return score;
};

const normaliseTableNames = (tables) => tables.map((table) => {
  if (typeof table === 'string') {
    return table;
  }
  if (table && typeof table === 'object') {
    return table.tableName || table.name || String(table);
  }
  return String(table);
});

const selectDuplicateGroups = async (sequelize) => {
  return sequelize.query(
    `SELECT influencer, uid FROM ${TABLE_NAME} GROUP BY influencer, uid HAVING COUNT(*) > 1`,
    { type: QueryTypes.SELECT }
  );
};

const loadGroupRecords = async (sequelize, influencer, uid) => {
  return sequelize.query(
    `SELECT id, influencer, uid, exchange, exchangeId, apiKeyId, userId, telegramId, discordUserId, guildId, verifiedAt, volumeWarningDate, createdAt, updatedAt
     FROM ${TABLE_NAME}
     WHERE influencer = :influencer AND uid = :uid`,
    {
      type: QueryTypes.SELECT,
      replacements: { influencer, uid }
    }
  );
};

const mergeRecords = (records) => {
  const sorted = [...records].sort((a, b) => scoreRecord(b) - scoreRecord(a));
  const originalKeeper = sorted[0];
  const keeper = { ...originalKeeper };
  const duplicates = sorted.slice(1);

  for (const record of duplicates) {
    for (const field of MERGE_FIELDS) {
      if (!hasMeaningfulValue(keeper[field]) && hasMeaningfulValue(record[field])) {
        keeper[field] = record[field];
      }
    }

    if (hasMeaningfulValue(record.verifiedAt)) {
      const current = hasMeaningfulValue(keeper.verifiedAt) ? Number(keeper.verifiedAt) : null;
      const candidate = Number(record.verifiedAt);
      if (current === null || (Number.isFinite(candidate) && candidate > current)) {
        keeper.verifiedAt = record.verifiedAt;
      }
    }
  }

  return { keeper, originalKeeper, duplicates };
};

/**
 * Removes duplicate verified user records prior to schema synchronisation so the
 * unique (influencer, uid) constraint can be enforced without failing startup.
 *
 * When duplicates are detected we pick the record with the richest identity
 * information, merge any additional details from the extra rows, update the
 * keeper if needed, and delete the redundant entries.
 */
export const removeDuplicateVerifiedUsers = async (sequelize, VerifiedUserModel) => {
  const queryInterface = sequelize.getQueryInterface();
  const tables = normaliseTableNames(await queryInterface.showAllTables());

  if (!tables.includes(TABLE_NAME)) {
    logger.debug('Verified users table not found; skipping duplicate cleanup.');
    return { removed: 0, updated: 0 };
  }

  if (!VerifiedUserModel) {
    logger.warn('VerifiedUser model unavailable; cannot perform duplicate cleanup.');
    return { removed: 0, updated: 0 };
  }

  const duplicateGroups = await selectDuplicateGroups(sequelize);
  if (duplicateGroups.length === 0) {
    logger.debug('No duplicate verified user records detected.');
    return { removed: 0, updated: 0 };
  }

  let removed = 0;
  let updated = 0;

  for (const { influencer, uid } of duplicateGroups) {
    const records = await loadGroupRecords(sequelize, influencer, uid);
    if (records.length <= 1) {
      continue;
    }

    const { keeper, originalKeeper, duplicates } = mergeRecords(records);
    const idsToDelete = duplicates.map(({ id }) => id).filter(Boolean);
    const updates = {};

    for (const field of [...MERGE_FIELDS, 'verifiedAt']) {
      if (keeper[field] !== undefined && keeper[field] !== originalKeeper[field]) {
        updates[field] = keeper[field];
      }
    }

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date();
      await VerifiedUserModel.update(updates, { where: { id: keeper.id } });
      updated += 1;
    }

    if (idsToDelete.length > 0) {
      await VerifiedUserModel.destroy({ where: { id: { [Op.in]: idsToDelete } } });
      removed += idsToDelete.length;
      logger.warn('Removed duplicate verified user entries to enforce uniqueness.', {
        influencer,
        uid,
        keptId: keeper.id,
        removedIds: idsToDelete
      });
    }
  }

  logger.info('Duplicate verified user cleanup completed.', { removedRecords: removed, updatedRecords: updated });
  return { removed, updated };
};

export default removeDuplicateVerifiedUsers;
