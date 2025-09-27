import { jest } from '@jest/globals';
const mockUpdate = jest.fn();
const mockCreate = jest.fn();
const mockFindOne = jest.fn();
const mockFindOrCreate = jest.fn();
const mockDestroy = jest.fn();
const mockFindAll = jest.fn();

const mockResetConfigCache = jest.fn();
const mockGetConfig = jest.fn();
const loggerMock = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};

jest.unstable_mockModule('../src/database/index.js', () => ({
  getModels: jest.fn(() => ({
    Configuration: {
      findOne: mockFindOne,
      create: mockCreate
    },
    Exchange: {
      findOrCreate: mockFindOrCreate,
      destroy: mockDestroy,
      findAll: mockFindAll
    }
  }))
}));

jest.unstable_mockModule('../src/config/configManager.js', () => ({
  resetConfigCache: mockResetConfigCache,
  getConfig: mockGetConfig
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: loggerMock,
  logger: loggerMock
}));

const {
  setVolumeCheckEnabled,
  setMinimumVolume,
  setDepositThreshold,
  setVolumeCheckDays,
  setVolumeWarningEnabled,
  setVolumeWarningDays,
  upsertExchangeCredentials,
  removeExchange,
  listExchanges,
  registerOwner,
  isOwner,
  requireOwner,
  syncEnvironmentTokens
} = await import('../src/services/configUpdateService.js');

describe('configUpdateService', () => {
  let configurationRecord;
  let configurationState;
  const refreshedConfig = {
    verification: {
      volumeCheckEnabled: true,
      minimumVolume: 2000,
      depositThreshold: null,
      volumeCheckDays: 30,
      volumeWarningEnabled: true,
      volumeWarningDays: 2
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    configurationState = {
      owner_passkey: 'owner-pass',
      owner_passkey_generated_at: null,
      owner_registered_at: null,
      owner_id: null,
      owner_platform: null,
      owner_telegram_id: null,
      owner_discord_id: null,
      telegram_bot_token: null,
      discord_bot_token: null
    };

    configurationRecord = {
      update: mockUpdate,
      reload: jest.fn(async () => configurationRecord)
    };

    Object.defineProperties(configurationRecord, {
      owner_passkey: {
        get: () => configurationState.owner_passkey,
        set: (value) => { configurationState.owner_passkey = value; }
      },
      owner_passkey_generated_at: {
        get: () => configurationState.owner_passkey_generated_at,
        set: (value) => { configurationState.owner_passkey_generated_at = value; }
      },
      owner_registered_at: {
        get: () => configurationState.owner_registered_at,
        set: (value) => { configurationState.owner_registered_at = value; }
      },
      owner_id: {
        get: () => configurationState.owner_id,
        set: (value) => { configurationState.owner_id = value; }
      },
      owner_platform: {
        get: () => configurationState.owner_platform,
        set: (value) => { configurationState.owner_platform = value; }
      },
      owner_telegram_id: {
        get: () => configurationState.owner_telegram_id,
        set: (value) => { configurationState.owner_telegram_id = value; }
      },
      owner_discord_id: {
        get: () => configurationState.owner_discord_id,
        set: (value) => { configurationState.owner_discord_id = value; }
      },
      telegram_bot_token: {
        get: () => configurationState.telegram_bot_token,
        set: (value) => { configurationState.telegram_bot_token = value; }
      },
      discord_bot_token: {
        get: () => configurationState.discord_bot_token,
        set: (value) => { configurationState.discord_bot_token = value; }
      }
    });

    mockUpdate.mockImplementation(async (updates) => {
      Object.assign(configurationState, updates);
      return configurationRecord;
    });

    mockFindOne.mockResolvedValue(configurationRecord);
    mockCreate.mockImplementation(async () => configurationRecord);
    mockGetConfig.mockResolvedValue(refreshedConfig);
    mockFindOrCreate.mockResolvedValue([{ update: mockUpdate }, false]);
    mockFindAll.mockResolvedValue([]);
    mockDestroy.mockResolvedValue(1);
  });

  it('updates the volume check flag', async () => {
    await setVolumeCheckEnabled(false);
    expect(mockUpdate).toHaveBeenCalledWith({ trading_volume_check_enabled: false });
    expect(mockResetConfigCache).toHaveBeenCalled();
    expect(mockGetConfig).toHaveBeenCalled();
  });

  it('validates minimum volume input', async () => {
    await expect(setMinimumVolume(0)).rejects.toThrow('Minimum volume must be greater than zero.');
    await setMinimumVolume(1500);
    expect(mockUpdate).toHaveBeenCalledWith({ trading_volume_threshold: 1500 });
  });

  it('allows clearing the deposit threshold', async () => {
    await setDepositThreshold(null);
    expect(mockUpdate).toHaveBeenCalledWith({ deposit_threshold: null });
  });

  it('updates volume check days', async () => {
    await setVolumeCheckDays('45');
    expect(mockUpdate).toHaveBeenCalledWith({ trading_volume_check_days_duration: 45 });
  });

  it('toggles volume warning notifications', async () => {
    await setVolumeWarningEnabled(false);
    expect(mockUpdate).toHaveBeenCalledWith({ trading_volume_warning_enabled: false });
  });

  it('updates warning lead time', async () => {
    await setVolumeWarningDays(5);
    expect(mockUpdate).toHaveBeenCalledWith({ trading_volume_warning_days: 5 });
  });

  it('upserts exchange credentials', async () => {
    mockFindOrCreate.mockResolvedValue([{ update: mockUpdate }, true]);
    await upsertExchangeCredentials({
      name: 'bitget',
      type: 'rest',
      apiKey: 'key',
      apiSecret: 'secret'
    });
    expect(mockFindOrCreate).toHaveBeenCalled();
    expect(mockResetConfigCache).toHaveBeenCalled();
  });

  it('removes an exchange and refreshes configuration', async () => {
    await removeExchange('bitget');
    expect(mockDestroy).toHaveBeenCalledWith({ where: { name: 'bitget' } });
    expect(mockResetConfigCache).toHaveBeenCalled();
  });

  it('lists configured exchanges', async () => {
    mockFindAll.mockResolvedValue([{ id: 1, name: 'bitget', type: 'rest', affiliate_link: null }]);
    const exchanges = await listExchanges();
    expect(exchanges).toEqual([{ id: 1, name: 'bitget', type: 'rest', affiliateLink: null }]);
  });

  describe('syncEnvironmentTokens', () => {
    afterEach(() => {
      delete process.env.DISCORD_BOT_TOKEN;
      delete process.env.DISCORD_TOKEN;
      delete process.env.TELEGRAM_BOT_TOKEN;
    });

    it('persists environment bot tokens when values are provided', async () => {
      process.env.DISCORD_TOKEN = 'discord-env-token';
      process.env.TELEGRAM_BOT_TOKEN = 'telegram-env-token';

      configurationState.discord_bot_token = 'stored-discord-token';
      configurationState.telegram_bot_token = null;

      const result = await syncEnvironmentTokens();

      expect(mockUpdate).toHaveBeenCalledWith({
        discord_bot_token: 'discord-env-token',
        telegram_bot_token: 'telegram-env-token'
      });
      expect(mockResetConfigCache).toHaveBeenCalled();
      expect(mockGetConfig).toHaveBeenCalled();
      expect(result).toEqual({
        updated: true,
        updates: {
          discord_bot_token: 'discord-env-token',
          telegram_bot_token: 'telegram-env-token'
        }
      });
    });

    it('skips updates when environment tokens are missing', async () => {
      const result = await syncEnvironmentTokens();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(result).toEqual({ updated: false, updates: {} });
    });

    it('avoids unnecessary updates when tokens match stored values', async () => {
      process.env.DISCORD_BOT_TOKEN = 'discord-env-token';
      process.env.TELEGRAM_BOT_TOKEN = 'telegram-env-token';

      configurationState.discord_bot_token = 'discord-env-token';
      configurationState.telegram_bot_token = 'telegram-env-token';

      const result = await syncEnvironmentTokens();

      expect(mockUpdate).not.toHaveBeenCalled();
      expect(result).toEqual({ updated: false, updates: {} });
    });
  });

  describe('owner registration', () => {
    it('registers platform-specific owner identifiers', async () => {
      configurationState.owner_passkey = 'secret';
      await registerOwner({ platform: 'telegram', userId: 'tg-100', passkey: 'secret' });
      expect(configurationState.owner_telegram_id).toEqual('tg-100');
      expect(configurationState.owner_discord_id).toBeNull();

      await registerOwner({ platform: 'discord', userId: 'dc-200', passkey: 'secret' });
      expect(configurationState.owner_discord_id).toEqual('dc-200');

      expect(await isOwner('telegram', 'tg-100')).toBe(true);
      expect(await isOwner('discord', 'dc-200')).toBe(true);
    });

    it('migrates legacy owner fields when validating ownership', async () => {
      configurationState.owner_passkey = 'secret';
      configurationState.owner_platform = 'telegram';
      configurationState.owner_id = 'legacy-owner';
      configurationState.owner_telegram_id = null;

      const isLegacyOwner = await isOwner('telegram', 'legacy-owner');
      expect(isLegacyOwner).toBe(true);
      expect(configurationState.owner_telegram_id).toEqual('legacy-owner');
    });

    it('requires platform ownership to be claimed before privileged actions', async () => {
      configurationState.owner_telegram_id = 'tg-100';
      await expect(requireOwner('discord', 'dc-200'))
        .rejects.toThrow('No owner has been registered for this platform. Submit the owner passkey to claim ownership.');
    });
  });
});
