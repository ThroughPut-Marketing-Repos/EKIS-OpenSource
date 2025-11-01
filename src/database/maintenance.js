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

const tableExists = (tables, tableName) => normaliseTableNames(tables).includes(tableName);

const summariseIds = (ids) => {
  if (ids.length <= 10) {
    return ids;
  }
  return `${ids.slice(0, 10).join(', ')}… (+${ids.length - 10} more)`;
};

const selectDuplicateGroups = async (sequelize) => {
  return sequelize.query(
    `SELECT influencer, uid FROM ${TABLE_NAME} GROUP BY influencer, uid HAVING COUNT(*) > 1`,
    { type: QueryTypes.SELECT }
  );
};

const loadGroupRecords = async (sequelize, influencer, uid) => {
  const conditions = [];
  const replacements = {};

  if (influencer === null || influencer === undefined) {
    conditions.push('influencer IS NULL');
  } else {
    conditions.push('influencer = :influencer');
    replacements.influencer = influencer;
  }

  if (uid === null || uid === undefined) {
    conditions.push('uid IS NULL');
  } else {
    conditions.push('uid = :uid');
    replacements.uid = uid;
  }

  const whereClause = conditions.join(' AND ');

  return sequelize.query(
    `SELECT id, influencer, uid, exchange, exchangeId, apiKeyId, userId, telegramId, discordUserId, guildId, verifiedAt, volumeWarningDate, createdAt, updatedAt
     FROM ${TABLE_NAME}
     WHERE ${whereClause}`,
    {
      type: QueryTypes.SELECT,
      replacements
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
  const tables = await queryInterface.showAllTables();

  if (!tableExists(tables, TABLE_NAME)) {
    logger.debug('Verified users table not found; skipping duplicate cleanup.');
    return { removed: 0, updated: 0 };
  }

  if (!VerifiedUserModel) {
    logger.warn('VerifiedUser model unavailable; cannot perform duplicate cleanup.');
    return { removed: 0, updated: 0 };
  }

  let removed = 0;
  let updated = 0;

  // Records missing either part of the composite key cannot satisfy the upcoming
  // NOT NULL + UNIQUE constraint, so purge them up-front before attempting to
  // merge richer duplicates. This mirrors the production fix where legacy rows
  // with NULL keys must be eliminated entirely.
  const orphanedRecords = await VerifiedUserModel.findAll({
    where: {
      [Op.or]: [
        { influencer: null },
        { uid: null }
      ]
    },
    attributes: ['id', 'influencer', 'uid'],
    raw: true
  });

  if (orphanedRecords.length > 0) {
    const orphanedIds = orphanedRecords.map(({ id }) => id).filter(Boolean);
    if (orphanedIds.length > 0) {
      await VerifiedUserModel.destroy({ where: { id: { [Op.in]: orphanedIds } } });
      removed += orphanedIds.length;
      logger.warn('Removed verified user entries missing influencer or uid keys prior to duplicate cleanup.', {
        removedIds: orphanedIds
      });
    }
  }

  const duplicateGroups = await selectDuplicateGroups(sequelize);
  if (duplicateGroups.length === 0) {
    logger.debug('No duplicate verified user records detected.');
  } else {
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
  }

  logger.info('Duplicate verified user cleanup completed.', { removedRecords: removed, updatedRecords: updated });
  return { removed, updated };
};

// Clears foreign key values that reference non-existent exchanges or API keys so schema sync
// migrations can safely apply constraints after operators prune related tables manually.
export const removeOrphanedForeignKeys = async (sequelize, models = {}) => {
  const queryInterface = sequelize.getQueryInterface();
  const tables = await queryInterface.showAllTables();

  const results = {
    verifiedUsers: {
      clearedExchangeIds: 0,
      clearedApiKeyIds: 0
    },
    volumeSnapshots: {
      clearedExchangeIds: 0
    }
  };

  const verifiedUsersTableExists = tableExists(tables, TABLE_NAME);
  const exchangesTableExists = tableExists(tables, 'exchanges');
  const apiKeysTableExists = tableExists(tables, 'api_keys');

  const { VerifiedUser, VolumeSnapshot } = models;

  if (!verifiedUsersTableExists) {
    logger.debug('Verified users table not found; skipping verified user foreign key cleanup.');
  }

  if (verifiedUsersTableExists && !VerifiedUser) {
    logger.warn('VerifiedUser model unavailable; cannot repair foreign key references.');
  }

  if (verifiedUsersTableExists && VerifiedUser && exchangesTableExists) {
    const orphanedExchangeRefs = await sequelize.query(
      `SELECT vu.id FROM ${TABLE_NAME} vu
       LEFT JOIN exchanges e ON vu.exchangeId = e.id
       WHERE vu.exchangeId IS NOT NULL AND e.id IS NULL`,
      { type: QueryTypes.SELECT }
    );

    if (orphanedExchangeRefs.length > 0) {
      const ids = orphanedExchangeRefs.map(({ id }) => id).filter(Boolean);
      if (ids.length > 0) {
        await VerifiedUser.update({ exchangeId: null }, { where: { id: { [Op.in]: ids } } });
        results.verifiedUsers.clearedExchangeIds = ids.length;
        logger.warn('Cleared verified user exchange references pointing to missing exchanges.', {
          affectedIds: summariseIds(ids)
        });
      }
    }
  }

  if (verifiedUsersTableExists && VerifiedUser && apiKeysTableExists) {
    const orphanedApiKeyRefs = await sequelize.query(
      `SELECT vu.id FROM ${TABLE_NAME} vu
       LEFT JOIN api_keys ak ON vu.apiKeyId = ak.id
       WHERE vu.apiKeyId IS NOT NULL AND ak.id IS NULL`,
      { type: QueryTypes.SELECT }
    );

    if (orphanedApiKeyRefs.length > 0) {
      const ids = orphanedApiKeyRefs.map(({ id }) => id).filter(Boolean);
      if (ids.length > 0) {
        await VerifiedUser.update({ apiKeyId: null }, { where: { id: { [Op.in]: ids } } });
        results.verifiedUsers.clearedApiKeyIds = ids.length;
        logger.warn('Cleared verified user API key references pointing to missing records.', {
          affectedIds: summariseIds(ids)
        });
      }
    }
  }

  if (VolumeSnapshot && tableExists(tables, 'volume_snapshots') && exchangesTableExists) {
    const orphanedVolumeSnapshots = await sequelize.query(
      `SELECT vs.id FROM volume_snapshots vs
       LEFT JOIN exchanges e ON vs.exchangeId = e.id
       WHERE vs.exchangeId IS NOT NULL AND e.id IS NULL`,
      { type: QueryTypes.SELECT }
    );

    if (orphanedVolumeSnapshots.length > 0) {
      const ids = orphanedVolumeSnapshots.map(({ id }) => id).filter(Boolean);
      if (ids.length > 0) {
        await VolumeSnapshot.update({ exchangeId: null }, { where: { id: { [Op.in]: ids } } });
        results.volumeSnapshots.clearedExchangeIds = ids.length;
        logger.warn('Cleared volume snapshot exchange references pointing to missing exchanges.', {
          affectedIds: summariseIds(ids)
        });
      }
    }
  }

  if (
    results.verifiedUsers.clearedExchangeIds === 0
    && results.verifiedUsers.clearedApiKeyIds === 0
    && results.volumeSnapshots.clearedExchangeIds === 0
  ) {
    logger.debug('No orphaned foreign key references detected during startup maintenance.');
  } else {
    logger.info('Completed orphaned foreign key cleanup for verified users and volume snapshots.', results);
  }

  return results;
};

export default removeDuplicateVerifiedUsers;
