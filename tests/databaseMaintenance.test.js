import { Sequelize, DataTypes } from 'sequelize';
import { removeDuplicateVerifiedUsers } from '../src/database/maintenance.js';

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
