import express from 'express';
import logger from '../utils/logger.js';
import { saveVerifiedUser, VerifiedUserConflictError } from '../services/verificationService.js';

const ensureTranslator = (translator) => {
  if (!translator || typeof translator.t !== 'function') {
    throw new Error('A translator instance exposing t(key, vars) is required for HTTP localisation.');
  }
  return (key, vars) => translator.t(key, vars);
};

const buildAuthMiddleware = (httpConfig, translator) => (req, res, next) => {
  const translate = ensureTranslator(translator);
  if (!httpConfig.authToken) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${httpConfig.authToken}`) {
    res.status(401).json({ error: translate('http.errors.unauthorized') });
    return;
  }

  next();
};

export const createHttpServer = (httpConfig, volumeVerifier, dependencies = {}) => {
  if (!httpConfig?.enabled) {
    logger.info('HTTP API disabled.');
    return null;
  }

  const translator = dependencies.translator;
  const translate = ensureTranslator(translator);

  const app = express();
  app.use(express.json());

  const requireAuth = buildAuthMiddleware(httpConfig, translator);

  app.get('/health', (req, res) => {
    res.json({ status: translate('http.health.status'), timestamp: new Date().toISOString() });
  });

  app.get('/api/exchanges', requireAuth, (req, res) => {
    const exchanges = volumeVerifier.getExchanges();
    res.json({ exchanges });
  });

  app.post('/api/verify', requireAuth, async (req, res) => {
    const {
      uid,
      exchangeId,
      minimumVolume,
      telegramId,
      discordUserId,
      userId,
      guildId
    } = req.body || {};
    if (!uid) {
      res.status(400).json({ error: translate('http.errors.uidRequired') });
      return;
    }

    let minimumVolumeOverride;
    if (minimumVolume !== undefined && minimumVolume !== null) {
      // Normalise the override to a finite number so downstream comparisons behave predictably.
      const parsedMinimumVolume = Number(minimumVolume);
      if (!Number.isFinite(parsedMinimumVolume)) {
        res.status(400).json({ error: translate('http.errors.minimumVolumeInvalid') });
        return;
      }
      minimumVolumeOverride = parsedMinimumVolume;
    }

    try {
      const result = await volumeVerifier.verify(uid, { exchangeId, minimumVolume: minimumVolumeOverride });
      if (result.passed) {
        try {
          await saveVerifiedUser(result.influencer, uid, {
            exchange: result.exchangeId,
            exchangeId: result.exchangeDbId || null,
            telegramId: telegramId ? String(telegramId) : null,
            discordUserId: discordUserId ? String(discordUserId) : null,
            guildId: guildId ? String(guildId) : null,
            userId: userId ? String(userId) : null
          });
        } catch (error) {
          if (error instanceof VerifiedUserConflictError) {
            logger.warn(`HTTP verification conflict for UID ${uid}.`, {
              uid,
              exchangeId: result.exchangeId,
              influencer: result.influencer
            });
            res.status(409).json({ error: translate('http.errors.alreadyVerified') });
            return;
          }
          throw error;
        }
      }
      res.json(result);
    } catch (error) {
      if (error instanceof VerifiedUserConflictError) {
        res.status(409).json({ error: translate('http.errors.alreadyVerified') });
        return;
      }
      logger.warn(`HTTP verification failed: ${error.message}`);
      res.status(400).json({ error: translate('http.errors.verificationFailed', { message: error.message }) });
    }
  });

  const server = app.listen(httpConfig.port, () => {
    logger.info(`HTTP API listening on port ${httpConfig.port}`);
  });

  const close = () => new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });

  return { app, server, close };
};

export default createHttpServer;
