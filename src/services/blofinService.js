import axios from 'axios';
import crypto from 'crypto';
import {
  saveSnapshot,
  getVolumeForLast30Days,
  getVolumeBetween,
  getVolumeBetweenBatch,
  saveSnapshotsBatch
} from './volumeSnapshotService.js';
import logger from '../utils/logger.js';

const VERBOSE = process.env.EXCHANGE_VERBOSE_LOGGING === 'true';
const logVerbose = (message, meta) => {
  if (VERBOSE) {
    logger.debug(message, meta);
  }
};

class BlofinService {
  constructor(apiKey, apiSecret, passphrase, subAffiliateInvitees = false, kolName = null) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.passphrase = passphrase;
    this.baseUrl = 'https://openapi.blofin.com';
    this.subAffiliateInvitees = subAffiliateInvitees;
    this.kolName = kolName;
    logger.info('Blofin service initialised.', {
      hasKey: Boolean(apiKey),
      hasSecret: Boolean(apiSecret),
      hasPassphrase: Boolean(passphrase),
      subAffiliateInvitees,
      kolName
    });
  }

  generateNonce() {
    return crypto.randomBytes(16).toString('hex');
  }

  createSignature(secretKey, nonce, method, timestamp, path, body = '') {
    const serialisedBody = body ? JSON.stringify(body, null, 2) : '';
    const prehashString = `${path}${method}${timestamp}${nonce}${serialisedBody}`;
    const encodedString = Buffer.from(prehashString, 'utf-8');
    const hmac = crypto.createHmac('sha256', secretKey);
    const digest = hmac.update(encodedString).digest('hex');
    return Buffer.from(digest, 'utf-8').toString('base64');
  }

  async getSubAffiliateInvitees(params) {
    const timestamp = Date.now().toString();
    const nonce = this.generateNonce();
    const method = 'GET';
    const requestPath = '/api/v1/affiliate/sub-invitees';
    const pathWithParams = `${requestPath}${params}`;
    const signature = this.createSignature(this.apiSecret, nonce, method, timestamp, pathWithParams);

    const headers = {
      'ACCESS-KEY': this.apiKey,
      'ACCESS-SIGN': signature,
      'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-NONCE': nonce,
      'ACCESS-PASSPHRASE': this.passphrase,
      'Content-Type': 'application/json'
    };

      try {
          const url = `${this.baseUrl}${pathWithParams}`;
          logVerbose(`[Blofin] GET ${url}`);
          const response = await axios.get(url, {headers});

          // Add detailed response logging
          logger.debug(`[Blofin] Raw sub-affiliate invitees response: ${JSON.stringify({
              status: response.status,
              statusText: response.statusText,
              data: response.data,
              url: response.config?.url,
              method: response.config?.method
          }, null, 2)}`);

          const payloadSummary = {
              status: response.status,
              hasMore: response.data?.hasMore ?? null,
              count: Array.isArray(response.data?.data) ? response.data.data.length : 0
          };
          logger.info('[Blofin] Sub-affiliate invitees response received.', {
              ...payloadSummary,
              payload: response.data
          });
          logVerbose('[Blofin] Sub-affiliate invitees response payload.', response.data);
          return response.data;
      } catch (error) {
          if (error.response?.status === 429) {
              throw error;
          }
          const message = error.response?.data || error.message || error;
      logger.error(`Blofin sub-affiliate invitees error: ${JSON.stringify(message, null, 2)}`);
      throw error;
    }
  }

  async getDirectInvitees(params) {
    const timestamp = Date.now().toString();
    const nonce = this.generateNonce();
    const method = 'GET';
    const requestPath = '/api/v1/affiliate/invitees';
    const pathWithParams = `${requestPath}${params}`;

    const signature = this.createSignature(this.apiSecret, nonce, method, timestamp, pathWithParams);

    const headers = {
      'ACCESS-KEY': this.apiKey,
      'ACCESS-SIGN': signature,
      'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-NONCE': nonce,
      'ACCESS-PASSPHRASE': this.passphrase,
      'Content-Type': 'application/json'
    };

      try {
          const url = `${this.baseUrl}${pathWithParams}`;
          logVerbose(`[Blofin] Initiating GET request to ${url}`);

          // Log request details
          logger.debug(`[Blofin] Direct invitees request details: ${JSON.stringify({
              url,
              method: 'GET',
              headers: {
                  ...headers,
                  'ACCESS-KEY': headers['ACCESS-KEY'] ? '***' : undefined,
                  'ACCESS-SIGN': headers['ACCESS-SIGN'] ? '***' : undefined,
                  'ACCESS-PASSPHRASE': headers['ACCESS-PASSPHRASE'] ? '***' : undefined
              },
              timestamp: new Date().toISOString()
          }, null, 2)}`);

          const response = await axios.get(url, {headers});

          // Log raw response details
          logger.debug(`[Blofin] Direct invitees raw response: ${JSON.stringify({
              status: response.status,
              statusText: response.statusText,
              data: response.data,
              timing: response.headers['x-response-time'],
              requestId: response.headers['x-request-id']
          }, null, 2)}`);

          const payloadSummary = {
              status: response.status,
              hasMore: response.data?.hasMore ?? null,
              count: Array.isArray(response.data?.data) ? response.data.data.length : 0
          };

          // Log structured response summary
          logger.info('[Blofin] Direct invitees response received', {
              ...payloadSummary,
              firstRecord: response.data?.data?.[0]?.uid ? {
                  uid: response.data.data[0].uid,
                  hasVolume: Boolean(response.data.data[0].totalTradingVolume)
              } : null,
              payload: response.data
          });

          logVerbose('[Blofin] Direct invitees complete response payload', response.data);
          return response.data;
      } catch (error) {
          // Enhanced error logging
          if (error.response?.status === 429) {
              logger.warn('[Blofin] Rate limit exceeded for direct invitees request', {
                  status: error.response.status,
                  headers: error.response.headers,
                  resetTime: error.response.headers['rate-limit-reset'],
                  remainingRequests: error.response.headers['rate-limit-remaining']
              });
              throw error;
          }

          const errorDetails = {
              message: error.message,
              code: error.code,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        path: pathWithParams
      };
    
      logger.error('[Blofin] Direct invitees request failed', errorDetails);
      throw error;
    }
  }

  async verifyUid(uid, depositThreshold) {
    try {
      logger.info(`[Blofin] Verifying UID ${uid} against deposit threshold ${depositThreshold}.`);
      const params = `?uid=${uid}&limit=1`;
      let blofinUsers = await this.getDirectInvitees(params);
      if (blofinUsers) {
        blofinUsers.source = 'direct';
      }
      logVerbose('[Blofin] Direct invitees verification payload.', blofinUsers);

      if (!blofinUsers.data || blofinUsers.data.length === 0) {
        blofinUsers = await this.getSubAffiliateInvitees(params);
        if (blofinUsers) {
          blofinUsers.source = 'sub-affiliate';
        }
        logVerbose('[Blofin] Sub-affiliate invitees verification payload.', blofinUsers);
      }

      if (blofinUsers.data && blofinUsers.data.length > 0) {
        const sampleRecords = Array.isArray(blofinUsers.data) ? blofinUsers.data.slice(0, 5) : [];
        logger.info('[Blofin] Verification API payload received.', {
          uid,
          source: blofinUsers.source || (blofinUsers.data?.length ? 'direct' : 'sub-affiliate'),
          recordCount: blofinUsers.data.length,
          sample: sampleRecords
        });
        const userData = blofinUsers.data[0];
        const totalDeposit = parseFloat(userData.totalDeposit) || 0;
        const totalEquity = parseFloat(userData.totalEquity) || 0;
        const meetsThreshold = (totalDeposit || (totalDeposit + totalEquity)) >= depositThreshold;

        if (meetsThreshold) {
          logger.info(`[Blofin] UID ${uid} deposit ${totalDeposit} with equity ${totalEquity} meets threshold ${depositThreshold}.`);
          try {
            const volume = parseFloat(userData.totalTradingVolume) || 0;
            await saveSnapshot(uid, 'blofin', volume, this.kolName, totalDeposit);
          } catch (snapshotError) {
            logger.error(`Blofin snapshot error for UID ${uid}: ${snapshotError.message}`);
          }
          return { verified: true, userData };
        }

        logger.warn(`[Blofin] UID ${uid} deposit ${totalDeposit} with equity ${totalEquity} below threshold ${depositThreshold}.`);
        return { verified: false, reason: 'no deposit' };
      }

      logger.warn(`[Blofin] UID ${uid} not found in invitees lists.`);
      return { verified: false, reason: 'user_not_found' };
    } catch (error) {
      logger.error(`Blofin verification error for UID ${uid}: ${error.message}`);
      return { verified: false, reason: 'api_error' };
    }
  }

  async fetchInvitees(withSaveSnapshots = false) {
    logVerbose(`[Blofin] Fetching invitees. Snapshot enabled: ${withSaveSnapshots}.`);
    let allInvitees = [];
    let hasMoreDirect = true;
    let hasMoreSub = true;
    let afterDirect = '';
    let afterSub = '';
    const limit = 30;
    let pageCountDirect = 0;
    let pageCountSub = 0;

    while (hasMoreDirect) {
      const params = `?uid=&begin=&after=${afterDirect}&before=&limit=${limit}`;
      try {
        const data = await this.getDirectInvitees(params);
        pageCountDirect += 1;
        if (data?.data?.length) {
          allInvitees = allInvitees.concat(data.data);
          afterDirect = data.data[data.data.length - 1].uid;
          hasMoreDirect = Boolean(data.hasMore);
        } else {
          hasMoreDirect = false;
        }
      } catch (error) {
        if (error.response?.status === 429) {
          const rateLimitReset = Number(error.response.headers['rate-limit-reset']) * 1000;
          const waitTime = rateLimitReset - Date.now();
          if (waitTime > 0) {
            logger.warn(`[Blofin] Rate limited while fetching direct invitees. Waiting ${waitTime}ms.`);
            await new Promise((resolve) => setTimeout(resolve, waitTime));
          }
          continue;
        }
        const message = error.response?.data || error.message || error;
        logger.error(`Blofin direct invitees fetch error: ${JSON.stringify(message, null, 2)}`);
        throw error;
      }
    }

    while (hasMoreSub) {
      const params = `?uid=&begin=&after=${afterSub}&before=&limit=${limit}`;
      try {
        const data = await this.getSubAffiliateInvitees(params);
        pageCountSub += 1;
        if (data?.data?.length) {
          allInvitees = allInvitees.concat(data.data);
          afterSub = data.data[data.data.length - 1].uid;
          hasMoreSub = Boolean(data.hasMore);
        } else {
          hasMoreSub = false;
        }
      } catch (error) {
        if (error.response?.status === 429) {
          const rateLimitReset = Number(error.response.headers['rate-limit-reset']) * 1000;
          const waitTime = rateLimitReset - Date.now();
          if (waitTime > 0) {
            logger.warn(`[Blofin] Rate limited while fetching sub-invitees. Waiting ${waitTime}ms.`);
            await new Promise((resolve) => setTimeout(resolve, waitTime));
          }
          continue;
        }
        const message = error.response?.data || error.message || error;
        logger.error(`Blofin sub-affiliate invitees fetch error: ${JSON.stringify(message, null, 2)}`);
        throw error;
      }
    }

    logVerbose('[Blofin] Invitee pagination complete.', { pageCountDirect, pageCountSub });

    const seen = new Set();
    const dedupedInvitees = allInvitees.filter((invitee) => {
      if (!invitee.uid || seen.has(invitee.uid)) {
        return false;
      }
      seen.add(invitee.uid);
      return true;
    });

    if (withSaveSnapshots) {
      const snapshotData = dedupedInvitees
        .filter((invitee) => invitee.uid && invitee.totalTradingVolume !== undefined)
        .map((invitee) => ({
          uid: invitee.uid,
          exchange: 'blofin',
          totalVolume: invitee.totalTradingVolume,
          kolName: this.kolName,
          depositAmount: invitee.totalDeposit || 0
        }));

      if (snapshotData.length > 0) {
        try {
          await saveSnapshotsBatch(snapshotData);
          logger.info(`[Blofin] Stored ${snapshotData.length} invitee volume snapshots.`);
        } catch (error) {
          logger.error(`Blofin batch snapshot error: ${error.message}`);
        }
      }
    }

    logger.info(`[Blofin] Retrieved ${dedupedInvitees.length} unique invitees.`);
    return dedupedInvitees;
  }

  async claimUsdt(uid, amount) {
    const requestPath = '/api/v1/asset/withdrawal';
    const method = 'POST';

    if (!this.apiKey || !this.apiSecret || !this.passphrase) {
      throw new Error('Blofin credentials are required for withdrawals.');
    }

    const initiateNonce = this.generateNonce();
    const initiateTimestamp = Date.now().toString();

    const body = {
      type: '1',
      currency: 'USDT',
      amount: `${amount}`,
      address: `${uid}`
    };

    const initiateSignature = this.createSignature(
      this.apiSecret,
      initiateNonce,
      method,
      initiateTimestamp,
      requestPath,
      body
    );

    const headers = {
      'ACCESS-KEY': this.apiKey,
      'ACCESS-SIGN': initiateSignature,
      'ACCESS-TIMESTAMP': initiateTimestamp,
      'ACCESS-NONCE': initiateNonce,
      'ACCESS-PASSPHRASE': this.passphrase,
      'Content-Type': 'application/json'
    };

    try {
      logger.info(`[Blofin] Initiating USDT withdrawal for UID ${uid} amount ${amount}.`);
        logger.debug('[Blofin] Initiating withdrawal request.', {
            url: `${this.baseUrl}${requestPath}`,
            body,
            headers: {
                ...headers,
                'ACCESS-KEY': '***',
                'ACCESS-SIGN': '***',
                'ACCESS-PASSPHRASE': '***'
            }
        });

        const initiateResponse = await axios.post(`${this.baseUrl}${requestPath}`, body, {headers});
        const {code, msg, data} = initiateResponse.data;

        logger.debug('[Blofin] Withdrawal initiation response.', {
            status: initiateResponse.status,
            statusText: initiateResponse.statusText,
            headers: initiateResponse.headers,
            responseData: initiateResponse.data
        });

        if (code !== '0') {
        logger.error(`Blofin withdrawal initiation failed: ${msg}`);
        throw new Error(`Withdrawal initiation failed: ${msg}`);
      }
      if (!data?.withdrawId) {
        logger.error('Blofin withdrawal initiation missing withdrawId.');
        throw new Error('withdrawId not found in the initiation response.');
      }

      const withdrawId = String(data.withdrawId);
      logger.info(`[Blofin] Withdrawal initiated with ID ${withdrawId}.`);

      const historyMethod = 'GET';
      const historyRequestPath = '/api/v1/asset/withdrawal-history';
      const maxRetries = 5;
      const retryDelay = 3000;
      let retries = 0;
      let relevantRecord = null;

      while (retries < maxRetries) {
        logVerbose(`[Blofin] Withdrawal status attempt ${retries + 1} for ID ${withdrawId}.`);
        const statusNonce = this.generateNonce();
        const statusTimestamp = Date.now().toString();

        const queryParams = new URLSearchParams({
          withdrawId,
          type: '1'
        }).toString();
        const fullHistoryPath = `${historyRequestPath}?${queryParams}`;

        const historySignature = this.createSignature(
          this.apiSecret,
          statusNonce,
          historyMethod,
          statusTimestamp,
          fullHistoryPath
        );

        try {
          const historyHeaders = {
            'ACCESS-KEY': this.apiKey,
            'ACCESS-SIGN': historySignature,
            'ACCESS-TIMESTAMP': statusTimestamp,
            'ACCESS-NONCE': statusNonce,
            'ACCESS-PASSPHRASE': this.passphrase
          };

            logger.debug('[Blofin] Checking withdrawal status.', {
                url: `${this.baseUrl}${fullHistoryPath}`,
                attempt: retries + 1,
                withdrawId
            });

            const historyResponse = await axios.get(`${this.baseUrl}${fullHistoryPath}`, {headers: historyHeaders});
            const statusCall = historyResponse.data;

            logger.debug('[Blofin] Withdrawal status response.', {
                status: historyResponse.status,
                headers: historyResponse.headers,
                responseData: statusCall
            });
            logVerbose('[Blofin] Withdrawal history response payload.', statusCall);

          if (statusCall.code === '0' && Array.isArray(statusCall.data) && statusCall.data.length > 0) {
            relevantRecord = statusCall.data.find((record) => record.withdrawId === withdrawId);
            if (relevantRecord) {
              logger.info(`[Blofin] Withdrawal status retrieved for ID ${withdrawId}.`);
              break;
            }
          } else {
            logVerbose(`[Blofin] Withdrawal status not ready for ID ${withdrawId}.`);
          }
        } catch (error) {
          const message = error.response?.data || error.message || error;
          logger.error(`Blofin withdrawal history error: ${JSON.stringify(message, null, 2)}`);
        }

        retries += 1;
        if (retries < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
      }

      if (!relevantRecord) {
        logger.error(`Blofin withdrawal record not found for ID ${withdrawId}.`);
        throw new Error(`No matching withdrawal record found for withdrawId: ${withdrawId}`);
      }

      const { state, currency, amount: withdrawalAmount } = relevantRecord;
      const stateMessages = {
        0: 'Pending review!',
        6: 'KYT review!',
        7: 'Processing!',
        3: 'Withdrawal successful',
        2: 'Withdrawal failed',
        4: 'Withdrawal cancelled'
      };
      const stateMsg = stateMessages[state] || 'Unknown state';
      logger.info(`[Blofin] Withdrawal ${withdrawId} state ${state}: ${stateMsg}.`);

      switch (state) {
        case '0':
        case '6':
        case '7':
          return {
            success: true,
            state,
            details: `${stateMsg} — your USDT withdrawal is pending. It can take up to 72 hours.`
          };
        case '3':
          return {
            success: true,
            state,
            details: stateMsg,
            currency,
            amount: withdrawalAmount
          };
        case '2':
        case '4':
          return {
            success: false,
            state,
            details: stateMsg
          };
        default:
          return {
            success: false,
            state,
            details: 'Unexpected response state'
          };
      }
    } catch (error) {
      const message = error.response?.data || error.message || error;
      logger.error(`Blofin withdrawal error: ${JSON.stringify(message, null, 2)}`);
      return {
        success: false,
        message: 'Error communicating with the API',
        error: message
      };
    }
  }

  async getTradingVolume(users) {
    let total = 0;
    users.forEach((user) => {
      const volume = parseFloat(user.totalTradingVolume);
      if (!Number.isNaN(volume)) {
        total += volume;
      }
    });
    logVerbose(`[Blofin] Aggregated trading volume ${total}.`);
    return total;
  }

  async updateVolumeSnapshot(uid) {
    try {
      logVerbose(`[Blofin] Updating volume snapshot for UID ${uid}.`);
      const params = `?uid=${uid}&limit=1`;
      let data = await this.getDirectInvitees(params);

      if (!data?.data?.length) {
        data = await this.getSubAffiliateInvitees(params);
      }

      if (data?.data?.length) {
        const latest = parseFloat(data.data[0].totalTradingVolume) || 0;
        await saveSnapshot(uid, 'blofin', latest, this.kolName);
        logger.info(`[Blofin] Snapshot updated for UID ${uid} with volume ${latest}.`);
        return latest;
      }

      logger.warn(`[Blofin] No invitee data found for UID ${uid}.`);
      return 0;
    } catch (error) {
      logger.error(`Blofin updateVolumeSnapshot error for UID ${uid}: ${error.message}`);
      throw error;
    }
  }

  async calculateVolume(uid, startTime, endTime) {
    try {
      if (!uid || !startTime) {
        throw new Error('UID and start time are required for volume calculation.');
      }
      const endTimeValue = endTime || Date.now();
      const volume = await getVolumeBetween(uid, 'blofin', startTime, endTimeValue);
      logVerbose(`[Blofin] Volume for UID ${uid} between ${startTime} and ${endTimeValue}: ${volume}.`);
      return volume;
    } catch (error) {
      logger.error(`Blofin calculateVolume error for UID ${uid}: ${error.message}`);
      throw new Error(`Failed to calculate volume: ${error.message}`);
    }
  }

  async calculateVolumeBatch(uids, startTime, endTime) {
    try {
      if (!uids?.length) {
        throw new Error('UIDs array is required for batch volume calculation.');
      }
      if (!startTime) {
        throw new Error('Start time is required for volume calculation.');
      }
      const endTimeValue = endTime || Date.now();
      const volumes = await getVolumeBetweenBatch(uids, 'blofin', startTime, endTimeValue);
      logVerbose(`[Blofin] Batch volume calculation completed for ${uids.length} users.`);
      return volumes;
    } catch (error) {
      logger.error(`Blofin calculateVolumeBatch error: ${error.message}`);
      throw new Error(`Failed to calculate batch volume: ${error.message}`);
    }
  }

  async calculateLast30DaysVolume(uid) {
    try {
      await this.updateVolumeSnapshot(uid);
      const volume = await getVolumeForLast30Days(uid, 'blofin');
      logVerbose(`[Blofin] Last 30 days volume for UID ${uid}: ${volume}.`);
      return volume;
    } catch (error) {
      logger.error(`Blofin calculateLast30DaysVolume error for UID ${uid}: ${error.message}`);
      throw new Error(`Failed to calculate trading volume: ${error.message}`);
    }
  }

  async getTotalTradingVolume(uid) {
    try {
      const params = `?uid=${uid}&limit=1`;
      let data = await this.getDirectInvitees(params);

      if (!data?.data?.length) {
        data = await this.getSubAffiliateInvitees(params);
      }

      if (data?.data?.length) {
        const volume = parseFloat(data.data[0].totalTradingVolume) || 0;
        logger.info(`[Blofin] Total trading volume for UID ${uid}: ${volume}.`);
        return volume;
      }
      return 0;
    } catch (error) {
      logger.error(`Blofin getTotalTradingVolume error for UID ${uid}: ${error.message}`);
      throw error;
    }
  }
}

export default BlofinService;
