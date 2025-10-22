import logger from '../utils/logger.js';
import { getModels } from '../database/index.js';
import BlofinService from './blofinService.js';
import BitunixService from './bitunixService.js';

const formatVolume = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '0';
  }
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0
  }).format(numeric);
};

const normaliseVolume = (value) => {
  if (value === null || value === undefined) {
    return 0;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
};

const normaliseExchangeSlug = (name, fallbackId = null) => {
  if (!name && !fallbackId) {
    return null;
  }

  const safeName = typeof name === 'string' ? name : '';
  const slug = safeName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const trimmed = slug.replace(/^-+|-+$/g, '');

  if (trimmed) {
    return trimmed;
  }

  if (fallbackId !== null && fallbackId !== undefined) {
    return `exchange-${fallbackId}`;
  }

  return null;
};

const ensureDate = (value) => {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const extractPlainRecord = (record) => {
  if (record && typeof record.get === 'function') {
    return record.get({ plain: true });
  }
  return record || {};
};

const fetchBlofinAggregateTotals = async (exchange) => {
  if (!exchange?.api_key || !exchange?.api_secret || !exchange?.passphrase) {
    logger.warn('Blofin aggregate volume unavailable due to missing credentials.', {
      exchange: exchange?.slug || exchange?.name || exchange?.id
    });
    return { available: false, reason: 'missing_credentials' };
  }

  const service = new BlofinService(
    exchange.api_key,
    exchange.api_secret,
    exchange.passphrase,
    Boolean(exchange.sub_affiliate_invitees),
    exchange.name || null
  );

  logger.info('Fetching aggregate Blofin trading volume for statistics.', {
    exchange: exchange.slug || exchange.name || exchange.id
  });

  const invitees = await service.fetchInvitees(false);

  let totalVolume = 0;
  let inviteeCount = 0;

  if (Array.isArray(invitees)) {
    inviteeCount = invitees.length;
    invitees.forEach((invitee) => {
      const rawVolume = invitee?.totalTradingVolume ?? invitee?.totalVolume;
      totalVolume += normaliseVolume(rawVolume);
    });
  }

  logger.info('Blofin aggregate volume fetched successfully.', {
    exchange: exchange.slug || exchange.name || exchange.id,
    inviteeCount,
    totalVolume
  });

  return {
    available: true,
    totalVolume,
    inviteeCount,
    fetchedAt: new Date()
  };
};

const fetchBitunixAggregateTotals = async (exchange) => {
  if (!exchange?.api_key || !exchange?.api_secret) {
    logger.warn('Bitunix aggregate volume unavailable due to missing credentials.', {
      exchange: exchange?.slug || exchange?.name || exchange?.id
    });
    return { available: false, reason: 'missing_credentials' };
  }

  const service = new BitunixService(exchange.api_key, exchange.api_secret, exchange.name || null);

  logger.info('Fetching aggregate Bitunix trading volume for statistics.', {
    exchange: exchange.slug || exchange.name || exchange.id
  });

  const invitees = await service.fetchInvitees();

  let totalVolume = 0;
  let inviteeCount = 0;

  if (Array.isArray(invitees)) {
    inviteeCount = invitees.length;
    invitees.forEach((invitee) => {
      const rawVolume = invitee?.totalTradingVolume ?? invitee?.totalVolume;
      totalVolume += normaliseVolume(rawVolume);
    });
  }

  logger.info('Bitunix aggregate volume fetched successfully.', {
    exchange: exchange.slug || exchange.name || exchange.id,
    inviteeCount,
    totalVolume
  });

  return {
    available: true,
    totalVolume,
    inviteeCount,
    fetchedAt: new Date()
  };
};

const aggregateFetchers = {
  blofin: fetchBlofinAggregateTotals,
  bitunix: fetchBitunixAggregateTotals
};

const defaultFetchExchangeTotals = async ({ exchangeId = null, exchangeRecords = [] } = {}) => {
  const totals = new Map();

  for (const record of exchangeRecords) {
    const exchange = extractPlainRecord(record);
    const slug = normaliseExchangeSlug(exchange?.name, exchange?.id);
    if (!slug) {
      continue;
    }

    if (exchangeId && slug !== exchangeId) {
      continue;
    }

    const fetcher = aggregateFetchers[exchange?.type];
    if (!fetcher) {
      logger.debug('Aggregate trading volume unavailable for exchange type.', {
        exchange: slug,
        type: exchange?.type || 'unknown'
      });
      continue;
    }

    try {
      const result = await fetcher({ ...exchange, slug });
      if (!result) {
        continue;
      }

      totals.set(slug, result);
    } catch (error) {
      logger.error('Failed to fetch aggregate trading volume for exchange.', {
        exchange: slug,
        type: exchange?.type || 'unknown',
        error: error.message
      });
    }
  }

  return totals;
};

/**
 * Aggregate the latest trading volume snapshots for each UID.
 * Returns totals grouped by exchange along with formatted values
 * to simplify presentation across chat platforms.
 */
export const getTradingVolumeStats = async ({ exchangeId = null } = {}, dependencies = {}) => {
  const { VolumeSnapshot, Exchange } = getModels();
  const scope = exchangeId || 'all';

  logger.info('Fetching trading volume statistics.', { scope });

  try {
    const where = {};
    if (exchangeId) {
      where.exchange = exchangeId;
    }

    const snapshots = await VolumeSnapshot.findAll({
      where,
      attributes: ['uid', 'exchange', 'exchangeId', 'totalVolume', 'createdAt'],
      order: [
        ['exchange', 'ASC'],
        ['uid', 'ASC'],
        ['createdAt', 'DESC']
      ]
    });

    const seen = new Set();
    const statsByExchange = new Map();

    for (const snapshot of snapshots) {
      const exchange = snapshot.exchange;
      const uid = snapshot.uid;
      const key = `${exchange}::${uid}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const volume = normaliseVolume(snapshot.totalVolume);
      const createdAt = snapshot.createdAt ? new Date(snapshot.createdAt) : null;

      const current = statsByExchange.get(exchange) || {
        exchange,
        totalVolume: 0,
        accountCount: 0,
        lastSnapshotAt: null,
        exchangeDbId: snapshot.exchangeId || null
      };

      current.totalVolume += volume;
      current.accountCount += 1;

      if (!current.lastSnapshotAt || (createdAt && createdAt > current.lastSnapshotAt)) {
        current.lastSnapshotAt = createdAt;
      }

      statsByExchange.set(exchange, current);
    }

    const exchangeRecords = await Exchange.findAll();
    const fetchExchangeTotals = dependencies.fetchExchangeTotals || defaultFetchExchangeTotals;
    const aggregateTotals = await fetchExchangeTotals({ exchangeId, exchangeRecords });

    aggregateTotals.forEach((aggregate, slug) => {
      const current = statsByExchange.get(slug) || {
        exchange: slug,
        totalVolume: 0,
        accountCount: 0,
        lastSnapshotAt: null,
        exchangeDbId: aggregate?.id || null
      };
      current.exchangeDbId = current.exchangeDbId || aggregate?.id || null;

      if (aggregate?.available) {
        current.exchangeTotalAvailable = true;
        current.exchangeTotalVolume = normaliseVolume(aggregate.totalVolume);
        current.exchangeInviteeCount = Number.isFinite(aggregate.inviteeCount)
          ? Number(aggregate.inviteeCount)
          : null;
        current.exchangeTotalsFetchedAt = ensureDate(aggregate.fetchedAt) || new Date();
      } else if (aggregate && aggregate.available === false) {
        current.exchangeTotalAvailable = false;
        current.exchangeTotalVolume = 0;
        current.exchangeInviteeCount = null;
        current.exchangeTotalsFetchedAt = null;
      }

      statsByExchange.set(slug, current);
    });

    const combinedEntries = Array.from(statsByExchange.values());

    const exchanges = combinedEntries
      .map((entry) => {
        const lastSnapshotAt = ensureDate(entry.lastSnapshotAt);
        const totalsFetchedAt = ensureDate(entry.exchangeTotalsFetchedAt);
        const exchangeTotalAvailable = entry.exchangeTotalAvailable === true;
        return {
          exchange: entry.exchange,
          exchangeDbId: entry.exchangeDbId || null,
          totalVolume: entry.totalVolume,
          totalVolumeFormatted: formatVolume(entry.totalVolume),
          accountCount: entry.accountCount,
          lastSnapshotAt,
          lastSnapshotIso: lastSnapshotAt ? lastSnapshotAt.toISOString() : null,
          exchangeTotalAvailable,
          exchangeTotalVolume: exchangeTotalAvailable ? normaliseVolume(entry.exchangeTotalVolume) : 0,
          exchangeTotalVolumeFormatted: exchangeTotalAvailable
            ? formatVolume(entry.exchangeTotalVolume)
            : null,
          exchangeInviteeCount: exchangeTotalAvailable ? entry.exchangeInviteeCount : null,
          exchangeTotalsFetchedAt: totalsFetchedAt,
          exchangeTotalsFetchedAtIso: totalsFetchedAt ? totalsFetchedAt.toISOString() : null
        };
      })
      .sort((a, b) => b.totalVolume - a.totalVolume);

    const grandTotalVolume = exchanges.reduce((sum, entry) => sum + entry.totalVolume, 0);
    const grandTotalAccounts = exchanges.reduce((sum, entry) => sum + entry.accountCount, 0);
    const exchangeTotalsAvailableCount = exchanges.reduce(
      (sum, entry) => (entry.exchangeTotalAvailable ? sum + 1 : sum),
      0
    );
    const grandExchangeVolume = exchanges.reduce(
      (sum, entry) => (entry.exchangeTotalAvailable ? sum + entry.exchangeTotalVolume : sum),
      0
    );
    const grandExchangeInvitees = exchanges.reduce((sum, entry) => {
      if (!entry.exchangeTotalAvailable || !Number.isFinite(entry.exchangeInviteeCount)) {
        return sum;
      }
      return sum + Number(entry.exchangeInviteeCount);
    }, 0);

    return {
      exchanges,
      grandTotalVolume,
      grandTotalAccounts,
      grandTotalVolumeFormatted: formatVolume(grandTotalVolume),
      exchangeTotalsAvailableCount,
      grandExchangeVolume,
      grandExchangeVolumeFormatted: exchangeTotalsAvailableCount > 0
        ? formatVolume(grandExchangeVolume)
        : null,
      grandExchangeInvitees: exchangeTotalsAvailableCount > 0 ? grandExchangeInvitees : null
    };
  } catch (error) {
    logger.error('Failed to fetch trading volume statistics.', { scope, error: error.message });
    throw error;
  }
};

export default {
  getTradingVolumeStats
};
