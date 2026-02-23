import axios from 'axios';
import { saveSnapshot } from './volumeSnapshotService.js';
import logger from '../utils/logger.js';

const VERBOSE = process.env.EXCHANGE_VERBOSE_LOGGING === 'true';
const logVerbose = (message, meta) => {
  if (VERBOSE) {
    logger.debug(message, meta);
  }
};

class BTCCService {
  constructor(agentOpenId, kolName = null) {
    this.agentOpenId = agentOpenId;
    this.affiliateBaseUrl = 'https://kol.btcc.com/api/openapi/v1';
    this.kolName = kolName;
    logger.info('BTCC service initialised.', {
      hasAgentOpenId: Boolean(agentOpenId),
      kolName
    });
  }

  /**
   * Get invited customers with optional filters
   * @param {Object} params - Query parameters
   * @returns {Promise<Object>} - Response data
   */
  async getInvitedCustomers(params = {}) {
    const url = `${this.affiliateBaseUrl}/invited-customers`;
    try {
      const query = { agentOpenId: this.agentOpenId, ...params };
      logVerbose(`[BTCC] GET ${url}`, { params: query });
      const response = await axios.get(url, { params: query });
      logVerbose('[BTCC] Response', response.data);

      return response.data;
    } catch (error) {
      logger.error('Error fetching invited customers', {
        error: error.response?.data || error.message
      });
      if (VERBOSE && error.response?.data) {
        logger.debug('[BTCC] Error response', error.response.data);
      }
      throw error;
    }
  }

  /**
   * Get customer balance details using the customer-balance endpoint
   * @param {string} uid - User ID to check
   * @returns {Promise<Object>} - Balance details (walletBalance, stockBalance, contractBalance, totalBalance)
   */
  async getCustomerBalance(uid) {
    const url = `${this.affiliateBaseUrl}/customer-balance`;
    try {
      const query = { agentOpenId: this.agentOpenId, uid };
      logVerbose(`[BTCC] GET ${url}`, { params: query });
      const response = await axios.get(url, { params: query });
      logVerbose('[BTCC] Customer balance response', response.data);

      if (response.data.code !== 0) {
        throw new Error(response.data.message || 'Failed to fetch customer balance');
      }

      return response.data.data || {};
    } catch (error) {
      logger.error('Error fetching customer balance', {
        error: error.response?.data || error.message
      });
      if (VERBOSE && error.response?.data) {
        logger.debug('[BTCC] Error response', error.response.data);
      }
      throw error;
    }
  }

  /**
   * Get account balance (total deposit amount) for a specific user
   * @param {string} uid - User ID to check
   * @returns {Promise<number>} - Total deposit amount
   */
  async getAccountBalance(uid) {
    try {
      const response = await this.getInvitedCustomers();
      if (response.code !== 0 || !response.data?.records) {
        throw new Error(response.message || 'Failed to fetch account data');
      }

      const user = response.data.records.find((record) => record.uid === uid);

      if (!user) {
        throw new Error('User not found in invited customers');
      }

      return user.totalDepositAmount || 0;
    } catch (error) {
      logger.error('Error fetching account balance', { error: error.message });
      throw error;
    }
  }

  /**
   * Get trading volume for a specific user
   * @param {string} uid - User ID to check
   * @returns {Promise<number>} - Total trading volume
   */
  async getTradingVolume(uid) {
    try {
      const response = await this.getInvitedCustomers();

      if (response.code !== 0 || !response.data?.records) {
        throw new Error(response.message || 'Failed to fetch trading data');
      }

      const user = response.data.records.find((record) => record.uid === uid);

      if (!user) {
        throw new Error('User not found in invited customers');
      }

      return user.totalTradingVolume || 0;
    } catch (error) {
      logger.error('Error fetching trading volume', { error: error.message });
      throw error;
    }
  }

  /**
   * Verify if a user meets the deposit threshold by checking invitees
   * @param {string} uid - User ID to verify
   * @param {number} depositThreshold - Minimum deposit amount required
   * @returns {Promise<Object>} - Verification result
   */
  async verifyUid(uid, depositThreshold) {
    try {
      logVerbose(`[BTCC] Verifying UID ${uid}`, { depositThreshold });
      const response = await this.getInvitedCustomers();
      logVerbose(`[BTCC] Invited customers payload for UID ${uid}`, response);

      if (response.code !== 0 || !response.data?.records) {
        return {
          verified: false,
          reason: 'api_error',
          message: response.message || 'Failed to fetch user data'
        };
      }

      const user = response.data.records.find((record) => record.uid === uid);

      if (!user) {
        logVerbose(`[BTCC] UID ${uid} not found in records.`);
        return {
          verified: false,
          reason: 'user_not_found'
        };
      }

      const totalDeposit = user.totalDepositAmount || 0;
      const verified = totalDeposit >= depositThreshold;
      logVerbose(`[BTCC] UID ${uid} totalDeposit: ${totalDeposit}`, { threshold: depositThreshold });

      if (verified) {
        try {
          const volume = user.totalTradingVolume || 0;
          await saveSnapshot(uid, 'btcc', volume, this.kolName, totalDeposit);
        } catch (snapErr) {
          logger.error('Error saving verification snapshot', {
            error: snapErr.message || snapErr
          });
        }
      }

      return {
        verified,
        userData: {
          balance: totalDeposit,
          volume: user.totalTradingVolume || 0,
          deposited: user.deposited || false,
          kycLevel: user.kycLevel || 'KYC0'
        },
        reason: verified ? 'verified' : 'no deposit'
      };
    } catch (error) {
      logger.error('Error verifying user', { error: error.message });
      return {
        verified: false,
        reason: 'verification_failed',
        message: error.message
      };
    }
  }

  /**
   * Calculate last 30 days trading volume for a user
   * Note: The API doesn't provide historical volume data directly,
   * so we use the total trading volume from the API
   * @param {string} uid - User ID to check
   * @returns {Promise<number>} - Trading volume (total, as historical not available)
   */
  async calculateLast30DaysVolume(uid) {
    try {
      // Since the API doesn't provide historical volume data,
      // we'll return the total trading volume
      const volume = await this.getTradingVolume(uid);
      return volume;
    } catch (error) {
      logger.error('Error calculating 30-day volume', { error: error.message });
      throw error;
    }
  }

  async calculateVolume(uid, startTime, endTime = null) {
    try {
      // The BTCC API does not support historical volume queries directly,
      // so we will return the total trading volume as a fallback.
      const totalVolume = await this.getTradingVolume(uid);
      return totalVolume;
    } catch (error) {
      logger.error('Error calculating volume', { error: error.message });
      throw error;
    }
  }

  async getTotalTradingVolume(uid) {
    try {
      return await this.getTradingVolume(uid);
    } catch (error) {
      logger.error('Error fetching total trading volume', { error: error.message });
      throw error;
    }
  }
}

export default BTCCService;

