import { jest } from '@jest/globals';
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

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: loggerMock,
  logger: loggerMock
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
  createTelegramOwnerHandler
} = await import('../src/platforms/telegramBot.js');

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
      configUpdater: {}
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
      }
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
      }
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
      }
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
      }
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
    const handler = createTelegramOwnerHandler({ bot, telegramConfig, configUpdater });
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
    const handler = createTelegramOwnerHandler({ bot, telegramConfig, configUpdater });
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
    const handler = createTelegramOwnerHandler({ bot, telegramConfig, configUpdater });
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
    const handler = createTelegramOwnerHandler({ bot, telegramConfig, configUpdater });
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
    const handler = createTelegramOwnerHandler({ bot, telegramConfig, configUpdater });
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

    createTelegramBot({ enabled: true, token: 'token' }, { getExchanges: () => [], verify: jest.fn() });

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

    createTelegramBot({ enabled: true, token: 'token' }, { getExchanges: () => [], verify: jest.fn() });

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

    createTelegramBot({ enabled: true, token: 'token' }, { getExchanges: () => [], verify: jest.fn() });

    const pollingErrorHandler = handlers.polling_error;
    pollingErrorHandler({ code: 'EFATAL', message: 'EFATAL: Error: read ECONNRESET' });
    pollingErrorHandler({ code: 'EFATAL', message: 'EFATAL: Error: read ECONNRESET' });

    await jest.runOnlyPendingTimersAsync();

    expect(stopPollingMock).toHaveBeenCalledTimes(1);
    expect(startPollingMock).toHaveBeenCalledTimes(1);
  });
});
