# Volume Verifier

`src/services/volumeVerifier.js` centralises the logic that confirms a UID belongs to the configured affiliate programme,
validates the deposit requirement, and captures a fresh volume snapshot for analytics. The module exposes two functions:

- `verify(uid, options)` &ndash; Fetches the trading volume from the selected exchange and returns the structured result.
- `getExchanges()` &ndash; Provides metadata for all configured exchanges including minimum volume thresholds and affiliate
  links.

## Verification flow

1. Resolve the exchange ID. The provided `options.exchangeId` takes precedence, otherwise the global
   `verification.defaultExchange` is used.
2. Determine the minimum volume. The per-exchange `minimumVolume` is preferred, then `options.minimumVolume`, then the
   global `verification.minimumVolume`. Volume targets are now informational only; failures no longer block verification.
3. Execute the exchange client:
   - `mock` exchanges read from the static `volumes` map in the configuration file.
   - `rest` exchanges send an HTTP request using Axios. The request path defaults to `/uids/{uid}/volume` but can be
     overridden per exchange.
4. Execute the exchange-specific deposit verifier. The verification halts early when the user is missing from the
   affiliate lists or the deposit requirement is not met.
5. When verification succeeds, persist a new volume snapshot (unless the exchange client already captured one internally).
6. Log the verification result using the shared Winston logger.
7. Return `{ uid, exchangeId, volume, minimumVolume, passed, timestamp, source, deposit, volumeMet, affiliateLink }`,
   where `deposit` captures the evaluated threshold, whether it was met, and any raw amount reported by the exchange.

Errors from exchange clients are normalised so user-facing responses avoid leaking implementation details.

## Duplicate UID handling

`src/services/verificationService.js` persists the outcome of successful verifications in the
`verified_users` table. Some exchanges occasionally resend the same verification payload in quick
succession, which can surface a `SequelizeUniqueConstraintError` even after the application checks for
an existing record. The service now treats those database-level validation errors as a signal that the
UID already exists. When encountered, it reloads the persisted entry, confirms that the identity fields
(`telegramId`, `discordUserId`, and `userId`) do not conflict with the incoming request, and returns the
stored record. If a mismatch is detected, the helper raises a `VerifiedUserConflictError` so the bot can
inform the requester that another account already claimed the UID.

This approach keeps the verification flow resilient during race conditions while still preventing
account takeovers when the cached identifiers differ.

## Exchange integrations

The bot ships with dedicated helpers for several partner programmes. These classes live under
`src/services` and provide consistent logging plus snapshot management so the verification layer can reuse
trading volume data later on.

- `blofinService.js` handles Blofin affiliate lookups. It signs requests with the provided API key trio,
  checks deposit totals during UID verification, and persists invitee trading volume snapshots (including
  deposit amounts) for downstream analytics.
- `bitunixService.js` implements the Bitunix partner API. It sorts request parameters prior to calculating the
  SHA1 signature, validates deposits via the `/validateUser` endpoint, and stores 30-day volume snapshots once
  a user clears the threshold.
- `bitgetService.js` exposes an API-key verification utility for Bitget credentials. It signs requests using
  Bitget's HMAC scheme and emits verbose debug logs when `EXCHANGE_VERBOSE_LOGGING` is enabled.
- `blofin` and `bitunix` exchange types are now wired directly into the volume verifier, ensuring both trading
  volume and deposit requirements are evaluated before approving a UID.

All helpers emit logs through the shared Winston logger, making it easier to trace request/response flows when
debugging exchange connectivity issues.
