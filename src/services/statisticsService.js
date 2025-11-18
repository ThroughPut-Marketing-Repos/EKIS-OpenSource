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

const firstDefined = (...values) => {
  for (const value of values) {
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return undefined;
};

const mapBlofinInviteeRecord = (record, source = 'direct') => {
  if (!record) {
    return null;
  }

  const registerTime = ensureDate(record.registerTime);
  const totalTradingVolume = normaliseVolume(firstDefined(
    record.totalTradingVolume,
    record.tradeVol90Day,
    record.tradeVol30Day
  ));
  const totalDeposit = normaliseVolume(firstDefined(
    record.totalDeposit,
    record.totalDepositAmount,
    record.depositAmount30Day,
    record.depositAmount
  ));
  const totalWithdrawal = normaliseVolume(firstDefined(
    record.totalWithdrawal,
    record.withdrawalAmount
  ));
  const equity = normaliseVolume(firstDefined(record.equity, record.totalEquity));

  return {
    id: record.id || null,
    uid: record.uid ? String(record.uid) : null,
    source,
    registerTime,
    registerTimeIso: registerTime ? registerTime.toISOString() : null,
    totalTradingVolume,
    totalTradingVolumeFormatted: formatVolume(totalTradingVolume),
    totalDeposit,
    totalDepositFormatted: formatVolume(totalDeposit),
    totalWithdrawal,
    totalWithdrawalFormatted: formatVolume(totalWithdrawal),
    kycLevel: record.kycLevel ?? null,
    referralCode: record.referralCode || null,
    couponDiscount: record.couponDiscount || null,
    takerVol30Day: normaliseVolume(record.takerVol30Day),
    makerVol30Day: normaliseVolume(record.makerVol30Day),
    tradeVol30Day: normaliseVolume(record.tradeVol30Day),
    takerVol90Day: normaliseVolume(record.takerVol90Day),
    makerVol90Day: normaliseVolume(record.makerVol90Day),
    tradeVol90Day: normaliseVolume(record.tradeVol90Day),
    depositAmount30Day: normaliseVolume(record.depositAmount30Day),
    vipLevel: Number.isFinite(record.vipLevel) ? Number(record.vipLevel) : null,
    equity,
    equityFormatted: formatVolume(equity)
  };
};

const summariseInvitees = (invitees = []) => {
  const safeInvitees = invitees.filter(Boolean);
  const inviteeCount = safeInvitees.length;
  const totalVolume = safeInvitees.reduce((sum, invitee) => sum + normaliseVolume(invitee.totalTradingVolume), 0);
  const totalDeposit = safeInvitees.reduce((sum, invitee) => sum + normaliseVolume(invitee.totalDeposit), 0);

  return {
    invitees: inviteeCount,
    volume: totalVolume,
    deposit: totalDeposit,
    volumeFormatted: formatVolume(totalVolume),
    depositFormatted: formatVolume(totalDeposit)
  };
};

const mapBlofinSubAffiliate = (record) => {
  if (!record) {
    return null;
  }
  const createTime = ensureDate(record.createTime);
  const totalTradingVolume = normaliseVolume(record.totalTradingVolume);
  const totalTradingFee = normaliseVolume(record.totalTradingFee);
  const totalCommission = normaliseVolume(record.totalCommision);
  const myCommission = normaliseVolume(record.myCommision);

  return {
    id: record.id || null,
    uid: record.uid ? String(record.uid) : null,
    commissionRate: record.commissionRate || null,
    createTime,
    createTimeIso: createTime ? createTime.toISOString() : null,
    upperAffiliate: record.upperAffiliate || null,
    invitees: Number.isFinite(Number(record.invitees)) ? Number(record.invitees) : null,
    totalTradedUsers: Number.isFinite(Number(record.totalTradedUsers)) ? Number(record.totalTradedUsers) : null,
    totalTradingVolume,
    totalTradingVolumeFormatted: formatVolume(totalTradingVolume),
    totalTradingFee,
    totalTradingFeeFormatted: formatVolume(totalTradingFee),
    totalCommission,
    totalCommissionFormatted: formatVolume(totalCommission),
    myCommission,
    myCommissionFormatted: formatVolume(myCommission),
    tag: record.tag || null,
    kycLevel: record.kycLevel ?? null
  };
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
  let totalDeposit = 0;
  let inviteeCount = 0;
  let depositValuesProvided = false;

  if (Array.isArray(invitees)) {
    inviteeCount = invitees.length;
    invitees.forEach((invitee) => {
      const rawVolume = invitee?.totalTradingVolume ?? invitee?.totalVolume;
      totalVolume += normaliseVolume(rawVolume);

      const rawDeposit = firstDefined(
        invitee?.totalDeposit,
        invitee?.totalRecharge,
        invitee?.totalDepositAmount,
        invitee?.totalTransfer,
        invitee?.totalTransferAmount,
        invitee?.depositAmount
      );
      if (rawDeposit !== undefined) {
        depositValuesProvided = true;
        totalDeposit += normaliseVolume(rawDeposit);
      }
    });
  }

  logger.info('Blofin aggregate volume fetched successfully.', {
    exchange: exchange.slug || exchange.name || exchange.id,
    inviteeCount,
    totalVolume,
    depositAvailable: depositValuesProvided,
    totalDeposit: depositValuesProvided ? totalDeposit : null
  });

  return {
    available: true,
    totalVolume,
    inviteeCount,
    fetchedAt: new Date(),
    depositAvailable: depositValuesProvided,
    totalDeposit: depositValuesProvided ? totalDeposit : null,
    depositReason: depositValuesProvided ? null : 'missing_deposit_data'
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
  let totalDeposit = 0;
  let inviteeCount = 0;
  let depositValuesProvided = false;

  if (Array.isArray(invitees)) {
    inviteeCount = invitees.length;
    invitees.forEach((invitee) => {
      const rawVolume = invitee?.totalTradingVolume ?? invitee?.totalVolume;
      totalVolume += normaliseVolume(rawVolume);

      const rawDeposit = firstDefined(
        invitee?.totalDeposit,
        invitee?.totalRecharge,
        invitee?.totalDepositAmount,
        invitee?.totalTransfer,
        invitee?.totalTransferAmount,
        invitee?.depositAmount
      );
      if (rawDeposit !== undefined) {
        depositValuesProvided = true;
        totalDeposit += normaliseVolume(rawDeposit);
      }
    });
  }

  logger.info('Bitunix aggregate volume fetched successfully.', {
    exchange: exchange.slug || exchange.name || exchange.id,
    inviteeCount,
    totalVolume,
    depositAvailable: depositValuesProvided,
    totalDeposit: depositValuesProvided ? totalDeposit : null
  });

  return {
    available: true,
    totalVolume,
    inviteeCount,
    fetchedAt: new Date(),
    depositAvailable: depositValuesProvided,
    totalDeposit: depositValuesProvided ? totalDeposit : null,
    depositReason: depositValuesProvided ? null : 'deposit_data_unavailable'
  };
};

const aggregateFetchers = {
  blofin: fetchBlofinAggregateTotals,
  bitunix: fetchBitunixAggregateTotals
};

const fetchBlofinAffiliateDetails = async ({ exchange, uid = null }) => {
  if (!exchange?.api_key || !exchange?.api_secret || !exchange?.passphrase) {
    logger.warn('Blofin affiliate details unavailable due to missing credentials.', {
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

  logger.info('Fetching Blofin affiliate details for statistics.', {
    exchange: exchange.slug || exchange.name || exchange.id,
    uid: uid || null
  });

  const [basicInfoResult, referralCodesResult] = await Promise.allSettled([
    service.getAffiliateBasicInfo(),
    service.getReferralCodes()
  ]);

  if (basicInfoResult.status === 'rejected') {
    logger.warn('Failed to fetch Blofin affiliate basic info.', {
      exchange: exchange.slug || exchange.name || exchange.id,
      error: basicInfoResult.reason?.message || basicInfoResult.reason
    });
  }
  if (referralCodesResult.status === 'rejected') {
    logger.warn('Failed to fetch Blofin referral codes.', {
      exchange: exchange.slug || exchange.name || exchange.id,
      error: referralCodesResult.reason?.message || referralCodesResult.reason
    });
  }

  const directInviteesRaw = await service.getAllDirectInvitees({ uid });
  const includeSubs = Boolean(exchange.sub_affiliate_invitees);
  const subInviteesRaw = includeSubs ? await service.getAllSubInvitees({ uid }) : [];
  const subAffiliatesRaw = includeSubs ? await service.getAllSubAffiliates() : [];

  const directInvitees = directInviteesRaw
    .map((record) => mapBlofinInviteeRecord(record, 'direct'))
    .filter(Boolean)
    .sort((a, b) => b.totalTradingVolume - a.totalTradingVolume);
  const subInvitees = subInviteesRaw
    .map((record) => mapBlofinInviteeRecord(record, 'sub'))
    .filter(Boolean)
    .sort((a, b) => b.totalTradingVolume - a.totalTradingVolume);
  const subAffiliates = subAffiliatesRaw
    .map((record) => mapBlofinSubAffiliate(record))
    .filter(Boolean)
    .sort((a, b) => b.totalTradingVolume - a.totalTradingVolume);

  const totals = {
    direct: summariseInvitees(directInvitees),
    sub: summariseInvitees(subInvitees)
  };
  totals.combined = summariseInvitees([...directInvitees, ...subInvitees]);

  logger.info('Blofin affiliate details fetched.', {
    exchange: exchange.slug || exchange.name || exchange.id,
    directInvitees: totals.direct.invitees,
    subInvitees: totals.sub.invitees,
    filteredUid: uid || null
  });

  return {
    available: true,
    fetchedAt: new Date(),
    filteredUid: uid || null,
    type: exchange.type || 'blofin',
    basicInfo: basicInfoResult.status === 'fulfilled' ? basicInfoResult.value?.data || null : null,
    referralCodes: referralCodesResult.status === 'fulfilled'
      ? (Array.isArray(referralCodesResult.value?.data) ? referralCodesResult.value.data : [])
      : [],
    directInvitees,
    subInvitees,
    subAffiliates,
    supportsSubAffiliates: includeSubs,
    totals
  };
};

const affiliateFetchers = {
  blofin: fetchBlofinAffiliateDetails
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

const defaultFetchAffiliateDetails = async ({ exchangeRecord, uid }) => {
  if (!exchangeRecord) {
    return null;
  }

  const fetcher = affiliateFetchers[exchangeRecord.type];
  if (!fetcher) {
    return { available: false, reason: 'unsupported_exchange', type: exchangeRecord.type };
  }

  try {
    return await fetcher({ exchange: exchangeRecord, uid });
  } catch (error) {
    logger.error('Failed to fetch affiliate details for exchange.', {
      exchange: exchangeRecord.slug || exchangeRecord.name || exchangeRecord.id,
      type: exchangeRecord.type,
      error: error.message
    });
    return { available: false, reason: 'fetch_failed', error: error.message };
  }
};

/**
 * Aggregate the latest trading volume snapshots for each UID.
 * Returns totals grouped by exchange along with formatted values
 * to simplify presentation across chat platforms.
 */
export const getTradingVolumeStats = async ({ exchangeId = null, includeAffiliateDetails = false, affiliateUid = null } = {}, dependencies = {}) => {
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
      attributes: ['uid', 'exchange', 'exchangeId', 'totalVolume', 'depositAmount', 'createdAt'],
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
        totalDeposit: 0,
        accountCount: 0,
        lastSnapshotAt: null,
        exchangeDbId: snapshot.exchangeId || null,
        exchangeDepositAvailable: null,
        exchangeTotalDeposit: null,
        exchangeDepositUnavailableReason: null
      };

      current.totalVolume += volume;
      current.totalDeposit += normaliseVolume(snapshot.depositAmount);
      current.accountCount += 1;

      if (!current.lastSnapshotAt || (createdAt && createdAt > current.lastSnapshotAt)) {
        current.lastSnapshotAt = createdAt;
      }

      statsByExchange.set(exchange, current);
    }

    const exchangeRecords = await Exchange.findAll();
    const plainExchangeRecords = exchangeRecords
      .map((record) => {
        const plain = extractPlainRecord(record);
        const slug = normaliseExchangeSlug(plain?.name, plain?.id);
        if (!slug) {
          return null;
        }
        return { ...plain, slug };
      })
      .filter(Boolean);

    const exchangeRecordMap = new Map(plainExchangeRecords.map((record) => [record.slug, record]));

    const fetchExchangeTotals = dependencies.fetchExchangeTotals || defaultFetchExchangeTotals;
    const aggregateTotals = await fetchExchangeTotals({ exchangeId, exchangeRecords });

    aggregateTotals.forEach((aggregate, slug) => {
      const current = statsByExchange.get(slug) || {
        exchange: slug,
        totalVolume: 0,
        totalDeposit: 0,
        accountCount: 0,
        lastSnapshotAt: null,
        exchangeDbId: aggregate?.id || null,
        exchangeDepositAvailable: null,
        exchangeTotalDeposit: null,
        exchangeDepositUnavailableReason: null
      };
      current.exchangeDbId = current.exchangeDbId || aggregate?.id || null;

      if (aggregate?.available) {
        current.exchangeTotalAvailable = true;
        current.exchangeTotalVolume = normaliseVolume(aggregate.totalVolume);
        current.exchangeInviteeCount = Number.isFinite(aggregate.inviteeCount)
          ? Number(aggregate.inviteeCount)
          : null;
        current.exchangeTotalsFetchedAt = ensureDate(aggregate.fetchedAt) || new Date();

        if (aggregate.depositAvailable === true) {
          current.exchangeDepositAvailable = true;
          current.exchangeTotalDeposit = normaliseVolume(aggregate.totalDeposit);
          current.exchangeDepositUnavailableReason = null;
        } else if (aggregate.depositAvailable === false) {
          current.exchangeDepositAvailable = false;
          current.exchangeTotalDeposit = null;
          current.exchangeDepositUnavailableReason = aggregate.depositReason || null;
        }
      } else if (aggregate && aggregate.available === false) {
        current.exchangeTotalAvailable = false;
        current.exchangeTotalVolume = 0;
        current.exchangeInviteeCount = null;
        current.exchangeTotalsFetchedAt = null;
        current.exchangeDepositAvailable = false;
        current.exchangeTotalDeposit = null;
        current.exchangeDepositUnavailableReason = aggregate.depositReason || aggregate.reason || null;
      }

      statsByExchange.set(slug, current);
    });

    const combinedEntries = Array.from(statsByExchange.values());

    const exchanges = combinedEntries
      .map((entry) => {
        const lastSnapshotAt = ensureDate(entry.lastSnapshotAt);
        const totalsFetchedAt = ensureDate(entry.exchangeTotalsFetchedAt);
        const exchangeTotalAvailable = entry.exchangeTotalAvailable === true;
        const exchangeDepositAvailable = entry.exchangeDepositAvailable === true;
        const verifiedDeposit = normaliseVolume(entry.totalDeposit);
        const exchangeTotalDeposit = exchangeDepositAvailable
          ? normaliseVolume(entry.exchangeTotalDeposit)
          : null;
        const unverifiedVolume = exchangeTotalAvailable
          ? Math.max(normaliseVolume(entry.exchangeTotalVolume) - normaliseVolume(entry.totalVolume), 0)
          : null;
        const unverifiedDeposit = exchangeDepositAvailable
          ? Math.max(exchangeTotalDeposit - verifiedDeposit, 0)
          : null;
        return {
          exchange: entry.exchange,
          exchangeDbId: entry.exchangeDbId || null,
          totalVolume: entry.totalVolume,
          totalVolumeFormatted: formatVolume(entry.totalVolume),
          totalDeposit: verifiedDeposit,
          totalDepositFormatted: formatVolume(verifiedDeposit),
          accountCount: entry.accountCount,
          lastSnapshotAt,
          lastSnapshotIso: lastSnapshotAt ? lastSnapshotAt.toISOString() : null,
          exchangeTotalAvailable,
          exchangeTotalVolume: exchangeTotalAvailable ? normaliseVolume(entry.exchangeTotalVolume) : 0,
          exchangeTotalVolumeFormatted: exchangeTotalAvailable
            ? formatVolume(entry.exchangeTotalVolume)
            : null,
          exchangeDepositAvailable,
          exchangeTotalDeposit,
          exchangeTotalDepositFormatted: exchangeDepositAvailable
            ? formatVolume(exchangeTotalDeposit)
            : null,
          exchangeInviteeCount: exchangeTotalAvailable ? entry.exchangeInviteeCount : null,
          exchangeTotalsFetchedAt: totalsFetchedAt,
          exchangeTotalsFetchedAtIso: totalsFetchedAt ? totalsFetchedAt.toISOString() : null,
          exchangeDepositUnavailableReason: entry.exchangeDepositUnavailableReason || null,
          unverifiedVolume,
          unverifiedVolumeFormatted: unverifiedVolume !== null ? formatVolume(unverifiedVolume) : null,
          unverifiedDeposit,
          unverifiedDepositFormatted:
            unverifiedDeposit !== null ? formatVolume(unverifiedDeposit) : null
        };
      })
      .sort((a, b) => b.totalVolume - a.totalVolume);

    if (includeAffiliateDetails) {
      const fetchAffiliateDetails = dependencies.fetchAffiliateDetails || defaultFetchAffiliateDetails;
      for (const entry of exchanges) {
        const exchangeRecord = exchangeRecordMap.get(entry.exchange);
        if (!exchangeRecord) {
          continue;
        }
        const details = await fetchAffiliateDetails({
          exchangeRecord,
          uid: affiliateUid,
          statsEntry: entry
        });
        if (details) {
          entry.affiliateDetails = details;
        }
      }
    }

    const grandTotalVolume = exchanges.reduce((sum, entry) => sum + entry.totalVolume, 0);
    const grandTotalDeposit = exchanges.reduce((sum, entry) => sum + entry.totalDeposit, 0);
    const grandTotalAccounts = exchanges.reduce((sum, entry) => sum + entry.accountCount, 0);
    const exchangeTotalsAvailableCount = exchanges.reduce(
      (sum, entry) => (entry.exchangeTotalAvailable ? sum + 1 : sum),
      0
    );
    const grandExchangeVolume = exchanges.reduce(
      (sum, entry) => (entry.exchangeTotalAvailable ? sum + entry.exchangeTotalVolume : sum),
      0
    );
    const exchangeDepositAvailableCount = exchanges.reduce(
      (sum, entry) => (entry.exchangeDepositAvailable ? sum + 1 : sum),
      0
    );
    const grandExchangeDeposit = exchanges.reduce(
      (sum, entry) => (entry.exchangeDepositAvailable ? sum + entry.exchangeTotalDeposit : sum),
      0
    );
    const grandExchangeInvitees = exchanges.reduce((sum, entry) => {
      if (!entry.exchangeTotalAvailable || !Number.isFinite(entry.exchangeInviteeCount)) {
        return sum;
      }
      return sum + Number(entry.exchangeInviteeCount);
    }, 0);
    const grandUnverifiedVolume = exchanges.reduce(
      (sum, entry) => (entry.unverifiedVolume !== null ? sum + entry.unverifiedVolume : sum),
      0
    );
    const grandUnverifiedDeposit = exchanges.reduce(
      (sum, entry) => (entry.unverifiedDeposit !== null ? sum + entry.unverifiedDeposit : sum),
      0
    );

    return {
      exchanges,
      grandTotalVolume,
      grandTotalDeposit,
      grandTotalAccounts,
      grandTotalVolumeFormatted: formatVolume(grandTotalVolume),
      grandTotalDepositFormatted: formatVolume(grandTotalDeposit),
      exchangeTotalsAvailableCount,
      grandExchangeVolume,
      grandExchangeVolumeFormatted: exchangeTotalsAvailableCount > 0
        ? formatVolume(grandExchangeVolume)
        : null,
      grandExchangeInvitees: exchangeTotalsAvailableCount > 0 ? grandExchangeInvitees : null,
      exchangeDepositAvailableCount,
      grandExchangeDeposit: exchangeDepositAvailableCount > 0 ? grandExchangeDeposit : null,
      grandExchangeDepositFormatted:
        exchangeDepositAvailableCount > 0 ? formatVolume(grandExchangeDeposit) : null,
      grandUnverifiedVolume: exchangeTotalsAvailableCount > 0 ? grandUnverifiedVolume : null,
      grandUnverifiedVolumeFormatted:
        exchangeTotalsAvailableCount > 0 ? formatVolume(grandUnverifiedVolume) : null,
      grandUnverifiedDeposit: exchangeDepositAvailableCount > 0 ? grandUnverifiedDeposit : null,
      grandUnverifiedDepositFormatted:
        exchangeDepositAvailableCount > 0 ? formatVolume(grandUnverifiedDeposit) : null
    };
  } catch (error) {
    logger.error('Failed to fetch trading volume statistics.', { scope, error: error.message });
    throw error;
  }
};

export default {
  getTradingVolumeStats
};
