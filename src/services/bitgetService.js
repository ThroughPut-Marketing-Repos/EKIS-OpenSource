import axios from 'axios';
import crypto from 'crypto';
import logger from '../utils/logger.js';

const VERBOSE = process.env.EXCHANGE_VERBOSE_LOGGING === 'true';
const logVerbose = (message, meta) => {
  if (VERBOSE) {
    logger.debug(message, meta);
  }
};

class BitgetService {
  constructor(apiKey, apiSecret, passphrase) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.passphrase = passphrase;
    this.baseUrl = 'https://api.bitget.com';
    logger.info('Bitget service initialised.', {
      hasKey: Boolean(apiKey),
      hasSecret: Boolean(apiSecret),
      hasPassphrase: Boolean(passphrase)
    });
  }

  generateSignature(timestamp, method, path) {
    const prehashString = `${timestamp}${method}${path}`;
    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(prehashString)
      .digest('base64');
    return signature;
  }

  async verifyApiKey() {
    try {
      const timestamp = Date.now().toString();
      const method = 'GET';
      const path = '/api/v2/spot/account/info';
      const signature = this.generateSignature(timestamp, method, path);
      const headers = {
        'ACCESS-KEY': this.apiKey,
        'ACCESS-SIGN': signature,
        'ACCESS-TIMESTAMP': timestamp,
        'ACCESS-PASSPHRASE': this.passphrase,
        'Content-Type': 'application/json'
      };

      const url = `${this.baseUrl}${path}`;
      logVerbose(`[Bitget] GET ${url}`);
      const response = await axios.get(url, { headers });
      logVerbose('[Bitget] API response payload.', response.data);

      if (response.status === 200) {
        logger.info('[Bitget] API key verification succeeded.');
        return { verified: true, userData: response.data };
      }

      logger.warn(`[Bitget] API key verification failed with status ${response.status}.`);
      return { verified: false, reason: 'Invalid API keys' };
    } catch (error) {
      const message = error.response?.data || error.message || error;
      logger.error(`Bitget API key verification error: ${JSON.stringify(message, null, 2)}`);
      return { verified: false, reason: 'Error during verification' };
    }
  }
}

export default BitgetService;
