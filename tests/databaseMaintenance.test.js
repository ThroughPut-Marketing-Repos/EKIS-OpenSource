import { Sequelize, DataTypes, QueryTypes } from 'sequelize';
import { removeDuplicateVerifiedUsers, removeOrphanedForeignKeys } from '../src/database/maintenance.js';

describe('removeDuplicateVerifiedUsers', () => {
  let sequelize;
  let VerifiedUser;

  const buildModel = () => {
    VerifiedUser = sequelize.define('VerifiedUser', {
      influencer: { type: DataTypes.STRING, allowNull: false },
      uid: { type: DataTypes.STRING, allowNull: false },
      exchange: DataTypes.STRING,
      exchangeId: DataTypes.INTEGER,
      apiKeyId: DataTypes.INTEGER,
      userId: DataTypes.INTEGER,
      telegramId: DataTypes.STRING,
      discordUserId: DataTypes.STRING,
      guildId: DataTypes.STRING,
      verifiedAt: DataTypes.BIGINT,
      volumeWarningDate: DataTypes.STRING
    }, {
      tableName: 'verified_users'
    });
  };

  beforeEach(() => {
    sequelize = new Sequelize('sqlite::memory:', { logging: false });
    buildModel();
  });

  afterEach(async () => {
    await sequelize.close();
  });

  it('skips cleanup when the table has not been created', async () => {
    const result = await removeDuplicateVerifiedUsers(sequelize, VerifiedUser);
    expect(result).toEqual({ removed: 0, updated: 0 });
  });

  it('removes duplicate rows and merges identity metadata', async () => {
    await sequelize.sync();

    await VerifiedUser.create({
      influencer: 'alice',
      uid: '1',
      telegramId: 'tg-001',
      verifiedAt: 1000
    });

    await VerifiedUser.create({
      influencer: 'alice',
      uid: '1',
      discordUserId: 'disc-001',
      verifiedAt: 2000
    });

    await VerifiedUser.create({
      influencer: 'alice',
      uid: '1',
      userId: 42
    });

    const result = await removeDuplicateVerifiedUsers(sequelize, VerifiedUser);

    expect(result.removed).toBe(2);
    expect(result.updated).toBe(1);

    const remaining = await VerifiedUser.findAll({
      where: { influencer: 'alice', uid: '1' },
      raw: true
    });

    expect(remaining).toHaveLength(1);
    expect(remaining[0].telegramId).toBe('tg-001');
    expect(remaining[0].discordUserId).toBe('disc-001');
    expect(remaining[0].userId).toBe(42);
    expect(Number(remaining[0].verifiedAt)).toBe(2000);
  });

  it('reports no changes when duplicates are absent', async () => {
    await sequelize.sync();

    await VerifiedUser.create({
      influencer: 'bob',
      uid: '1',
      telegramId: 'tg-999'
    });

    const result = await removeDuplicateVerifiedUsers(sequelize, VerifiedUser);
    expect(result).toEqual({ removed: 0, updated: 0 });
  });

  it('handles legacy VerifiedUsers table names by retargeting the model', async () => {
    const queryInterface = sequelize.getQueryInterface();

    await queryInterface.createTable('VerifiedUsers', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      influencer: { type: DataTypes.STRING },
      uid: { type: DataTypes.STRING },
      exchange: { type: DataTypes.STRING },
      exchangeId: { type: DataTypes.INTEGER },
      apiKeyId: { type: DataTypes.INTEGER },
      userId: { type: DataTypes.INTEGER },
      telegramId: { type: DataTypes.STRING },
      discordUserId: { type: DataTypes.STRING },
      guildId: { type: DataTypes.STRING },
      verifiedAt: { type: DataTypes.BIGINT },
      createdAt: { type: DataTypes.DATE },
      updatedAt: { type: DataTypes.DATE },
      volumeWarningDate: { type: DataTypes.STRING }
    });

    const baseTimestamp = new Date('2024-01-01T00:00:00Z');

    await queryInterface.bulkInsert('VerifiedUsers', [
      {
        influencer: 'casey',
        uid: 'legacy-1',
        telegramId: 'tg-casey',
        verifiedAt: 1000,
        createdAt: baseTimestamp,
        updatedAt: baseTimestamp
      },
      {
        influencer: 'casey',
        uid: 'legacy-1',
        discordUserId: 'disc-casey',
        verifiedAt: 5000,
        createdAt: baseTimestamp,
        updatedAt: new Date('2024-01-02T00:00:00Z')
      }
    ]);

    const result = await removeDuplicateVerifiedUsers(sequelize, VerifiedUser);

    expect(result.removed).toBe(1);
    expect(result.updated).toBe(1);
    expect(VerifiedUser.options.tableName).toBe('verified_users');

    const remaining = await sequelize.query(
      'SELECT influencer, uid, telegramId, discordUserId, verifiedAt FROM "VerifiedUsers"',
      { type: QueryTypes.SELECT }
    );

    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      influencer: 'casey',
      uid: 'legacy-1',
      telegramId: 'tg-casey',
      discordUserId: 'disc-casey'
    });
    expect(Number(remaining[0].verifiedAt)).toBe(5000);
  });

  it('purges duplicate rows that contain NULL influencer or uid keys', async () => {
    const nullableSequelize = new Sequelize('sqlite::memory:', { logging: false });
    const NullableVerifiedUser = nullableSequelize.define('VerifiedUserNullable', {
      influencer: { type: DataTypes.STRING, allowNull: true },
      uid: { type: DataTypes.STRING, allowNull: true },
      telegramId: DataTypes.STRING
    }, {
      tableName: 'verified_users'
    });

    try {
      await nullableSequelize.sync();

      await NullableVerifiedUser.bulkCreate([
        { influencer: null, uid: null, telegramId: 'tg-null-1' },
        { influencer: null, uid: null, telegramId: 'tg-null-2' },
        { influencer: null, uid: 'ghost', telegramId: 'tg-null-3' }
      ], { validate: false });

      const result = await removeDuplicateVerifiedUsers(nullableSequelize, NullableVerifiedUser);

      expect(result.removed).toBe(3);
      expect(result.updated).toBe(0);

      const remaining = await NullableVerifiedUser.findAll({ raw: true });
      expect(remaining).toHaveLength(0);
    } finally {
      await nullableSequelize.close();
    }
  });
});

describe('removeOrphanedForeignKeys', () => {
  let sequelize;
  let VerifiedUser;
  let Exchange;
  let ApiKey;
  let VolumeSnapshot;

  beforeEach(async () => {
    sequelize = new Sequelize('sqlite::memory:', { logging: false });

    Exchange = sequelize.define('Exchange', {
      name: DataTypes.STRING
    }, { tableName: 'exchanges' });

    ApiKey = sequelize.define('ApiKey', {
      api_key_hash: DataTypes.STRING
    }, { tableName: 'api_keys' });

    VerifiedUser = sequelize.define('VerifiedUser', {
      influencer: { type: DataTypes.STRING, allowNull: false },
      uid: { type: DataTypes.STRING, allowNull: false },
      exchangeId: { type: DataTypes.INTEGER, allowNull: true },
      apiKeyId: { type: DataTypes.INTEGER, allowNull: true }
    }, { tableName: 'verified_users' });

    VolumeSnapshot = sequelize.define('VolumeSnapshot', {
      uid: { type: DataTypes.STRING, allowNull: false },
      exchange: DataTypes.STRING,
      exchangeId: { type: DataTypes.INTEGER, allowNull: true }
    }, { tableName: 'volume_snapshots' });

    await sequelize.sync();
  });

  afterEach(async () => {
    await sequelize.close();
  });

  it('nulls foreign keys that reference missing exchanges and API keys', async () => {
    const liveExchange = await Exchange.create({ name: 'Live Exchange' });
    const liveApiKey = await ApiKey.create({ api_key_hash: 'hash' });

    const orphanedUser = await VerifiedUser.create({
      influencer: 'alice',
      uid: '1',
      exchangeId: 999,
      apiKeyId: 888
    }, { validate: false });

    const validUser = await VerifiedUser.create({
      influencer: 'bob',
      uid: '2',
      exchangeId: liveExchange.id,
      apiKeyId: liveApiKey.id
    });

    const orphanedSnapshot = await VolumeSnapshot.create({
      uid: '1',
      exchange: 'blofin',
      exchangeId: 555
    });

    const validSnapshot = await VolumeSnapshot.create({
      uid: '2',
      exchange: 'blofin',
      exchangeId: liveExchange.id
    });

    const result = await removeOrphanedForeignKeys(sequelize, {
      VerifiedUser,
      VolumeSnapshot
    });

    await orphanedUser.reload();
    await validUser.reload();
    await orphanedSnapshot.reload();
    await validSnapshot.reload();

    expect(result.verifiedUsers.clearedExchangeIds).toBe(1);
    expect(result.verifiedUsers.clearedApiKeyIds).toBe(1);
    expect(result.volumeSnapshots.clearedExchangeIds).toBe(1);

    expect(orphanedUser.exchangeId).toBeNull();
    expect(orphanedUser.apiKeyId).toBeNull();
    expect(validUser.exchangeId).toBe(liveExchange.id);
    expect(validUser.apiKeyId).toBe(liveApiKey.id);
    expect(orphanedSnapshot.exchangeId).toBeNull();
    expect(validSnapshot.exchangeId).toBe(liveExchange.id);
  });

  it('reports no changes when all references are valid', async () => {
    const liveExchange = await Exchange.create({ name: 'Live Exchange' });
    const liveApiKey = await ApiKey.create({ api_key_hash: 'hash' });

    await VerifiedUser.create({
      influencer: 'carol',
      uid: '3',
      exchangeId: liveExchange.id,
      apiKeyId: liveApiKey.id
    });

    await VolumeSnapshot.create({
      uid: '3',
      exchange: 'blofin',
      exchangeId: liveExchange.id
    });

    const result = await removeOrphanedForeignKeys(sequelize, {
      VerifiedUser,
      VolumeSnapshot
    });

    expect(result).toEqual({
      verifiedUsers: { clearedExchangeIds: 0, clearedApiKeyIds: 0 },
      volumeSnapshots: { clearedExchangeIds: 0 }
    });
  });

  it('repairs foreign keys when the verified users table uses legacy casing', async () => {
    const legacySequelize = new Sequelize('sqlite::memory:', { logging: false });

    const LegacyVerifiedUser = legacySequelize.define('LegacyVerifiedUser', {
      influencer: { type: DataTypes.STRING, allowNull: false },
      uid: { type: DataTypes.STRING, allowNull: false },
      exchangeId: { type: DataTypes.INTEGER, allowNull: true },
      apiKeyId: { type: DataTypes.INTEGER, allowNull: true }
    }, { tableName: 'verified_users' });

    const LegacyVolumeSnapshot = legacySequelize.define('LegacyVolumeSnapshot', {
      uid: { type: DataTypes.STRING, allowNull: false },
      exchange: { type: DataTypes.STRING },
      exchangeId: { type: DataTypes.INTEGER, allowNull: true }
    }, { tableName: 'volume_snapshots' });

    const legacyQueryInterface = legacySequelize.getQueryInterface();

    await legacyQueryInterface.createTable('VerifiedUsers', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      influencer: { type: DataTypes.STRING },
      uid: { type: DataTypes.STRING },
      exchange: { type: DataTypes.STRING },
      exchangeId: { type: DataTypes.INTEGER },
      apiKeyId: { type: DataTypes.INTEGER },
      userId: { type: DataTypes.INTEGER },
      telegramId: { type: DataTypes.STRING },
      discordUserId: { type: DataTypes.STRING },
      guildId: { type: DataTypes.STRING },
      verifiedAt: { type: DataTypes.BIGINT },
      createdAt: { type: DataTypes.DATE },
      updatedAt: { type: DataTypes.DATE },
      volumeWarningDate: { type: DataTypes.STRING }
    });

    await legacyQueryInterface.createTable('exchanges', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING },
      createdAt: { type: DataTypes.DATE },
      updatedAt: { type: DataTypes.DATE }
    });

    await legacyQueryInterface.createTable('api_keys', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      api_key_hash: { type: DataTypes.STRING },
      createdAt: { type: DataTypes.DATE },
      updatedAt: { type: DataTypes.DATE }
    });

    await legacyQueryInterface.createTable('volume_snapshots', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      uid: { type: DataTypes.STRING },
      exchange: { type: DataTypes.STRING },
      exchangeId: { type: DataTypes.INTEGER },
      createdAt: { type: DataTypes.DATE },
      updatedAt: { type: DataTypes.DATE }
    });

    const timestamp = new Date('2024-01-01T00:00:00Z');

    await legacyQueryInterface.bulkInsert('VerifiedUsers', [
      {
        influencer: 'legacy-influencer',
        uid: 'legacy-uid',
        exchangeId: 321,
        apiKeyId: 654,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ]);

    await legacyQueryInterface.bulkInsert('volume_snapshots', [
      {
        uid: 'legacy-uid',
        exchange: 'legacy-exchange',
        exchangeId: 321,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ]);

    try {
      const result = await removeOrphanedForeignKeys(legacySequelize, {
        VerifiedUser: LegacyVerifiedUser,
        VolumeSnapshot: LegacyVolumeSnapshot
      });

      expect(result.verifiedUsers.clearedExchangeIds).toBe(1);
      expect(result.verifiedUsers.clearedApiKeyIds).toBe(1);
      expect(result.volumeSnapshots.clearedExchangeIds).toBe(1);
      expect(LegacyVerifiedUser.options.tableName).toBe('verified_users');

      const verifiedRows = await legacySequelize.query(
        'SELECT exchangeId, apiKeyId FROM "VerifiedUsers"',
        { type: QueryTypes.SELECT }
      );

      const snapshotRows = await legacySequelize.query(
        'SELECT exchangeId FROM volume_snapshots',
        { type: QueryTypes.SELECT }
      );

      expect(verifiedRows[0].exchangeId).toBeNull();
      expect(verifiedRows[0].apiKeyId).toBeNull();
      expect(snapshotRows[0].exchangeId).toBeNull();
    } finally {
      await legacySequelize.close();
    }
  });
});
