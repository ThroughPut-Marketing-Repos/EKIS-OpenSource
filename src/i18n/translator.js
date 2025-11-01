import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

const DEFAULT_LOCALES_DIR = path.resolve(process.cwd(), 'src/i18n/locales');

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const extractByPath = (translations, key) => {
  if (!translations || !key) {
    return undefined;
  }

  // Support nested lookups using dot notation (e.g. telegram.help.header).
  return key.split('.').reduce((accumulator, segment) => {
    if (accumulator === undefined || accumulator === null) {
      return undefined;
    }
    return accumulator[segment];
  }, translations);
};

const interpolate = (template, vars = {}) => {
  if (typeof template !== 'string') {
    return template;
  }

  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, token) => {
    const value = vars[token];
    if (value === undefined || value === null) {
      return match;
    }
    return String(value);
  });
};

export class Translator {
  constructor(options = {}) {
    const {
      locale = 'en',
      fallbackLocale = 'en',
      localesDirectory = DEFAULT_LOCALES_DIR
    } = options;

    this.locale = locale;
    this.fallbackLocale = fallbackLocale;
    this.localesDirectory = localesDirectory;
    this.cache = new Map();
  }

  setLocale(locale) {
    if (locale) {
      this.locale = locale;
    }
  }

  setFallbackLocale(fallbackLocale) {
    if (fallbackLocale) {
      this.fallbackLocale = fallbackLocale;
    }
  }

  loadLocale(locale) {
    if (!locale) {
      return null;
    }

    if (this.cache.has(locale)) {
      return this.cache.get(locale);
    }

    const localePath = path.join(this.localesDirectory, `${locale}.json`);

    try {
      if (!fs.existsSync(localePath)) {
        logger.warn(`Locale file not found for locale "${locale}" at ${localePath}.`);
        this.cache.set(locale, null);
        return null;
      }

      const raw = fs.readFileSync(localePath, 'utf-8');
      const data = JSON.parse(raw);
      if (!isObject(data)) {
        logger.warn(`Locale file for "${locale}" must export an object. Found ${typeof data}.`);
        this.cache.set(locale, null);
        return null;
      }

      this.cache.set(locale, data);
      return data;
    } catch (error) {
      logger.error(`Failed to load locale "${locale}" from ${localePath}: ${error.message}`);
      this.cache.set(locale, null);
      return null;
    }
  }

  translate(key, vars = {}, options = {}) {
    if (!key) {
      return '';
    }

    const localesToTry = [];
    if (options.locale) {
      localesToTry.push(options.locale);
    }
    localesToTry.push(this.locale);

    if (this.fallbackLocale) {
      localesToTry.push(this.fallbackLocale);
    }

    // Always ensure English is checked last so callers receive a deterministic fallback
    // even when the configured fallback locale cannot be loaded.
    if (!localesToTry.includes('en')) {
      localesToTry.push('en');
    }

    for (const locale of localesToTry) {
      const translations = this.loadLocale(locale);
      if (!translations) {
        continue;
      }

      const template = extractByPath(translations, key);
      if (typeof template === 'string') {
        return interpolate(template, vars);
      }

      if (Array.isArray(template)) {
        const interpolated = template.map((entry) => (typeof entry === 'string' ? interpolate(entry, vars) : entry));
        return interpolated;
      }

      if (isObject(template)) {
        // Return shallow copy to prevent accidental mutation of cached translations.
        return JSON.parse(JSON.stringify(template, null, 2));
      }
    }

    logger.warn(`Missing translation for key "${key}" (locale chain: ${localesToTry.join(' -> ')}).`);
    return key;
  }

  t(key, vars = {}, options = {}) {
    return this.translate(key, vars, options);
  }
}

export const createTranslator = (options) => new Translator(options);

export default createTranslator;
