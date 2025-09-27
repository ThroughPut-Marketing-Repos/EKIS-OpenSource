# Configuration

Runtime options are now sourced from the SQL database first, then merged with `config.json`, and finally overridden by
environment variables. The configuration structure is:

```json
{
  "owner": {
    "platform": null,
    "id": null,
    "passkey": null,
    "passkeyGeneratedAt": null,
    "registeredAt": null
  },
  "discord": {
    "enabled": false,
    "token": "YOUR_DISCORD_BOT_TOKEN",
    "applicationId": "",
    "guildId": "",
    "commandPrefix": "!",
    "commandName": "verify",
    "settingsCommandName": "settings",
    "ownerCommandName": "owner",
    "guilds": [],
    "adminUserIds": [],
    "adminRoleIds": []
  },
  "telegram": {
    "enabled": false,
    "token": "YOUR_TELEGRAM_BOT_TOKEN",
    "joinMessage": "",
    "admins": [],
    "groupId": "",
    "groupIds": []
  },
  "http": {
    "enabled": true,
    "port": 3000,
    "authToken": "change-me"
  },
  "verification": {
    "volumeCheckEnabled": true,
    "minimumVolume": 1000,
    "depositThreshold": null,
    "volumeCheckDays": 30,
    "volumeWarningEnabled": true,
    "volumeWarningDays": 2,
    "defaultExchange": "mock",
    "exchanges": {
      "mock": {
        "type": "mock",
        "description": "Static mock volumes used for development and testing.",
        "volumes": {
          "demo-user": 2500,
          "new-user": 500
        }
      }
    }
  }
}
```

> **Important:** When an interface is enabled (`enabled: true`) the matching token must be provided. Missing tokens
> cause the application to exit during startup.

## Environment overrides

`src/config/configManager.js` connects to the database (via Sequelize) before reading the JSON file. The following
environment variables override the configuration when present:

| Variable | Description |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Overrides `discord.token`. |
| `DISCORD_APPLICATION_ID` | Overrides `discord.applicationId`. |
| `DISCORD_GUILD_ID` | Overrides `discord.guildId`. |
| `TELEGRAM_BOT_TOKEN` | Overrides `telegram.token`. |
| `TELEGRAM_JOIN_MESSAGE` | Overrides `telegram.joinMessage`. |
| `TELEGRAM_GROUP_ID` | Overrides `telegram.groupId`. Accepts comma-separated values which are also exposed via `telegram.groupIds`. |
| `TELEGRAM_GROUP_IDS` | Overrides `telegram.groupIds`. Accepts JSON arrays or comma-separated values. |
| `HTTP_PORT` | Overrides `http.port`. |
| `HTTP_AUTH_TOKEN` | Overrides `http.authToken`. |
| `VOLUME_CHECK_ENABLED` | Overrides `verification.volumeCheckEnabled` (values `true`/`false`). |
| `VERIFICATION_MIN_VOLUME` | Overrides `verification.minimumVolume`. |
| `VERIFICATION_DEFAULT_EXCHANGE` | Overrides `verification.defaultExchange`. |
| `VERIFICATION_DEPOSIT_THRESHOLD` | Overrides `verification.depositThreshold`. |
| `VOLUME_CHECK_DAYS` | Overrides `verification.volumeCheckDays`. |
| `VOLUME_WARNING_ENABLED` | Overrides `verification.volumeWarningEnabled` (values `true`/`false`). |
| `VOLUME_WARNING_DAYS` | Overrides `verification.volumeWarningDays`. |

On each restart the service copies `DISCORD_BOT_TOKEN`/`DISCORD_TOKEN` and `TELEGRAM_BOT_TOKEN` into the
`configurations` table when they are supplied. This keeps long-lived deployments in sync even if the environment
variables are only present for the initial boot (for example when a process manager injects secrets once). Tokens are
stored verbatim in the database while logs only display masked previews for security.

## Adding an exchange

`verification.exchanges` is a keyed object where the key represents the exchange identifier used in commands and API
calls. Entries inserted through the database are merged into this object and expose the raw credential data for use by
custom services. The built-in verifier understands the following exchange types:

- `mock` &ndash; Uses static volumes stored in the configuration file. Ideal for development or demo communities.
- `rest` &ndash; Queries an HTTP endpoint using Axios. The configuration requires `apiBaseUrl`, can optionally set
  `apiKey` for bearer authorization, and may override `volumePath` (default `/uids/{uid}/volume`). The endpoint must
  return `{ "volume": <number> }`.
- `blofin` &ndash; Leverages the bundled Blofin integration. Provide `apiKey`, `apiSecret`, and `passphrase`. Optional
  fields like `subAffiliateInvitees` and `kolName` are forwarded to the service. Deposits are enforced using the
  global `verification.depositThreshold` unless the exchange entry supplies its own `depositThreshold` override.
- `bitunix` &ndash; Uses the Bitunix partner API helper. Supply `apiKey`, `apiSecret`, and optionally `kolName`. Deposit
  checks follow the same threshold resolution as Blofin.

Each exchange may define its own `minimumVolume` if a stricter threshold is required. When omitted, the global
`verification.minimumVolume` is used. Exchanges can also declare a `depositThreshold` to override the global
`verification.depositThreshold` value on a per-integration basis. Exchanges inserted through the SQL database can also
store an `affiliate_link` value. Platform administrators can update this field through the new `affiliate` settings
subcommand so failed verifications can guide users to the correct registration URL. Exchanges inserted through the SQL
database that use a custom `type` will be logged and ignored by the bundled verifier, allowing downstream services to
implement bespoke integrations without breaking the core workflow.

## Database-backed configuration

The database keeps long-lived configuration alongside operational data:

- `configurations` &ndash; Stores primary bot settings, including Telegram/Discord tokens, verification thresholds, owner metadata (platform, identifier, passkey timestamps), and the persisted admin lists for each chat platform.
- `discord_configs` &ndash; Holds per-guild presentation data (embed text, role IDs, and messaging hints).
- `exchanges` &ndash; Tracks credential material for third-party exchanges. These entries are merged into
  `verification.exchanges` during startup.

When the database is unavailable (for example, on first boot) the application falls back to the JSON defaults and logs a
debug message to aid troubleshooting.

## Runtime updates

`src/services/configUpdateService.js` exposes helper functions used by the Discord and Telegram settings commands to adjust
configuration without restarting the service. Each update writes to the underlying SQL tables, clears the cached
configuration (`resetConfigCache`), and reloads the merged configuration via `getConfig`. Callers should subsequently invoke
`volumeVerifier.refresh(updatedConfig)` so in-memory verifiers begin using the new thresholds and exchange credentials
immediately.

## Owner lifecycle

EKIS now persists owner information inside the `configurations` table. During startup the service generates a cryptographically strong passkey if none exists, logs a masked preview, and exposes the full value only in development builds. The owner must send this passkey to the bot using `/owner register <passkey>` (Telegram) or `!owner register <passkey>` (Discord) to bind their user ID to the deployment.

Once registered, the owner can:

- Add or remove Telegram admins with `/owner add-admin <id>` and `/owner remove-admin <id>`.
- Maintain Discord admin user IDs and role IDs via `!owner add-admin <userId>` / `!owner add-role <roleId>` and the matching removal commands.
- View the current admin lists with `/owner list-admins` and `!owner list-admins`.
- Transfer ownership to a new account with `/owner transfer-owner <id>` or `!owner transfer-owner <id>`, which rotates the passkey and clears the prior registration timestamp.

All owner mutations update the SQL configuration, refresh the runtime cache, and surface the new state back to the command response.

The configuration also controls the automated trading volume monitor cron (`src/services/tradingVolumeMonitor.js`). The following flags influence that job:

- `verification.volumeCheckEnabled` &ndash; Disables the compliance job entirely when `false`.
- `verification.volumeWarningEnabled` &ndash; Enables or disables pre-expiry warnings.
- `verification.volumeWarningDays` &ndash; Sets how many days before the deadline a warning is issued.
- `verification.volumeCheckDays` &ndash; Defines how long users have to meet the minimum trading volume requirement.
