# Trading Volume Monitor

`src/services/tradingVolumeMonitor.js` schedules a daily compliance job that keeps verified users aligned with the configured
trading volume policy. The cron expression defaults to `0 0 * * *` (midnight UTC) and can be customised by providing an
alternate scheduler when the service is instantiated.

## Responsibilities

The monitor performs the following steps on each run:

1. Load the merged runtime configuration via `getConfig()`.
2. Exit early when `verification.volumeCheckEnabled` is `false` so the job can be paused without code changes.
3. Fetch all verified users from the database, including exchange metadata when available.
4. Calculate the recorded trading volume from the verification timestamp up to the earlier of "now" or the configured
   deadline (`verification.volumeCheckDays`).
5. Compare the measured volume against `verification.minimumVolume` or the per-exchange override.
6. Issue a warning when:
   - The user has not yet met the requirement.
   - The current time is within the warning window (`verification.volumeWarningDays`).
   - A prior warning has not already been recorded inside the same window.
7. Revoke access when the deadline passes without the minimum volume being reached. Revocation removes the database entry and
   attempts to strip the configured Discord role.

The job logs a summary containing the number of warnings sent and revocations processed to assist with monitoring.

## Notifications

Notifications leverage the existing Discord and Telegram clients when they are supplied during service construction:

- Discord users receive a direct message and, when a `verifiedRoleId` is configured for their guild, the role is removed to
  revoke access.
- Telegram users receive a direct message in the chat they used during verification.

When no messaging channel is available the monitor still logs the compliance breach and, for revocations, removes the
database record to force re-verification.

## Configuration

The following configuration values (managed by `configUpdateService`) control the behaviour:

| Key | Purpose |
| --- | --- |
| `verification.volumeCheckEnabled` | Turns the compliance job on or off. |
| `verification.minimumVolume` | Base minimum trading volume requirement. |
| `verification.volumeCheckDays` | Number of days users have to meet the requirement. |
| `verification.volumeWarningEnabled` | Enables or disables pre-deadline warnings. |
| `verification.volumeWarningDays` | Number of days before expiry that warnings are sent. |

Warnings are tracked via the `volumeWarningDate` column on `VerifiedUser`. Once a user meets the requirement the monitor
resets this value so future compliance windows can trigger new warnings.
