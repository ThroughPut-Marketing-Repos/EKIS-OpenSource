import { jest } from '@jest/globals';

const mockVolumeFindAll = jest.fn();
const mockExchangeFindAll = jest.fn();
const loggerMock = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};

jest.unstable_mockModule('../src/database/index.js', () => ({
  getModels: jest.fn(() => ({
    VolumeSnapshot: { findAll: mockVolumeFindAll },
    Exchange: { findAll: mockExchangeFindAll }
  }))
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: loggerMock,
  logger: loggerMock
}));

const { getTradingVolumeStats } = await import('../src/services/statisticsService.js');

describe('statisticsService.getTradingVolumeStats', () => {
  const snapshotBase = {
    exchange: 'blofin',
    exchangeId: 1,
    depositAmount: '5',
    createdAt: new Date('2024-01-01T00:00:00Z')
  };

  const exchangeRecord = {
    get: () => ({
      id: 1,
      name: 'Blofin',
      type: 'blofin',
      api_key: 'k',
      api_secret: 's',
      passphrase: 'p',
      sub_affiliate_invitees: true
    })
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockExchangeFindAll.mockResolvedValue([exchangeRecord]);
  });

  it('attaches affiliate details when requested', async () => {
    mockVolumeFindAll.mockResolvedValue([
      { ...snapshotBase, uid: '100', totalVolume: '50' },
      { ...snapshotBase, uid: '200', totalVolume: '75', createdAt: new Date('2024-01-02T00:00:00Z') }
    ]);

    const aggregateTotals = new Map([
      ['blofin', {
        available: true,
        totalVolume: 500,
        inviteeCount: 10,
        fetchedAt: new Date('2024-01-03T00:00:00Z'),
        depositAvailable: true,
        totalDeposit: 120
      }]
    ]);

    const affiliateDetails = {
      available: true,
      directInvitees: [],
      subInvitees: [],
      subAffiliates: [],
      totals: {
        direct: { invitees: 0, volume: 0, deposit: 0, volumeFormatted: '0', depositFormatted: '0' },
        sub: { invitees: 0, volume: 0, deposit: 0, volumeFormatted: '0', depositFormatted: '0' },
        combined: { invitees: 0, volume: 0, deposit: 0, volumeFormatted: '0', depositFormatted: '0' }
      }
    };

    const fetchExchangeTotals = jest.fn().mockResolvedValue(aggregateTotals);
    const fetchAffiliateDetails = jest.fn().mockResolvedValue(affiliateDetails);

    const stats = await getTradingVolumeStats(
      { includeAffiliateDetails: true, affiliateUid: '42' },
      { fetchExchangeTotals, fetchAffiliateDetails }
    );

    expect(fetchExchangeTotals).toHaveBeenCalledTimes(1);
    expect(fetchAffiliateDetails).toHaveBeenCalledWith(expect.objectContaining({ uid: '42' }));
    expect(stats.exchanges).toHaveLength(1);
    expect(stats.exchanges[0].affiliateDetails).toEqual(affiliateDetails);
  });

  it('skips affiliate detail fetches when not requested', async () => {
    mockVolumeFindAll.mockResolvedValue([
      { ...snapshotBase, uid: '300', totalVolume: '25' }
    ]);

    const fetchExchangeTotals = jest.fn().mockResolvedValue(new Map());
    const fetchAffiliateDetails = jest.fn();

    const stats = await getTradingVolumeStats({}, { fetchExchangeTotals, fetchAffiliateDetails });

    expect(fetchExchangeTotals).toHaveBeenCalledTimes(1);
    expect(fetchAffiliateDetails).not.toHaveBeenCalled();
    expect(stats.exchanges).toHaveLength(1);
    expect(stats.exchanges[0].affiliateDetails).toBeUndefined();
  });
});
