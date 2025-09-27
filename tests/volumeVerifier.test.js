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

const BlofinServiceMock = jest.fn();
const BitunixServiceMock = jest.fn();

const saveSnapshotMock = jest.fn();

jest.unstable_mockModule('../src/services/volumeSnapshotService.js', () => ({
  saveSnapshot: saveSnapshotMock
}));

jest.unstable_mockModule('../src/services/blofinService.js', () => ({
  default: BlofinServiceMock
}));

jest.unstable_mockModule('../src/services/bitunixService.js', () => ({
  default: BitunixServiceMock
}));

const { createVolumeVerifier } = await import('../src/services/volumeVerifier.js');

const httpClient = { get: jest.fn() };

describe('volumeVerifier', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    httpClient.get.mockReset();
    BlofinServiceMock.mockReset();
    BitunixServiceMock.mockReset();
    saveSnapshotMock.mockReset();
  });

  const baseConfig = {
    discord: { enabled: false },
    telegram: { enabled: false },
    http: { enabled: false, port: 3000 },
    verification: {
      volumeCheckEnabled: true,
      minimumVolume: 1000,
      defaultExchange: 'mock',
      exchanges: {
        mock: {
          type: 'mock',
          volumes: { trader: 1500, newcomer: 500 }
        }
      }
    }
  };

  it('verifies a UID using the mock exchange', async () => {
    const verifier = createVolumeVerifier(baseConfig, { httpClient });
    const result = await verifier.verify('trader');
    expect(result.passed).toBe(true);
    expect(result.volume).toBe(1500);
    expect(result.minimumVolume).toBe(1000);
    expect(result.volumeMet).toBe(true);
    expect(saveSnapshotMock).toHaveBeenCalledWith('trader', 'mock', 1500, null, null, null);
  });

  it('marks volume target unmet when volume is too low', async () => {
    const verifier = createVolumeVerifier(baseConfig, { httpClient });
    const result = await verifier.verify('newcomer');
    expect(result.passed).toBe(true);
    expect(result.volume).toBe(500);
    expect(result.volumeMet).toBe(false);
    expect(saveSnapshotMock).toHaveBeenCalledWith('newcomer', 'mock', 500, null, null, null);
  });

  it('supports custom minimum volume and exchange selection', async () => {
    httpClient.get.mockResolvedValue({ status: 200, data: { volume: 3200 } });
    const config = {
      ...baseConfig,
      verification: {
        minimumVolume: 1000,
        defaultExchange: 'restExchange',
        exchanges: {
          restExchange: {
            type: 'rest',
            apiBaseUrl: 'https://example.com',
            apiKey: 'secret',
            volumePath: '/volume/{uid}',
            minimumVolume: 2500
          }
        }
      }
    };

    const verifier = createVolumeVerifier(config, { httpClient });
    const failingResult = await verifier.verify('unique', { minimumVolume: 4000 });
    expect(failingResult.passed).toBe(true);
    expect(failingResult.volumeMet).toBe(false);

    const passingResult = await verifier.verify('unique');
    expect(passingResult.passed).toBe(true);
    expect(passingResult.volumeMet).toBe(true);
    expect(httpClient.get).toHaveBeenCalledWith('https://example.com/volume/unique', expect.objectContaining({ headers: expect.any(Object) }));
    expect(saveSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it('throws when exchange is not configured', async () => {
    const verifier = createVolumeVerifier(baseConfig, { httpClient });
    await expect(verifier.verify('uid', { exchangeId: 'missing' })).rejects.toThrow('Exchange missing is not configured.');
  });

  it('skips verification when volume checks are disabled', async () => {
    const config = {
      ...baseConfig,
      verification: {
        ...baseConfig.verification,
        volumeCheckEnabled: false
      }
    };

    const verifier = createVolumeVerifier(config, { httpClient });
    const result = await verifier.verify('any');

    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.volume).toBe(0);
    expect(result.volumeMet).toBeNull();
    expect(saveSnapshotMock).toHaveBeenCalledWith('any', 'mock', 0, null, null, null);
  });

  it('refreshes configuration with new exchanges', async () => {
    const verifier = createVolumeVerifier(baseConfig, { httpClient });
    httpClient.get.mockResolvedValue({ status: 200, data: { volume: 9000 } });

    const newConfig = {
      ...baseConfig,
      verification: {
        volumeCheckEnabled: true,
        minimumVolume: 1000,
        defaultExchange: 'restExchange',
        exchanges: {
          restExchange: {
            type: 'rest',
            apiBaseUrl: 'https://example.com',
            volumePath: '/volume/{uid}'
          }
        }
      }
    };

    verifier.refresh(newConfig);
    const result = await verifier.verify('new-user');

    expect(result.exchangeId).toBe('restExchange');
    expect(httpClient.get).toHaveBeenCalledWith('https://example.com/volume/new-user', expect.any(Object));
  });

  it('verifies a UID against Blofin deposit and volume', async () => {
    const blofinInstance = {
      verifyUid: jest.fn().mockResolvedValue({ verified: true, userData: { totalDeposit: '1250.5' } }),
      calculateLast30DaysVolume: jest.fn().mockResolvedValue(5600)
    };
    BlofinServiceMock.mockImplementation(() => blofinInstance);

    const config = {
      ...baseConfig,
      verification: {
        ...baseConfig.verification,
        depositThreshold: 1000,
        defaultExchange: 'blofin',
        exchanges: {
          blofin: {
            type: 'blofin',
            apiKey: 'key',
            apiSecret: 'secret',
            passphrase: 'phrase'
          }
        }
      }
    };

    const verifier = createVolumeVerifier(config, { httpClient });
    const result = await verifier.verify('vip-trader');

    expect(BlofinServiceMock).toHaveBeenCalledTimes(1);
    expect(blofinInstance.verifyUid).toHaveBeenCalledWith('vip-trader', 1000);
    expect(blofinInstance.calculateLast30DaysVolume).toHaveBeenCalledWith('vip-trader');
    expect(result.passed).toBe(true);
    expect(result.volume).toBe(5600);
    expect(result.deposit).toEqual(expect.objectContaining({
      threshold: 1000,
      met: true,
      amount: 1250.5
    }));
    expect(saveSnapshotMock).not.toHaveBeenCalled();
  });

  it('fails verification when Blofin deposit requirement is not met', async () => {
    const blofinInstance = {
      verifyUid: jest.fn().mockResolvedValue({ verified: false, reason: 'no deposit' }),
      calculateLast30DaysVolume: jest.fn()
    };
    BlofinServiceMock.mockImplementation(() => blofinInstance);

    const config = {
      ...baseConfig,
      verification: {
        ...baseConfig.verification,
        depositThreshold: 500,
        defaultExchange: 'blofin',
        exchanges: {
          blofin: {
            type: 'blofin',
            apiKey: 'key',
            apiSecret: 'secret',
            passphrase: 'phrase'
          }
        }
      }
    };

    const verifier = createVolumeVerifier(config, { httpClient });
    const result = await verifier.verify('low-deposit');

    expect(blofinInstance.verifyUid).toHaveBeenCalledWith('low-deposit', 500);
    expect(blofinInstance.calculateLast30DaysVolume).not.toHaveBeenCalled();
    expect(result.passed).toBe(false);
    expect(result.volume).toBe(0);
    expect(result.deposit).toEqual(expect.objectContaining({
      threshold: 500,
      met: false,
      reason: 'no deposit'
    }));
    expect(saveSnapshotMock).not.toHaveBeenCalled();
  });

  it('verifies Bitunix deposits before fetching volume', async () => {
    const bitunixInstance = {
      verifyUid: jest.fn().mockResolvedValue({ verified: true, userData: { deposit: 420 } }),
      calculateLast30DaysVolume: jest.fn().mockResolvedValue(3200)
    };
    BitunixServiceMock.mockImplementation(() => bitunixInstance);

    const config = {
      ...baseConfig,
      verification: {
        ...baseConfig.verification,
        depositThreshold: 300,
        defaultExchange: 'bitunix',
        exchanges: {
          bitunix: {
            type: 'bitunix',
            apiKey: 'key',
            apiSecret: 'secret'
          }
        }
      }
    };

    const verifier = createVolumeVerifier(config, { httpClient });
    const result = await verifier.verify('bitunix-user');

    expect(BitunixServiceMock).toHaveBeenCalledTimes(1);
    expect(bitunixInstance.verifyUid).toHaveBeenCalledWith('bitunix-user', 300);
    expect(bitunixInstance.calculateLast30DaysVolume).toHaveBeenCalledWith('bitunix-user');
    expect(result.passed).toBe(true);
    expect(result.deposit).toEqual(expect.objectContaining({
      threshold: 300,
      met: true,
      amount: 420
    }));
    expect(saveSnapshotMock).not.toHaveBeenCalled();
  });
});
