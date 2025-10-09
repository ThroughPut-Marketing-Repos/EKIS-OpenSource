import { jest } from '@jest/globals';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { createTranslator } from '../src/i18n/translator.js';

const loggerMock = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: loggerMock,
  logger: loggerMock
}));

const {
  handleSettingsCommand,
  isDiscordAdmin,
  handleOwnerCommand,
  createDiscordSetupWizard,
  buildVerificationEmbedPayload
} = await import('../src/platforms/discordBot.js');

// Create a real translator instance for tests
const translator = createTranslator({ locale: 'en', fallbackLocale: 'en' });

describe('discord settings command', () => {
  const createMessage = (overrides = {}) => ({
    author: { id: 'user-1' },
    guild: { id: 'guild-1' },
    member: { roles: { cache: { some: () => false } } },
    reply: jest.fn(),
    ...overrides
  });

  const createConfig = (overrides = {}) => ({
    adminUserIds: ['admin-user'],
    adminRoleIds: ['admin-role'],
    ownerId: null,
    ...overrides
  });

  it('identifies admins by user id or role', () => {
    const baseConfig = createConfig();
    const byUser = isDiscordAdmin(createMessage({ author: { id: 'admin-user' } }), baseConfig);
    expect(byUser).toBe(true);

    const byRole = isDiscordAdmin(createMessage({
      author: { id: 'another-user' },
      member: {
        roles: {
          cache: {
            some: (predicate) => [{ id: 'admin-role' }].some(predicate)
          }
        }
      }
    }), baseConfig);
    expect(byRole).toBe(true);
  });

  it('treats the registered owner as an admin', () => {
    const config = createConfig({ adminUserIds: [], ownerId: 'owner-777' });
    expect(isDiscordAdmin(createMessage({ author: { id: 'owner-777' } }), config)).toBe(true);
  });

  it('rejects unauthorised users', async () => {
    const message = createMessage();
    const discordConfig = createConfig();
    await handleSettingsCommand(message, ['volume', 'off'], {
      discordConfig,
      volumeVerifier: { refresh: jest.fn() },
      commandPrefix: '!',
      settingsCommandName: 'settings',
      configUpdater: {},
      translator
    });

    expect(message.reply).toHaveBeenCalledWith(translator.t('discord.settings.unauthorised'));
  });

  it('toggles volume checks for admins', async () => {
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

    const message = createMessage({ author: { id: 'admin-user' } });
    const discordConfig = createConfig();
    await handleSettingsCommand(message, ['volume', 'off'], {
      discordConfig,
      volumeVerifier: { refresh },
      commandPrefix: '!',
      settingsCommandName: 'settings',
      configUpdater: {
        setVolumeCheckEnabled
      },
      translator
    });

    expect(setVolumeCheckEnabled).toHaveBeenCalledWith(false);
    expect(refresh).toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith('Trading volume check has been disabled.');
  });

  it('toggles warning notifications', async () => {
    const refresh = jest.fn();
    const setVolumeWarningEnabled = jest.fn().mockResolvedValue({
      verification: {
        volumeWarningEnabled: false,
        volumeWarningDays: 3
      }
    });

    const message = createMessage({ author: { id: 'admin-user' } });
    const discordConfig = createConfig();
    await handleSettingsCommand(message, ['volume-warning', 'off'], {
      discordConfig,
      volumeVerifier: { refresh },
      commandPrefix: '!',
      settingsCommandName: 'settings',
      configUpdater: {
        setVolumeWarningEnabled
      },
      translator
    });

    expect(setVolumeWarningEnabled).toHaveBeenCalledWith(false);
    expect(refresh).toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith('Volume warning notifications have been disabled.');
  });

  it('updates warning lead time', async () => {
    const refresh = jest.fn();
    const setVolumeWarningDays = jest.fn().mockResolvedValue({
      verification: {
        volumeWarningDays: 5
      }
    });

    const message = createMessage({ author: { id: 'admin-user' } });
    const discordConfig = createConfig();
    await handleSettingsCommand(message, ['warning-days', '5'], {
      discordConfig,
      volumeVerifier: { refresh },
      commandPrefix: '!',
      settingsCommandName: 'settings',
      configUpdater: {
        setVolumeWarningDays
      },
      translator
    });

    expect(setVolumeWarningDays).toHaveBeenCalledWith('5');
    expect(refresh).toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith('Warning lead time updated to 5 days.');
  });

  it('allows the owner to manage settings without admin membership', async () => {
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

    const message = createMessage({ author: { id: 'owner-1' } });
    const discordConfig = createConfig({ adminUserIds: [], ownerId: 'owner-1' });
    await handleSettingsCommand(message, ['volume', 'off'], {
      discordConfig,
      volumeVerifier: { refresh },
      commandPrefix: '!',
      settingsCommandName: 'settings',
      configUpdater: {
        setVolumeCheckEnabled
      },
      translator
    });

    expect(setVolumeCheckEnabled).toHaveBeenCalledWith(false);
    expect(refresh).toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith('Trading volume check has been disabled.');
  });
});

describe('discord verification embed payload', () => {
  it('builds a disabled state when no exchanges are available', () => {
    const payload = buildVerificationEmbedPayload({ guildName: 'Guild', exchanges: [], guildId: '123', translator });
    expect(payload.components).toHaveLength(1);
    expect(payload.components[0].components[0].data.disabled).toBe(true);
  });
});

describe('discord setup wizard', () => {
  const createGuild = (overrides = {}) => {
    const guild = {
      id: overrides.id || 'guild-1',
      name: overrides.name || 'Guild One',
      joinedTimestamp: Date.now(),
      members: {
        fetch: jest.fn()
      },
      channels: {
        cache: new Map(),
        fetch: jest.fn(),
        create: jest.fn()
      },
      roles: {
        fetch: jest.fn(),
        create: jest.fn()
      },
      ...overrides
    };
    return guild;
  };

  const createClient = (guilds) => {
    const guildMap = new Map(guilds.map((guild) => [guild.id, guild]));
    return {
      guilds: {
        fetch: jest.fn((id) => {
          if (id) {
            return Promise.resolve(guildMap.get(id));
          }
          return Promise.resolve(guildMap);
        })
      }
    };
  };

  it('filters guilds by permissions and persists configuration', async () => {
    const eligibleGuild = createGuild({ id: 'guild-eligible' });
    const otherGuild = createGuild({ id: 'guild-other', name: 'Other Guild' });

    eligibleGuild.members.fetch.mockResolvedValue({
      permissions: {
        has: (permission) => permission === PermissionFlagsBits.ManageGuild || permission === PermissionFlagsBits.Administrator
      }
    });

    eligibleGuild.channels.cache = { some: jest.fn().mockReturnValue(false) };

    otherGuild.members.fetch.mockRejectedValue(new Error('Missing permissions'));

    const channelCollection = new Map([
      ['chan-1', { id: 'chan-1', name: 'general', type: ChannelType.GuildText }]
    ]);
    eligibleGuild.channels.fetch.mockResolvedValue(channelCollection);
    eligibleGuild.channels.create.mockResolvedValue({ id: 'chan-new', name: 'verification', type: ChannelType.GuildText });

    const roleCollection = new Map([
      ['role-1', { id: 'role-1', name: 'Member', managed: false }]
    ]);
    eligibleGuild.roles.fetch.mockResolvedValue(roleCollection);
    eligibleGuild.roles.create.mockResolvedValue({ id: 'role-new', name: 'Verified Member' });

    const client = createClient([eligibleGuild, otherGuild]);
    const publishEmbed = jest.fn().mockResolvedValue();
    const configUpdater = {
      upsertDiscordGuildConfig: jest.fn().mockResolvedValue({
        config: {
          discord: {
            guilds: [{
              id: 'guild-eligible',
              verificationChannelId: 'chan-new',
              verifiedRoleId: 'role-new',
              verifiedRoleName: 'Verified Member'
            }]
          }
        }
      })
    };
    const volumeVerifier = { getExchanges: jest.fn().mockReturnValue([]) };
    const discordConfig = { guilds: [] };
    const wizard = createDiscordSetupWizard({
      client,
      configUpdater,
      volumeVerifier,
      discordConfig,
      publishEmbed,
      translator
    });

    const dmChannel = { send: jest.fn().mockResolvedValue() };
    const message = {
      author: { id: 'user-1' },
      guild: null,
      reply: jest.fn().mockResolvedValue(),
      channel: dmChannel
    };

    await wizard.handleSetupMessage(message);
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ components: expect.any(Array) }));

    const guildSelection = {
      isStringSelectMenu: () => true,
      customId: 'discord-setup-select-guild',
      values: ['guild-eligible'],
      user: { id: 'user-1', tag: 'User#0001' },
      update: jest.fn().mockResolvedValue()
    };
    await wizard.handleInteraction(guildSelection);
    const guildSelectedMessage = translator.t('discord.setup.guildSelected', { guildName: eligibleGuild.name });
    expect(guildSelection.update).toHaveBeenCalledWith(expect.objectContaining({ content: guildSelectedMessage }));
    expect(dmChannel.send).toHaveBeenCalledWith(expect.objectContaining({ components: expect.any(Array) }));

    const channelSelection = {
      isStringSelectMenu: () => true,
      customId: 'discord-setup-select-channel',
      values: ['create-channel'],
      user: { id: 'user-1', tag: 'User#0001' },
      update: jest.fn().mockResolvedValue()
    };
    await wizard.handleInteraction(channelSelection);
    expect(channelSelection.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Created channel') }));
    expect(dmChannel.send).toHaveBeenCalledWith(expect.objectContaining({ components: expect.any(Array) }));

    const roleSelection = {
      isStringSelectMenu: () => true,
      customId: 'discord-setup-select-role',
      values: ['create-role'],
      user: { id: 'user-1', tag: 'User#0001' },
      update: jest.fn().mockResolvedValue()
    };
    await wizard.handleInteraction(roleSelection);

    expect(configUpdater.upsertDiscordGuildConfig).toHaveBeenCalledWith({
      guildId: 'guild-eligible',
      verificationChannelId: 'chan-new',
      verifiedRoleId: 'role-new',
      verifiedRoleName: 'Verified Member'
    });
    expect(publishEmbed).toHaveBeenCalledWith(expect.objectContaining({
      guild: eligibleGuild,
      channelId: 'chan-new',
      volumeVerifier
    }));
    expect(dmChannel.send).toHaveBeenCalledWith(expect.stringContaining('Setup complete!'));
    expect(discordConfig.guilds).toEqual([
      {
        id: 'guild-eligible',
        verificationChannelId: 'chan-new',
        verifiedRoleId: 'role-new',
        verifiedRoleName: 'Verified Member'
      }
    ]);
  });
});

describe('discord owner command', () => {
  const createMessage = (overrides = {}) => ({
    author: { id: 'owner-1' },
    reply: jest.fn(),
    ...overrides
  });

  it('registers ownership with a passkey', async () => {
    const message = createMessage();
    const discordConfig = { adminUserIds: [], adminRoleIds: [], ownerId: null };
    const configUpdater = {
      registerOwner: jest.fn().mockResolvedValue({})
    };
    await handleOwnerCommand(message, ['register', 'pass-123'], {
      discordConfig,
      commandPrefix: '!',
      ownerCommandName: 'owner',
      configUpdater,
      translator
    });
    expect(configUpdater.registerOwner).toHaveBeenCalledWith({
      platform: 'discord',
      userId: 'owner-1',
      passkey: 'pass-123'
    });
    expect(discordConfig.ownerId).toEqual('owner-1');
    expect(message.reply).toHaveBeenCalledWith(translator.t('discord.owner.registered'));
  });

  it('requires ownership before mutating admins', async () => {
    const message = createMessage();
    const discordConfig = { adminUserIds: [], adminRoleIds: [], ownerId: null };
    const configUpdater = {
      registerOwner: jest.fn(),
      requireOwner: jest.fn().mockResolvedValue(),
      addDiscordAdminUser: jest.fn().mockResolvedValue({
        userIds: ['user-2'],
        config: { discord: { adminUserIds: ['user-2'], adminRoleIds: [] } }
      })
    };
    await handleOwnerCommand(message, ['add-admin', 'user-2'], {
      discordConfig,
      commandPrefix: '!',
      ownerCommandName: 'owner',
      configUpdater,
      translator
    });
    expect(configUpdater.requireOwner).toHaveBeenCalledWith('discord', 'owner-1');
    expect(configUpdater.addDiscordAdminUser).toHaveBeenCalledWith('user-2');
    const adminAddedMessage = translator.t('discord.owner.adminAdded', { adminId: 'user-2', summary: 'user-2' });
    expect(message.reply).toHaveBeenCalledWith(adminAddedMessage);
  });

  it('transfers ownership and surfaces the new passkey', async () => {
    const message = createMessage();
    const discordConfig = { adminUserIds: [], adminRoleIds: [], ownerId: null };
    const configUpdater = {
      registerOwner: jest.fn(),
      requireOwner: jest.fn().mockResolvedValue(),
      addDiscordAdminUser: jest.fn(),
      transferOwnership: jest.fn().mockResolvedValue({ passkey: 'new-pass-456', ownerId: 'owner-2' })
    };
    await handleOwnerCommand(message, ['transfer-owner', 'owner-2'], {
      discordConfig,
      commandPrefix: '!',
      ownerCommandName: 'owner',
      configUpdater,
      translator
    });
    expect(configUpdater.transferOwnership).toHaveBeenCalledWith({
      currentPlatform: 'discord',
      currentUserId: 'owner-1',
      newOwnerId: 'owner-2',
      newOwnerPlatform: 'discord'
    });
    expect(discordConfig.ownerId).toEqual('owner-2');
    expect(message.reply).toHaveBeenCalledWith(expect.stringContaining('new-pass-456'));
  });

  it('reports errors from owner validation', async () => {
    const message = createMessage();
    const discordConfig = { adminUserIds: [], adminRoleIds: [] };
    const configUpdater = {
      registerOwner: jest.fn(),
      requireOwner: jest.fn().mockRejectedValue(new Error('Only the registered owner may perform this action.')),
      addDiscordAdminUser: jest.fn()
    };
    await handleOwnerCommand(message, ['add-admin', 'user-2'], {
      discordConfig,
      commandPrefix: '!',
      ownerCommandName: 'owner',
      configUpdater,
      translator
    });
    expect(configUpdater.addDiscordAdminUser).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith('Owner command failed: Only the registered owner may perform this action.');
  });
});
