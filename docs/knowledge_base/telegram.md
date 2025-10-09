# Telegram Bot

`src/platforms/telegramBot.js` wraps `node-telegram-bot-api` to provide a guided verification flow. Enable it by setting
`telegram.enabled` to `true` and providing a bot token with permission to create invite links for your destination groups.

## Usage

1. A user sends `/start` to the bot via direct message (use `/help` at any time to review available commands and examples).
2. The bot lists every configured exchange as inline buttons.
3. After the user selects an exchange, the bot prompts for their UID.
4. The verifier confirms the UID belongs to the configured affiliate programme and that the deposit requirement is met.
5. On success, the bot creates one-time invite links for every configured Telegram group and delivers them as inline buttons
   that open each space directly from the chat.

If verification fails, the bot explains why (missing affiliate account, deposit below threshold, or API failure) and keeps
the session open so the user can send a different UID. When a UID has already been verified for the configured influencer,
the bot warns the requester instead of issuing fresh invite links.

### Reliability safeguards

The bot automatically recovers from transient Telegram polling failures (for example, `read ECONNRESET`) by stopping and
restarting the long-poll loop with exponential backoff. Recovery attempts are logged so operators can correlate outages
with infrastructure interruptions while ensuring the integration continues processing messages without manual restarts.

## Help reference

Send `/help` to receive a concise list of all available commands, their purpose, and a usage example. The response links to
`/settings` and `/owner` for detailed subcommand references, ensuring new administrators can discover maintenance
capabilities without consulting the source code.

## Group and channel onboarding

Telegram administrators can run `/setupgroup` to generate a one-time setup code that links a new group or channel to the
verification flow. The bot replies with a detailed checklist:

1. Add the bot as an administrator in the destination space with permission to create invite links.
2. Post the generated setup code inside that space. The code expires after 15 minutes and only the admin who created it can
   complete the process.
3. The bot confirms the link both in the group and via direct message, then persists the chat ID in the configuration so
   future verifications automatically create invite links for the new destination.

Successful links appear immediately in `/settings show`, confirming that the configuration update succeeded and will be
used for subsequent verification sessions even after restarts.

Use `/setupgroup cancel` to invalidate an unused code. If someone else attempts to reuse an active code, the bot informs the
requesting admin and keeps the code available until it expires. Previously linked chats are detected automatically so repeat
codes do not create duplicates.

## Settings management

Administrators listed in `telegram.admins` can adjust runtime configuration without redeploying the bot. The `/settings`
command accepts the following subcommands. The registered owner is always treated as an implicit administrator, so they can
manage settings even when not explicitly listed in the admin array:

```text
/settings volume <on|off>
/settings min_volume <amount>
/settings deposit <amount|clear>
/settings volume_days <days>
/settings api add <name> <type> <key> <secret> [passphrase]
/settings api update <name> <type> <key> <secret> [passphrase]
/settings api remove <name>
/settings api list
/settings affiliate <exchange> <url|clear>
/settings show
```

All successful updates persist to the database through `configUpdateService`, invalidate the cached configuration, and
refresh the shared `volumeVerifier` instance so new verification requests honour the modified settings immediately. When
the trading volume check is disabled, the verification responses explicitly state that the volume target is informational
only while still performing affiliate and deposit validation.

## Owner workflow

When the service starts it generates a one-time owner passkey if none exists. The passkey is logged with a masked preview
and, in development environments, the full value appears in the logs. The intended owner must send `/owner register <passkey>`
to bind their Telegram user ID to the deployment. Owners can register distinct identities on both Telegram and Discord
using the same passkey, so the same person can administer the deployment from either platform. Once registered the
following subcommands become available:

```text
/owner add-admin <telegramUserId>
/owner remove-admin <telegramUserId>
/owner list-admins
/owner transfer-owner <telegramUserId>
```

Transfers rotate the passkey and set the new owner ID immediately. The command response includes the fresh passkey so it
can be shared securely with the incoming owner, who must call `/owner register` to complete the handover. Owner actions
write back to the `configurations` table and update the in-memory configuration for subsequent requests.

## Localization

The Telegram bot uses the same translation system as Discord and the HTTP API. All user-facing messages (verification status, help text, settings feedback, and owner commands) are managed through locale files in `src/i18n/locales/`.

To customize Telegram responses:

1. Edit `src/i18n/locales/en.json` (or create a new locale file) and update values under the `telegram` section.
2. Preserve `{{ placeholders }}` for dynamic content like UIDs, exchange names, admin IDs, and volume thresholds.
3. Update `config.translation.locale` or set `TRANSLATION_LOCALE` to activate the new language.

This design ensures consistent multilingual support across all platforms without duplicating translation logic in each bot module.

## Deployment tips

- Create the bot with [@BotFather](https://t.me/botfather) and copy the provided token into `config.json` or the
  `TELEGRAM_BOT_TOKEN` environment variable.
- Grant the bot the `Invite Users via Link` permission in every target group so it can generate one-time invite links.
- When hosting the bot on a server, ensure outbound HTTPS traffic is allowed because exchange verifications may call
  remote APIs.
- Configure `telegram.groupIds` with the list of target groups (usernames such as `@mygroup` or numeric chat IDs).
  Comma-separated values are also accepted through `TELEGRAM_GROUP_ID` and database configuration.
- Legacy deployments that stored `telegram.groupId` as JSON text (for example `"[\"-123456789\"]"`) are normalised
  automatically, so you do not need to scrub the database manually before restarting the service.
