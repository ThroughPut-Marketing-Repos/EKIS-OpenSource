import { jest } from '@jest/globals';
import { createTranslator } from '../src/i18n/translator.js';

const loggerMock = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};

const startPollingMock = jest.fn();
const stopPollingMock = jest.fn();
const onMock = jest.fn();
const onTextMock = jest.fn();
const sendMessageMock = jest.fn();
const answerCallbackQueryMock = jest.fn();
const createChatInviteLinkMock = jest.fn();
const saveVerifiedUserMock = jest.fn();

class VerifiedUserConflictErrorMock extends Error {}

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: loggerMock,
  logger: loggerMock
}));

jest.unstable_mockModule('../src/services/verificationService.js', () => ({
  saveVerifiedUser: saveVerifiedUserMock,
  VerifiedUserConflictError: VerifiedUserConflictErrorMock
}));

const TelegramBotMock = jest.fn().mockImplementation(() => ({
  on: onMock,
  onText: onTextMock,
  stopPolling: stopPollingMock,
  startPolling: startPollingMock,
  sendMessage: sendMessageMock,
  answerCallbackQuery: answerCallbackQueryMock,
  createChatInviteLink: createChatInviteLinkMock
}));

jest.unstable_mockModule('node-telegram-bot-api', () => ({
  default: TelegramBotMock
}));

const {
  createTelegramSettingsHandler,
  createTelegramBot,
  isTelegramAdmin,
  createTelegramOwnerHandler,
  normaliseGroupIds
} = await import('../src/platforms/telegramBot.js');

// Create a real translator instance for tests
const translator = createTranslator({ locale: 'en', fallbackLocale: 'en' });

describe('normaliseGroupIds', () => {
  it('parses legacy JSON strings without duplicating entries', () => {
    const result = normaliseGroupIds({
      groupIds: ['-4910105399'],
      groupId: '["-4910105399"]'
    });

    expect(result).toEqual(['-4910105399']);
  });
});

describe('telegram settings command', () => {
  let telegramConfig;
  const createMessage = (overrides = {}) => ({
    chat: { id: 1 },
    from: { id: '50' },
    ...overrides
  });

  beforeEach(() => {
    telegramConfig = { admins: ['100'], ownerId: null };
  });

  it('checks admin membership', () => {
    expect(isTelegramAdmin({ admins: ['100'], ownerId: null }, createMessage({ from: { id: '100' } }))).toBe(true);
    expect(isTelegramAdmin({ admins: ['100'], ownerId: null }, createMessage({ from: { id: '101' } }))).toBe(false);
  });

  it('treats the registered owner as an admin', () => {
    expect(isTelegramAdmin({ admins: [], ownerId: '200' }, createMessage({ from: { id: '200' } }))).toBe(true);
  });

  it('blocks non-admin users', async () => {
    const bot = { sendMessage: jest.fn() };
    const handler = createTelegramSettingsHandler({
      bot,
      telegramConfig,
      volumeVerifier: { refresh: jest.fn() },
      configUpdater: {},
      translator
    });

    await handler(createMessage({ from: { id: '101' } }), 'volume off');
    expect(bot.sendMessage).toHaveBeenCalledWith(1, 'You are not authorised to manage settings.');
  });

  it('allows the owner to manage settings without an admin entry', async () => {
    telegramConfig.ownerId = '200';
    const bot = { sendMessage: jest.fn() };
    const refresh = jest.fn();
    const setVolumeCheckEnabled = jest.fn().mockResolvedValue({
      verification: {
        volumeCheckEnabled: false,
        minimumVolume: 1000,
        depositThreshold: null,
        volumeCheckDays: 30,
        volumeWarningEnabled: true,
        volumeWarningDays: 2
      }
    });
    const handler = createTelegramSettingsHandler({
      bot,
      telegramConfig,
      volumeVerifier: { refresh },
      configUpdater: {
        setVolumeCheckEnabled
      },
      translator
    });

    await handler(createMessage({ from: { id: '200' } }), 'volume off');
    expect(setVolumeCheckEnabled).toHaveBeenCalledWith(false);
    expect(refresh).toHaveBeenCalled();
    expect(bot.sendMessage).toHaveBeenCalledWith(1, 'Trading volume check has been disabled.');
  });

  it('allows admins to toggle volume checks', async () => {
    const bot = { sendMessage: jest.fn() };
    const refresh = jest.fn();
    const setVolumeCheckEnabled = jest.fn().mockResolvedValue({
      verification: {
        volumeCheckEnabled: false,
        minimumVolume: 1000,
        depositThreshold: null,
        volumeCheckDays: 30,
        volumeWarningEnabled: true,
        volumeWarningDays: 2
      }
    });
    const handler = createTelegramSettingsHandler({
      bot,
      telegramConfig,
      volumeVerifier: { refresh },
      configUpdater: {
        setVolumeCheckEnabled
      },
      translator
    });

    await handler(createMessage({ from: { id: '100' } }), 'volume off');
    expect(setVolumeCheckEnabled).toHaveBeenCalledWith(false);
    expect(refresh).toHaveBeenCalled();
    expect(bot.sendMessage).toHaveBeenCalledWith(1, 'Trading volume check has been disabled.');
  });

  it('allows admins to toggle warning notifications', async () => {
    const bot = { sendMessage: jest.fn() };
    const refresh = jest.fn();
    const setVolumeWarningEnabled = jest.fn().mockResolvedValue({
      verification: {
        volumeWarningEnabled: false,
        volumeWarningDays: 3
      }
    });
    const handler = createTelegramSettingsHandler({
      bot,
      telegramConfig,
      volumeVerifier: { refresh },
      configUpdater: {
        setVolumeWarningEnabled
      },
      translator
    });

    await handler(createMessage({ from: { id: '100' } }), 'volume_warning off');
    expect(setVolumeWarningEnabled).toHaveBeenCalledWith(false);
    expect(refresh).toHaveBeenCalled();
    expect(bot.sendMessage).toHaveBeenCalledWith(1, 'Volume warning notifications have been disabled.');
  });

  it('allows admins to update warning days', async () => {
    const bot = { sendMessage: jest.fn() };
    const refresh = jest.fn();
    const setVolumeWarningDays = jest.fn().mockResolvedValue({
      verification: {
        volumeWarningDays: 4
      }
    });
    const handler = createTelegramSettingsHandler({
      bot,
      telegramConfig,
      volumeVerifier: { refresh },
      configUpdater: {
        setVolumeWarningDays
      },
      translator
    });

    await handler(createMessage({ from: { id: '100' } }), 'warning_days 4');
    expect(setVolumeWarningDays).toHaveBeenCalledWith('4');
    expect(refresh).toHaveBeenCalled();
    expect(bot.sendMessage).toHaveBeenCalledWith(1, 'Warning lead time updated to 4 days.');
  });
});

describe('telegram owner command', () => {
  const createMessage = (overrides = {}) => ({
    chat: { id: 10 },
    from: { id: '200' },
    ...overrides
  });

  const bot = { sendMessage: jest.fn() };
  let telegramConfig;

  beforeEach(() => {
    bot.sendMessage.mockClear();
    telegramConfig = { admins: [], ownerId: null };
  });

  it('registers ownership with a passkey', async () => {
    const configUpdater = {
      registerOwner: jest.fn().mockResolvedValue({})
    };
    const handler = createTelegramOwnerHandler({ bot, telegramConfig, configUpdater, translator });
    await handler(createMessage(), 'register secret-pass');
    expect(configUpdater.registerOwner).toHaveBeenCalledWith({
      platform: 'telegram',
      userId: '200',
      passkey: 'secret-pass'
    });
    expect(telegramConfig.ownerId).toEqual('200');
    expect(bot.sendMessage).toHaveBeenCalledWith(10, 'Ownership registered. You may now manage admins and transfers.');
  });

  it('requires ownership before modifying admins', async () => {
    const configUpdater = {
      registerOwner: jest.fn(),
      requireOwner: jest.fn().mockResolvedValue(),
      addTelegramAdmin: jest.fn().mockResolvedValue({
        admins: ['300'],
        config: { telegram: { admins: ['300'] } }
      })
    };
    const handler = createTelegramOwnerHandler({ bot, telegramConfig, configUpdater, translator });
    await handler(createMessage(), 'add-admin 300');
    expect(configUpdater.requireOwner).toHaveBeenCalledWith('telegram', '200');
    expect(configUpdater.addTelegramAdmin).toHaveBeenCalledWith('300');
    expect(telegramConfig.admins).toEqual(['300']);
    expect(bot.sendMessage).toHaveBeenCalledWith(10, 'Admin 300 added. Current admins: 300.');
  });

  it('lists admins when requested', async () => {
    const configUpdater = {
      registerOwner: jest.fn(),
      requireOwner: jest.fn().mockResolvedValue(),
      addTelegramAdmin: jest.fn(),
      listTelegramAdmins: jest.fn().mockResolvedValue([])
    };
    const handler = createTelegramOwnerHandler({ bot, telegramConfig, configUpdater, translator });
    await handler(createMessage(), 'list-admins');
    expect(configUpdater.requireOwner).toHaveBeenCalledWith('telegram', '200');
    expect(bot.sendMessage).toHaveBeenCalledWith(10, 'No Telegram admins are currently configured.');
  });

  it('updates the cached owner id after transfers', async () => {
    const configUpdater = {
      registerOwner: jest.fn(),
      requireOwner: jest.fn().mockResolvedValue(),
      addTelegramAdmin: jest.fn(),
      transferOwnership: jest.fn().mockResolvedValue({ passkey: 'next-pass' })
    };
    const handler = createTelegramOwnerHandler({ bot, telegramConfig, configUpdater, translator });
    await handler(createMessage(), 'transfer-owner 555');
    expect(configUpdater.transferOwnership).toHaveBeenCalledWith({
      currentPlatform: 'telegram',
      currentUserId: '200',
      newOwnerId: '555',
      newOwnerPlatform: 'telegram'
    });
    expect(telegramConfig.ownerId).toEqual('555');
  });

  it('surfaces errors from owner checks', async () => {
    const configUpdater = {
      registerOwner: jest.fn(),
      requireOwner: jest.fn().mockRejectedValue(new Error('Only the registered owner may perform this action.')),
      addTelegramAdmin: jest.fn()
    };
    const handler = createTelegramOwnerHandler({ bot, telegramConfig, configUpdater, translator });
    await handler(createMessage(), 'add-admin 400');
    expect(configUpdater.addTelegramAdmin).not.toHaveBeenCalled();
    expect(bot.sendMessage).toHaveBeenCalledWith(10, 'Owner command failed: Only the registered owner may perform this action.');
  });
});

describe('telegram polling recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    onMock.mockImplementation(() => undefined);
    onTextMock.mockImplementation(() => undefined);
    sendMessageMock.mockResolvedValue();
    answerCallbackQueryMock.mockResolvedValue();
    startPollingMock.mockResolvedValue();
    stopPollingMock.mockResolvedValue();
    createChatInviteLinkMock.mockResolvedValue({ invite_link: 'link' });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('restarts polling after ECONNRESET errors', async () => {
    const handlers = {};
    onMock.mockImplementation((event, handler) => {
      handlers[event] = handler;
    });

    createTelegramBot({ enabled: true, token: 'token' }, { getExchanges: () => [], verify: jest.fn() }, { translator });

    const pollingErrorHandler = handlers.polling_error;
    expect(pollingErrorHandler).toBeDefined();

    pollingErrorHandler({ code: 'EFATAL', message: 'EFATAL: Error: read ECONNRESET' });

    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Telegram polling connection reset detected. Scheduling restart.',
      expect.objectContaining({ code: 'EFATAL' })
    );

    await jest.runOnlyPendingTimersAsync();

    expect(stopPollingMock).toHaveBeenCalled();
    expect(startPollingMock).toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith('Telegram polling restarted successfully after connection reset.');
  });

  it('logs unrecoverable polling errors without scheduling a restart', () => {
    const handlers = {};
    onMock.mockImplementation((event, handler) => {
      handlers[event] = handler;
    });

    createTelegramBot({ enabled: true, token: 'token' }, { getExchanges: () => [], verify: jest.fn() }, { translator });

    const pollingErrorHandler = handlers.polling_error;
    pollingErrorHandler({ code: 'EFATAL', message: 'Something else' });

    expect(loggerMock.error).toHaveBeenCalledWith(
      'Telegram polling encountered an unrecoverable error.',
      expect.objectContaining({ code: 'EFATAL' })
    );
    expect(stopPollingMock).not.toHaveBeenCalled();
    expect(startPollingMock).not.toHaveBeenCalled();
  });

  it('deduplicates restart scheduling while a timer is active', async () => {
    const handlers = {};
    onMock.mockImplementation((event, handler) => {
      handlers[event] = handler;
    });

    createTelegramBot({ enabled: true, token: 'token' }, { getExchanges: () => [], verify: jest.fn() }, { translator });

    const pollingErrorHandler = handlers.polling_error;
    pollingErrorHandler({ code: 'EFATAL', message: 'EFATAL: Error: read ECONNRESET' });
    pollingErrorHandler({ code: 'EFATAL', message: 'EFATAL: Error: read ECONNRESET' });

    await jest.runOnlyPendingTimersAsync();

    expect(stopPollingMock).toHaveBeenCalledTimes(1);
    expect(startPollingMock).toHaveBeenCalledTimes(1);
  });
});

describe('telegram verification invites', () => {
  const chatId = 25;
  const telegramUserId = '500';

  beforeEach(() => {
    jest.clearAllMocks();
    sendMessageMock.mockResolvedValue();
    answerCallbackQueryMock.mockResolvedValue();
    createChatInviteLinkMock.mockResolvedValue({ invite_link: 'https://t.me/+invite123' });
    saveVerifiedUserMock.mockResolvedValue();
  });

  it('skips the exchange selection keyboard when only one exchange is configured', async () => {
    const exchanges = [{
      id: 'binance',
      description: 'Binance',
      depositThreshold: 250,
      affiliateLink: 'https://example.com/affiliate'
    }];
    const verifyResult = {
      passed: false,
      exchangeId: 'binance',
      exchangeName: 'Binance',
      uid: 'UID123',
      volume: null,
      volumeMet: null,
      minimumVolume: 1000,
      deposit: { met: false, threshold: 250, reason: 'no deposit' },
      timestamp: '2024-01-01T00:00:00.000Z'
    };

    const volumeVerifier = {
      getExchanges: jest.fn().mockReturnValue(exchanges),
      verify: jest.fn().mockResolvedValue(verifyResult),
      getExchangeConfig: jest.fn().mockReturnValue(exchanges[0])
    };

    createTelegramBot({ enabled: true, token: 'token' }, volumeVerifier, { translator });

    const startHandler = onTextMock.mock.calls.find(([pattern]) => pattern.toString() === '/\\/start/i')[1];
    await startHandler({ chat: { id: chatId }, from: { id: telegramUserId } });

    expect(loggerMock.info).toHaveBeenCalledWith(
      'Bypassing Telegram exchange selection: single exchange configured.',
      expect.objectContaining({ chatId, exchangeId: 'binance' })
    );

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [targetChatId, messageText, options] = sendMessageMock.mock.calls[0];
    expect(targetChatId).toEqual(chatId);
    expect(messageText).toContain('Great choice! Binance requires an eligible affiliate account.');
    expect(messageText).toContain('Minimum deposit: 250');
    expect(messageText).toContain('Please reply with the UID you would like us to verify.');
    expect(messageText).toContain('https://example.com/affiliate');
    expect(options).toBeUndefined();

    const messageHandler = onMock.mock.calls.find(([event]) => event === 'message')[1];
    await messageHandler({ chat: { id: chatId }, from: { id: telegramUserId }, text: 'UID123' });

    expect(volumeVerifier.verify).toHaveBeenCalledWith('UID123', { exchangeId: 'binance' });
  });

  it('sends invite buttons when verification succeeds', async () => {
    const exchanges = [{ id: 'binance', description: 'Binance' }];
    const verifyResult = {
      passed: true,
      exchangeId: 'binance',
      exchangeName: 'Binance',
      uid: 'UID123',
      volume: 1000,
      volumeMet: true,
      minimumVolume: 1000,
      deposit: { met: true, threshold: 100, amount: 100 },
      timestamp: '2024-01-01T00:00:00.000Z'
    };

    const volumeVerifier = {
      getExchanges: jest.fn().mockReturnValue(exchanges),
      verify: jest.fn().mockResolvedValue(verifyResult),
      getExchangeConfig: jest.fn().mockReturnValue({ description: 'Binance' })
    };

    createTelegramBot({ enabled: true, token: 'token', groupIds: ['@myspace'] }, volumeVerifier, { translator });

    const startHandler = onTextMock.mock.calls.find(([pattern]) => pattern.toString() === '/\\/start/i')[1];
    await startHandler({ chat: { id: chatId }, from: { id: telegramUserId } });

    const callbackHandler = onMock.mock.calls.find(([event]) => event === 'callback_query')[1];
    await callbackHandler({
      id: 'cb1',
      data: 'exchange:binance',
      message: { chat: { id: chatId }, from: { id: telegramUserId } }
    });

    const messageHandler = onMock.mock.calls.find(([event]) => event === 'message')[1];
    await messageHandler({ chat: { id: chatId }, from: { id: telegramUserId }, text: 'UID123' });

    const finalCall = sendMessageMock.mock.calls[sendMessageMock.mock.calls.length - 1];
    expect(finalCall[0]).toEqual(chatId);
    expect(finalCall[1]).toContain('Tap a button below to join your Telegram spaces:');
    expect(finalCall[2]).toEqual(expect.objectContaining({
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{ text: 'Join @myspace', url: 'https://t.me/+invite123' }]]
      }
    }));
  });
});
