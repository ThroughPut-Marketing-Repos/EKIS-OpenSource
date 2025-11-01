import axios from 'axios';
import crypto from 'crypto';
import { saveSnapshot } from './volumeSnapshotService.js';
import logger from '../utils/logger.js';

const VERBOSE = process.env.EXCHANGE_VERBOSE_LOGGING === 'true';
const logVerbose = (message, meta) => {
  if (VERBOSE) {
    logger.debug(message, meta);
  }
};

/**
 * Lightweight Bitunix exchange helper used by the bot. Provides deposit based
 * verification and trading volume queries.
 */
class BitunixService {
  constructor(apiKey, apiSecret, kolName = null) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = 'https://partners.bitunix.com/partner/api/v1/openapi';
    this.kolName = kolName;
    logger.info('Bitunix service initialised.', {
      hasKey: Boolean(apiKey),
      hasSecret: Boolean(apiSecret),
      kolName
    });
  }

  /**
   * Bitunix expects parameters to be sorted in a custom order before computing
   * the SHA1 signature. Digits come first, then lowercase letters, then the
   * remaining characters. This ensures the signature matches the backend
   * expectations regardless of the object key order provided by the caller.
   */
  _sortedKeys(params) {
    const rank = (ch) => {
      if (/^[0-9]/.test(ch)) return 0;
      if (/^[a-z]/.test(ch)) return 1;
      return 2;
    };
    return Object.keys(params).sort((a, b) => {
      const ra = rank(a[0]);
      const rb = rank(b[0]);
      return ra === rb ? a.localeCompare(b) : ra - rb;
    });
  }

  /**
   * Create the SHA1 signature required by the Bitunix API using the sorted
   * parameter order and appending the API secret at the end of the plain text
   * payload.
   */
  _sign(params) {
    const ordered = this._sortedKeys(params);
    const plain = ordered.map((key) => params[key]).join('') + this.apiSecret;
    return crypto.createHash('sha1').update(plain).digest('hex');
  }

  /**
   * Internal helper to perform POST requests (used for deposit checks).
   */
  async _post(path, body = {}) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const params = { ...body, timestamp };
    const signature = this._sign(params);
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      apiKey: this.apiKey,
      signature,
      timestamp
    };
    logVerbose(`[Bitunix] POST ${path}`, params);
    const data = new URLSearchParams(params);
    const response = await axios.post(`${this.baseUrl}${path}`, data, { headers });
    logVerbose('[Bitunix] POST response payload.', response.data);
    return response.data;
  }

  /**
   * Internal helper for GET requests (used for trading volume endpoints).
   */
  async _get(path, query = {}) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const params = { ...query, timestamp };
    const signature = this._sign(params);
    const headers = {
      apiKey: this.apiKey,
      signature
    };
    logVerbose(`[Bitunix] GET ${path}`, params);
    const response = await axios.get(`${this.baseUrl}${path}`, { params, headers });
    logVerbose('[Bitunix] GET response payload.', response.data);
    return response.data;
  }

  /**
   * Verify UID by checking whether the user has deposited at least the
   * threshold amount. On success a snapshot of the latest 30 days volume is
   * stored for later statistics.
   */
  async verifyUid(uid, depositThreshold) {
    try {
      logger.info(`[Bitunix] Verifying UID ${uid} with deposit threshold ${depositThreshold}.`);
      const data = await this._post('/validateUser', { account: uid });
      logVerbose('[Bitunix] /validateUser payload.', data);
      if (data.code === '0' && data.result?.result) {
        const deposit = parseFloat(data.result.deposit_usdt_amount) || 0;
        if (deposit >= depositThreshold) {
          logger.info(`[Bitunix] UID ${uid} deposit ${deposit} meets threshold ${depositThreshold}.`);
          let volume = 0;
          try {
            volume = await this.calculateLast30DaysVolume(uid);
            await saveSnapshot(uid, 'bitunix', volume, this.kolName, deposit);
          } catch (snapshotError) {
            logger.error(`Bitunix snapshot error for UID ${uid}: ${snapshotError.message}`);
          }
          return { verified: true, userData: { deposit } };
        }
        logger.warn(`[Bitunix] UID ${uid} deposit ${deposit} below threshold ${depositThreshold}.`);
        return { verified: false, reason: 'no deposit' };
      }
      if (data.code === '2') {
        logger.warn(`[Bitunix] UID ${uid} not found.`);
        return { verified: false, reason: 'user_not_found' };
      }
      logger.error(`[Bitunix] API returned unexpected code ${data.code} for UID ${uid}.`);
      return { verified: false, reason: 'api_error' };
    } catch (error) {
      const message = error.response?.data || error.message || error;
      logger.error(`Bitunix verifyUid error for ${uid}: ${JSON.stringify(message, null, 2)}`);
      return { verified: false, reason: 'api_error' };
    }
  }

  /**
   * Fetch all invitees with their total trading volumes. Useful for leaderboard
   * generation.
   */
  async fetchInvitees() {
    const result = [];
    const pageSize = 1000;
    let page = 1;
    while (true) {
      try {
        const data = await this._get('/transAmountList', { pageSize, page });
        const items = data.result?.items || [];
        items.forEach((item) => {
          if (item.uid) {
            result.push({
              uid: item.uid,
              totalTradingVolume: parseFloat(item.transVolume) || 0
            });
          }
        });
        if (items.length < pageSize) {
          break;
        }
        page += 1;
      } catch (error) {
        const message = error.response?.data || error.message || error;
        logger.error(`Bitunix fetchInvitees error: ${JSON.stringify(message, null, 2)}`);
        break;
      }
    }
    logger.info(`[Bitunix] Retrieved ${result.length} invitees.`);
    return result;
  }

  /**
   * Calculate trading volume for a specific UID within a time window.
   */
  async calculateVolume(uid, startTime, endTime = Date.now()) {
    try {
      const params = {
        uid,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString()
      };
      const data = await this._get('/transAmountList', params);
      const items = data.result?.items || [];
      const total = items.reduce((sum, item) => sum + (parseFloat(item.transVolume) || 0), 0);
      logVerbose(`[Bitunix] Calculated volume ${total} for UID ${uid}.`, params);
      return total;
    } catch (error) {
      const message = error.response?.data || error.message || error;
      logger.error(`Bitunix calculateVolume error: ${JSON.stringify(message, null, 2)}`);
      throw error;
    }
  }

  /**
   * Convenience helper for last 30 days volume computation.
   */
  async calculateLast30DaysVolume(uid) {
    const end = Date.now();
    const start = end - 30 * 24 * 60 * 60 * 1000;
    return this.calculateVolume(uid, start, end);
  }

  /**
   * Obtain total trading volume. Bitunix does not expose a dedicated endpoint
   * for lifetime volume, so we aggregate all records returned by
   * `transAmountList`.
   */
  async getTotalTradingVolume(uid) {
    try {
      const data = await this._get('/transAmountList', { uid });
      const items = data.result?.items || [];
      const total = items.reduce((sum, item) => sum + (parseFloat(item.transVolume) || 0), 0);
      logger.info(`[Bitunix] Total volume for UID ${uid}: ${total}.`);
      return total;
    } catch (error) {
      const message = error.response?.data || error.message || error;
      logger.error(`Bitunix getTotalTradingVolume error: ${JSON.stringify(message, null, 2)}`);
      throw error;
    }
  }
}

export default BitunixService;
