import logger from './logger.js';

export const START_MESSAGE_DELIMITER = '---';

const sanitizeSegment = (value) => {
  if (typeof value === 'undefined' || value === null) {
    return null;
  }

  const text = String(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\\n/g, '\n')
    .trim();

  return text.length > 0 ? text : null;
};

const tryParseJsonArray = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    logger.debug(`Failed to parse Telegram start message JSON: ${error.message}`);
    return null;
  }
};

export const normaliseStartMessages = (value) => {
  if (value === null || typeof value === 'undefined') {
    return [];
  }

  const segments = [];
  const appendSegment = (segment) => {
    const sanitised = sanitizeSegment(segment);
    if (sanitised) {
      segments.push(sanitised);
    }
  };

  if (Array.isArray(value)) {
    value.forEach(appendSegment);
    return segments;
  }

  const candidateArray = tryParseJsonArray(value);
  if (candidateArray) {
    candidateArray.forEach(appendSegment);
    return segments;
  }

  const text = String(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const escapedDelimiter = START_MESSAGE_DELIMITER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const delimiterPattern = new RegExp(`\n\s*${escapedDelimiter}\s*\n`, 'g');
  const pieces = text.split(delimiterPattern);
  if (pieces.length === 1) {
    appendSegment(pieces[0]);
    return segments;
  }

  pieces.forEach(appendSegment);
  return segments;
};

export const serialiseStartMessages = (messages) => {
  const normalised = normaliseStartMessages(messages);
  if (normalised.length === 0) {
    return null;
  }
  if (normalised.length === 1) {
    return normalised[0];
  }
  return JSON.stringify(normalised);
};

export default normaliseStartMessages;
