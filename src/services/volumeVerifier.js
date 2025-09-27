import axios from 'axios';
import BlofinService from './blofinService.js';
import BitunixService from './bitunixService.js';
import logger from '../utils/logger.js';
import { saveSnapshot } from './volumeSnapshotService.js';

const normaliseBaseUrl = (url) => url.replace(/\/$/, '');

const isNumber = (value) => typeof value === 'number' && !Number.isNaN(value);

const createMockClient = (exchangeId, exchangeConfig) => {
  const { volumes = {} } = exchangeConfig;
  return {
    id: exchangeId,
    type: 'mock',
    supportsDepositCheck: false,
    async getVolume(uid) {
      const volume = Number(volumes[uid]) || 0;
      logger.debug(`Mock exchange ${exchangeId} returning volume ${volume} for UID ${uid}`);
      return { volume, source: { type: 'mock' } };
    }
  };
};

const createRestClient = (exchangeId, exchangeConfig, { httpClient }) => {
  const { apiBaseUrl, apiKey, headers = {}, volumePath = '/uids/{uid}/volume' } = exchangeConfig;
  const baseUrl = normaliseBaseUrl(apiBaseUrl);

  return {
    id: exchangeId,
    type: 'rest',
    supportsDepositCheck: false,
    async getVolume(uid) {
      const requestUrl = `${baseUrl}${volumePath.replace('{uid}', encodeURIComponent(uid))}`;
      try {
        const response = await httpClient.get(requestUrl, {
          headers: {
            Authorization: apiKey ? `Bearer ${apiKey}` : undefined,
            ...headers
          }
        });
        const { volume } = response.data || {};
        if (typeof volume !== 'number') {
          throw new Error(`Exchange ${exchangeId} responded without a numeric volume.`);
        }
        logger.info(`Fetched volume ${volume} for UID ${uid} from exchange ${exchangeId}.`);
        return { volume, source: { type: 'rest', status: response.status } };
      } catch (error) {
        const message = error.response?.data?.message || error.message;
        logger.error(`Failed to fetch volume for UID ${uid} from exchange ${exchangeId}: ${message}`);
        throw new Error(`Unable to fetch volume for UID ${uid} from exchange ${exchangeId}.`);
      }
    }
  };
};

const createBlofinClient = (exchangeId, exchangeConfig) => {
  const {
    apiKey,
    apiSecret,
    passphrase,
    subAffiliateInvitees,
    kolName
  } = exchangeConfig;

  const service = new BlofinService(apiKey, apiSecret, passphrase, subAffiliateInvitees, kolName);

  return {
    id: exchangeId,
    type: 'blofin',
    supportsDepositCheck: true,
    async getVolume(uid, options = {}) {
      const depositThreshold = isNumber(options.depositThreshold) ? options.depositThreshold : null;
      const depositCheckThreshold = depositThreshold ?? 0;
      const deposit = {
        threshold: depositThreshold,
        met: null,
        source: { type: 'blofin', stage: 'deposit' },
        evaluatedThreshold: depositCheckThreshold
      };

      try {
        const verification = await service.verifyUid(uid, depositCheckThreshold);
        if (!verification?.verified) {
          deposit.met = false;
          deposit.reason = verification?.reason || 'deposit_not_met';
          deposit.userData = verification?.userData || null;
          return { volume: 0, source: { type: 'blofin', stage: 'deposit' }, deposit };
        }

        deposit.met = true;
        const totalDeposit = parseFloat(verification?.userData?.totalDeposit);
        if (!Number.isNaN(totalDeposit)) {
          deposit.amount = totalDeposit;
        }
        if (verification?.userData) {
          deposit.userData = verification.userData;
        }
      } catch (error) {
        deposit.met = false;
        deposit.reason = 'deposit_check_failed';
        deposit.error = error?.message;
        logger.error(`Blofin deposit verification failed for UID ${uid} on ${exchangeId}: ${error?.message || error}`);
        return { volume: 0, source: { type: 'blofin', stage: 'deposit' }, deposit };
      }

      const volume = await service.calculateLast30DaysVolume(uid);
      return { volume, source: { type: 'blofin' }, deposit };
    }
  };
};

const createBitunixClient = (exchangeId, exchangeConfig) => {
  const { apiKey, apiSecret, kolName } = exchangeConfig;
  const service = new BitunixService(apiKey, apiSecret, kolName);

  return {
    id: exchangeId,
    type: 'bitunix',
    supportsDepositCheck: true,
    async getVolume(uid, options = {}) {
      const depositThreshold = isNumber(options.depositThreshold) ? options.depositThreshold : null;
      const depositCheckThreshold = depositThreshold ?? 0;
      const deposit = {
        threshold: depositThreshold,
        met: null,
        source: { type: 'bitunix', stage: 'deposit' },
        evaluatedThreshold: depositCheckThreshold
      };

      try {
        const verification = await service.verifyUid(uid, depositCheckThreshold);
        if (!verification?.verified) {
          deposit.met = false;
          deposit.reason = verification?.reason || 'deposit_not_met';
          deposit.userData = verification?.userData || null;
          return { volume: 0, source: { type: 'bitunix', stage: 'deposit' }, deposit };
        }
        deposit.met = true;
        const depositAmount = parseFloat(verification?.userData?.deposit);
        if (!Number.isNaN(depositAmount)) {
          deposit.amount = depositAmount;
        }
        if (verification?.userData) {
          deposit.userData = verification.userData;
        }
      } catch (error) {
        deposit.met = false;
        deposit.reason = 'deposit_check_failed';
        deposit.error = error?.message;
        logger.error(`Bitunix deposit verification failed for UID ${uid} on ${exchangeId}: ${error?.message || error}`);
        return { volume: 0, source: { type: 'bitunix', stage: 'deposit' }, deposit };
      }

      const volume = await service.calculateLast30DaysVolume(uid);
      return { volume, source: { type: 'bitunix' }, deposit };
    }
  };
};

const clientFactories = {
  mock: createMockClient,
  rest: createRestClient,
  blofin: createBlofinClient,
  bitunix: createBitunixClient
};

export const createVolumeVerifier = (config, dependencies = {}) => {
  const { httpClient = axios } = dependencies;
  let baseConfig = config;
  let verification = config.verification || { exchanges: {} };
  let clients = {};
  let availableExchangeIds = [];

  const rebuildClients = (verificationConfig = {}, fullConfig = baseConfig) => {
    baseConfig = fullConfig;
    verification = {
      minimumVolume: typeof verificationConfig.minimumVolume === 'number'
        ? verificationConfig.minimumVolume
        : 0,
      defaultExchange: verificationConfig.defaultExchange,
      volumeCheckEnabled: verificationConfig.volumeCheckEnabled,
      exchanges: verificationConfig.exchanges || {},
      volumeCheckDays: verificationConfig.volumeCheckDays,
      depositThreshold: isNumber(verificationConfig.depositThreshold)
        ? verificationConfig.depositThreshold
        : null
    };
    clients = {};
    availableExchangeIds = [];

    Object.entries(verification.exchanges).forEach(([exchangeId, exchangeConfig]) => {
      const factory = clientFactories[exchangeConfig.type];
      if (!factory) {
        logger.warn(`Unsupported exchange type "${exchangeConfig.type}" for ${exchangeId}. This exchange will be ignored.`);
        return;
      }
      clients[exchangeId] = factory(exchangeId, exchangeConfig, { config: baseConfig, httpClient });
      availableExchangeIds.push(exchangeId);
    });
  };

  rebuildClients(config.verification || { exchanges: {} }, config);

  const resolveDefaultExchange = () => {
    if (verification.defaultExchange && clients[verification.defaultExchange]) {
      return verification.defaultExchange;
    }
    return availableExchangeIds[0];
  };

  const getExchangeMeta = () => Object.entries(verification.exchanges || {}).map(([exchangeId, exchangeConfig]) => ({
    id: exchangeId,
    type: exchangeConfig.type,
    minimumVolume: exchangeConfig.minimumVolume || verification.minimumVolume,
    depositThreshold: isNumber(exchangeConfig.depositThreshold)
      ? exchangeConfig.depositThreshold
      : verification.depositThreshold,
    description: exchangeConfig.description || '',
    name: exchangeConfig.name || null,
    databaseId: typeof exchangeConfig.id === 'number' ? exchangeConfig.id : null,
    affiliateLink: exchangeConfig.affiliateLink || null
  }));

  const getExchangeConfig = (exchangeId) => {
    const exchangeConfig = verification.exchanges?.[exchangeId];
    if (!exchangeConfig) {
      return null;
    }
    return {
      id: exchangeId,
      type: exchangeConfig.type,
      minimumVolume: exchangeConfig.minimumVolume || verification.minimumVolume,
      depositThreshold: isNumber(exchangeConfig.depositThreshold)
        ? exchangeConfig.depositThreshold
        : verification.depositThreshold,
      description: exchangeConfig.description || '',
      name: exchangeConfig.name || null,
      databaseId: typeof exchangeConfig.id === 'number' ? exchangeConfig.id : null,
      affiliateLink: exchangeConfig.affiliateLink || null,
      kolName: exchangeConfig.kolName || null
    };
  };

  const verify = async (uid, options = {}) => {
    if (!uid || typeof uid !== 'string') {
      throw new Error('A UID string is required for verification.');
    }

    const exchangeId = options.exchangeId || resolveDefaultExchange();

    if (!exchangeId) {
      throw new Error('No exchanges are available for verification.');
    }
    const exchangeConfig = verification.exchanges?.[exchangeId] || {};
    const hasFiniteMinimumOverride = typeof options.minimumVolume === 'number'
      && Number.isFinite(options.minimumVolume);
    // Ignore overrides that resolve to NaN or Infinity so comparisons remain reliable.
    const minimumVolume = hasFiniteMinimumOverride
      ? options.minimumVolume
      : (exchangeConfig.minimumVolume || verification.minimumVolume);

    let depositThreshold;
    if (isNumber(options.depositThreshold)) {
      depositThreshold = options.depositThreshold;
    } else if (isNumber(exchangeConfig.depositThreshold)) {
      depositThreshold = exchangeConfig.depositThreshold;
    } else {
      depositThreshold = verification.depositThreshold;
    }

    const client = clients[exchangeId];
    if (!client) {
      throw new Error(`Exchange ${exchangeId} is not configured.`);
    }

    const result = await client.getVolume(uid, { ...options, depositThreshold });
    const volume = Number(result.volume) || 0;
    let deposit = result.deposit;
    const volumeCheckEnforced = verification.volumeCheckEnabled !== false;

    // Exchanges that enforce a deposit requirement must report the outcome so we can
    // fail the verification if the user has not deposited enough. When a threshold is
    // configured but the client omits deposit data we mark the requirement as unmet
    // rather than silently passing the user.
    if (depositThreshold !== null && depositThreshold !== undefined && (!deposit || typeof deposit.met === 'undefined')) {
      logger.warn(`Deposit threshold configured for ${exchangeId} but client ${client.type} did not supply deposit results.`);
      deposit = {
        threshold: depositThreshold,
        met: false,
        reason: 'unsupported'
      };
    } else if (!deposit) {
      deposit = {
        threshold: null,
        met: true
      };
    }

    const depositPassed = deposit.met !== false;
    const volumeMet = volumeCheckEnforced ? volume >= minimumVolume : null;
    const passed = depositPassed;

    const response = {
      uid,
      exchangeId,
      volume,
      minimumVolume,
      passed,
      timestamp: new Date().toISOString(),
      source: result.source,
      deposit,
      skipped: !volumeCheckEnforced,
      volumeMet,
      exchangeName: exchangeConfig.name || exchangeId,
      exchangeDbId: typeof exchangeConfig.id === 'number' ? exchangeConfig.id : null,
      affiliateLink: exchangeConfig.affiliateLink || null,
      influencer: exchangeConfig.kolName || exchangeConfig.name || exchangeId
    };

    logger.info(`Deposit evaluation completed for UID ${uid} on ${exchangeId}.`, {
      uid,
      exchangeId,
      depositMet: depositPassed,
      depositThreshold: deposit.threshold ?? null,
      evaluatedThreshold: deposit.evaluatedThreshold ?? null,
      depositReason: deposit.reason || null,
      depositAmount: typeof deposit.amount === 'number' ? deposit.amount : null
    });

    if (!depositPassed) {
      logger.info(`Verification completed for UID ${uid} on ${exchangeId}. Passed: false`);
      return response;
    }

    if (volumeCheckEnforced && volumeMet === false) {
      logger.info(`Volume target not met for UID ${uid} on ${exchangeId}.`, { volume, minimumVolume });
    }

    if (response.passed) {
      const snapshotDepositAmount = typeof deposit.amount === 'number' ? deposit.amount : null;
      // Blofin and Bitunix clients persist snapshots internally after a successful verification.
      if (!['blofin', 'bitunix'].includes(client.type)) {
        try {
          await saveSnapshot(uid, exchangeId, volume, exchangeConfig.kolName || null, snapshotDepositAmount, response.exchangeDbId);
          logger.debug(`Saved volume snapshot for UID ${uid} on ${exchangeId}.`);
        } catch (snapshotError) {
          logger.error(`Failed to persist volume snapshot for UID ${uid} on ${exchangeId}: ${snapshotError.message}`);
        }
      }
    }

    logger.info(`Verification completed for UID ${uid} on ${exchangeId}. Passed: true`);
    return response;
  };

  return {
    verify,
    getExchanges: getExchangeMeta,
    getExchangeConfig,
    refresh(newConfig) {
      if (!newConfig?.verification) {
        throw new Error('A configuration object with a verification section is required.');
      }
      rebuildClients(newConfig.verification, newConfig);
      logger.info('Volume verifier configuration reloaded.');
    }
  };
};

export default createVolumeVerifier;
