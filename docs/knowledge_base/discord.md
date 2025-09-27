# Discord Bot

`src/platforms/discordBot.js` launches a `discord.js` client whenever `discord.enabled` is set to `true`. The bot listens
for text commands that start with the configured prefix (default `!`) and now supports a DM-driven setup wizard plus an
interactive verification embed with buttons and modals.

## Usage

```text
!verify <uid> [exchangeId] [minimumVolume]
```

- `uid` (required) &ndash; The account identifier to verify.
- `exchangeId` (optional) &ndash; Overrides the default exchange configured in `verification.defaultExchange`.
- `minimumVolume` (optional) &ndash; Overrides the minimum volume threshold for a single request. The value must be a finite
  number; invalid values trigger an inline usage reminder instead of attempting verification.

The bot replies with a formatted status message that confirms affiliate membership, deposit status, and the latest volume
snapshot. When `verification.volumeCheckEnabled` is disabled, the response marks the volume target as informational while
still enforcing the affiliate and deposit checks. If a UID has already been verified for the deployment, the bot informs
the requester instead of duplicating the record.

Alongside the legacy text command, moderators can publish a verification embed with buttons for each configured exchange.
Button clicks open a modal requesting the UID, after which the bot replies ephemerally and sends the requester a DM that
summarises the verification result and any next steps. When Discord blocks the DM (for example, because the member
disables server DMs), the bot falls back to editing the ephemeral reply with the full verification summary and a privacy
settings reminder so users still receive the outcome inline.

## DM setup wizard

Administrators can run `!setup` (or the configured `discord.setupCommandName`) in a direct message with the bot. The wizard guides the user through:

1. Selecting one of the servers where the bot is present and the user holds either the **Manage Server** or **Administrator** permission.
2. Choosing an existing verification channel or creating a dedicated text channel.
3. Selecting an existing verification role or creating a `Verified Member` role automatically.
4. Persisting the selections to the `discord_configs` table via `configUpdateService.upsertDiscordGuildConfig`.
5. Publishing the interactive verification embed in the selected channel.

Every step happens inside the DM conversation, including confirmation messages when channels or roles are created. Errors (such as missing permissions) are logged and surfaced back to the operator so they can adjust Discord permissions if required.

## Help reference

Users can send `!help` (or the configured `discord.helpCommandName`) to receive a summary of the verification, setup,
settings, and owner commands with usage examples. The help text now highlights that `!setup` should be executed in a
direct message so the bot can walk administrators through selecting the guild, verification channel, and role before
publishing the interactive embed. This makes onboarding easier for new moderators because they can discover the
maintenance surface directly inside Discord without reviewing source code or documentation.

## Settings management

Administrators can manage runtime configuration directly from Discord using the settings command (default `!settings`).
Authorisation is granted to users listed in `discord.adminUserIds`, members who hold a role present in
`discord.adminRoleIds`, or the registered owner. The owner inherits these privileges automatically even if they are not
explicitly listed. The command prefix and settings command name are configurable through `discord.commandPrefix` and
`discord.settingsCommandName` respectively.

Available subcommands:

```text
!settings volume <on|off>
!settings min-volume <amount>
!settings deposit <amount|clear>
!settings volume-days <days>
!settings api add <name> <type> <key> <secret> [passphrase]
!settings api update <name> <type> <key> <secret> [passphrase]
!settings api remove <name>
!settings api list
!settings affiliate <exchange> <url|clear>
!settings show
```

Each mutating subcommand persists changes via `configUpdateService`, refreshes the in-memory configuration cache, and
reloads the `volumeVerifier` instance so subsequent verification requests immediately respect the latest settings.

## Interactive verification

The embed posted by the setup wizard (or via `publishVerificationEmbed`) contains one button per configured exchange. Clicking a button launches a modal that collects the UID and executes the same verification logic used by the text command. Responses behave as follows:

- **Success** &ndash; The bot assigns the configured role, replies ephemerally confirming the result, and sends the user a DM summarising the volume, deposit, and any warnings.
- **Failure** &ndash; The bot explains the failure both ephemerally and via DM, including whether the UID was not found, a deposit was missing, or the exchange temporarily failed to respond. Existing access is retained until verification succeeds.
- **Conflicts** &ndash; If the UID is already registered to another account the bot notifies the user privately and prevents duplicate access.

All modal interactions are logged with guild, user, and exchange identifiers to aid monitoring and support.

## Owner workflow

Ownership is established by submitting the generated passkey via `!owner register <passkey>`. The passkey is created at
startup when missing and logged with a masked preview (full value appears only in development logs). Owners can register
distinct Discord and Telegram identifiers with the same passkey, allowing the same person to administer the deployment on
both platforms. Once registered, the owner gains additional maintenance commands:

```text
!owner add-admin <userId>
!owner remove-admin <userId>
!owner add-role <roleId>
!owner remove-role <roleId>
!owner list-admins
!owner transfer-owner <userId>
```

Transfers rotate the passkey and immediately set the new owner ID/platform. The command response includes the full
passkey so it can be shared with the incoming owner, who must re-run `!owner register` to mark the transfer complete.
All mutations persist to the `configurations` table and refresh the cached runtime configuration so admin checks and
settings commands recognise the latest state.

## Permissions

The client requests the following intents:

- `Guilds`
- `GuildMessages`
- `MessageContent`
- `DirectMessages`

Ensure the bot has permission to read and send messages in the channels where verification commands will be used.
