import fs from 'fs';
import os from 'os';
import path from 'path';
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

const { loadConfig, resetConfigCache, defaultConfig } = await import('../src/config/configManager.js');

describe('configManager', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekis-config-'));
  const tempFile = path.join(tempDir, 'config.json');

  afterEach(() => {
    resetConfigCache();
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    delete process.env.HTTP_PORT;
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_JOIN_MESSAGE;
    delete process.env.TELEGRAM_GROUP_ID;
  });

  it('loads default configuration when no file is present', async () => {
    const config = await loadConfig(path.join(tempDir, 'missing.json'));
    expect(config.http.enabled).toBe(true);
    expect(config.verification.minimumVolume).toBe(defaultConfig.verification.minimumVolume);
  });

  it('merges configuration file values and environment overrides', async () => {
    const userConfig = {
      http: { enabled: true, port: 4321 },
      verification: {
        minimumVolume: 2500,
        exchanges: {
          mock: {
            type: 'mock',
            volumes: { 'custom-user': 5000 }
          }
        }
      }
    };
    fs.writeFileSync(tempFile, JSON.stringify(userConfig), 'utf-8');

    process.env.HTTP_PORT = '5555';
    const config = await loadConfig(tempFile);

    expect(config.http.port).toBe(5555);
    expect(config.verification.minimumVolume).toBe(2500);
    expect(config.verification.exchanges.mock.volumes['custom-user']).toBe(5000);
  });

  it('throws when discord is enabled without a token', async () => {
    const invalidConfig = {
      discord: { enabled: true, token: '' },
      telegram: { enabled: false },
      http: { enabled: true, port: 3000 },
      verification: defaultConfig.verification
    };
    fs.writeFileSync(tempFile, JSON.stringify(invalidConfig), 'utf-8');

    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_TOKEN;

    await expect(loadConfig(tempFile)).rejects.toThrow('Discord token is required when discord.enabled is true.');
  });
});
