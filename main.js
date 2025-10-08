import dotenv from 'dotenv';
import getConfig from './src/config/configManager.js';
import createVolumeVerifier from './src/services/volumeVerifier.js';
import createDiscordBot from './src/platforms/discordBot.js';
import createTelegramBot from './src/platforms/telegramBot.js';
import createHttpServer from './src/server/httpServer.js';
import logger from './src/utils/logger.js';
import initializeDatabase from './src/database/index.js';
import createTradingVolumeMonitor from './src/services/tradingVolumeMonitor.js';
import { ensureOwnerPasskey, syncEnvironmentTokens } from './src/services/configUpdateService.js';
import { createTranslator } from './src/i18n/translator.js';

dotenv.config();

const bootstrap = async () => {
  try {
    await initializeDatabase();
    await syncEnvironmentTokens();

    const { passkey, created } = await ensureOwnerPasskey();
    if (created && passkey) {
      const maskedPasskey = process.env.NODE_ENV === 'production'
        ? `${passkey.slice(0, 4)}…${passkey.slice(-4)}`
        : passkey;
      logger.warn(
        'A new owner passkey was generated. Share it securely and register ownership using /owner register (Telegram) or !owner register (Discord).',
        { passkey: maskedPasskey }
      );
      if (process.env.NODE_ENV !== 'production') {
        logger.debug('Owner passkey (development visibility only).', { passkey });
      }
    }

    const config = await getConfig();
    const volumeVerifier = createVolumeVerifier(config);

    // Initialize translator with configured locale
    const translator = createTranslator({
      locale: config.translation?.locale || 'en',
      fallbackLocale: config.translation?.fallbackLocale || 'en'
    });

    const discordClient = createDiscordBot(config.discord, volumeVerifier, { translator });
    const telegramBot = createTelegramBot(config.telegram, volumeVerifier, { translator });
    const httpServer = createHttpServer(config.http, volumeVerifier, { translator });
    const tradingVolumeMonitor = createTradingVolumeMonitor({
      discordClient,
      telegramBot
    });

    tradingVolumeMonitor.start();

    logger.info('EKIS volume verification bot started.');

    const gracefulShutdown = async () => {
      logger.info('Shutting down EKIS bot...');
      if (tradingVolumeMonitor?.stop) {
        await tradingVolumeMonitor.stop();
      }
      if (httpServer?.close) {
        await httpServer.close();
      }
      if (discordClient?.destroy) {
        discordClient.destroy();
      }
      if (telegramBot?.stopPolling) {
        await telegramBot.stopPolling();
      }
      process.exit(0);
    };

    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
  } catch (error) {
    logger.error(`EKIS bot failed to start: ${error.message}`);
    process.exit(1);
  }
};

bootstrap();
