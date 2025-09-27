import { jest } from '@jest/globals';

const loggerMock = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: loggerMock,
  logger: loggerMock
}));

const { createTradingVolumeMonitor } = await import('../src/services/tradingVolumeMonitor.js');

const DAY_IN_MS = 24 * 60 * 60 * 1000;

describe('tradingVolumeMonitor', () => {
  const baseConfig = {
    verification: {
      volumeCheckEnabled: true,
      minimumVolume: 200,
      volumeCheckDays: 30,
      volumeWarningEnabled: true,
      volumeWarningDays: 2,
      defaultExchange: 'mock'
    }
  };

  const createRecord = (overrides = {}) => ({
    influencer: 'kol',
    uid: 'uid-1',
    verifiedAt: Date.now() - (28 * DAY_IN_MS),
    telegramId: '100',
    discordUserId: null,
    guildId: null,
    exchange: 'mock',
    volumeWarningDate: null,
    update: jest.fn(async function update(payload) {
      Object.assign(this, payload);
    }),
    ...overrides
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('skips checks when trading volume monitoring is disabled', async () => {
    const modelsProvider = jest.fn();
    const monitor = createTradingVolumeMonitor({
      configProvider: async () => ({ verification: { volumeCheckEnabled: false } }),
      modelsProvider,
      volumeService: { getVolumeBetween: jest.fn() }
    });

    await monitor.runNow();
    expect(modelsProvider).not.toHaveBeenCalled();
  });

  it('sends warnings when users are inside the warning window', async () => {
    const now = new Date('2024-02-01T00:00:00.000Z').getTime();
    jest.spyOn(Date, 'now').mockReturnValue(now);

    const record = createRecord({ verifiedAt: now - (28 * DAY_IN_MS) });
    const getVolumeBetween = jest.fn().mockResolvedValue(150);
    const sendMessage = jest.fn().mockResolvedValue();
    const monitor = createTradingVolumeMonitor({
      configProvider: async () => baseConfig,
      modelsProvider: async () => ({
        VerifiedUser: { findAll: jest.fn().mockResolvedValue([record]) },
        Exchange: null
      }),
      volumeService: { getVolumeBetween },
      verificationActions: { removeVerifiedUser: jest.fn() },
      telegramBot: { sendMessage },
      discordClient: null
    });

    await monitor.runNow();

    expect(getVolumeBetween).toHaveBeenCalledWith(
      'uid-1',
      'mock',
      new Date(record.verifiedAt).toISOString(),
      new Date(now).toISOString()
    );
    expect(sendMessage).toHaveBeenCalledWith('100', expect.stringContaining('risk'), expect.any(Object));
    expect(record.update).toHaveBeenCalledWith(expect.objectContaining({ volumeWarningDate: expect.any(String) }));
  });

  it('revokes access when the deadline has passed without sufficient volume', async () => {
    const now = new Date('2024-03-01T00:00:00.000Z').getTime();
    jest.spyOn(Date, 'now').mockReturnValue(now);

    const record = createRecord({ verifiedAt: now - (35 * DAY_IN_MS) });
    const getVolumeBetween = jest.fn().mockResolvedValue(50);
    const sendMessage = jest.fn().mockResolvedValue();
    const removeVerifiedUser = jest.fn().mockResolvedValue(1);
    const monitor = createTradingVolumeMonitor({
      configProvider: async () => baseConfig,
      modelsProvider: async () => ({
        VerifiedUser: { findAll: jest.fn().mockResolvedValue([record]) },
        Exchange: null
      }),
      volumeService: { getVolumeBetween },
      verificationActions: { removeVerifiedUser },
      telegramBot: { sendMessage },
      discordClient: null
    });

    await monitor.runNow();

    expect(sendMessage).toHaveBeenCalledWith('100', expect.stringContaining('revoked'), expect.any(Object));
    expect(removeVerifiedUser).toHaveBeenCalledWith('kol', 'uid-1');
    expect(record.update).not.toHaveBeenCalled();
  });
});
