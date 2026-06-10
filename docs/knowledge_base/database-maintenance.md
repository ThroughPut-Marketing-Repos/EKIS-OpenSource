# Database Maintenance

The `removeDuplicateVerifiedUsers` helper in `src/database/maintenance.js` is executed during service
start-up to tidy the `verified_users` table before schema migrations run.

During the same phase the service now calls `removeOrphanedForeignKeys` to ensure the relational
integrity of the `verified_users` and `volume_snapshots` tables before `sequelize.sync()` attempts to
enforce foreign key constraints. The routine clears references to deleted exchanges or API keys so
the bot can boot even if manual database edits left behind dangling identifiers.

The service also calls `repairApiKeyHashUniqueIndex` before and after schema sync. This keeps exactly
one unique index on `api_keys.api_key_hash`: duplicate MySQL indexes such as `api_key_hash_2`,
`api_key_hash_3`, and later suffixes are removed before sync, and a missing unique index is recreated
after sync for fresh databases. The `ApiKey` model intentionally leaves uniqueness out of the
column-level definition so Sequelize `alter` does not issue a new `ALTER TABLE ... UNIQUE` statement
on every startup.

## Verified user deduplication

- The cleanup now deletes any record that is missing either the `influencer` or `uid` key before
  attempting to merge duplicates. These legacy NULL entries blocked the upcoming NOT NULL + UNIQUE
  constraint and can safely be discarded.
- Duplicate groups are reloaded using `IS NULL` aware predicates so rows with missing keys are
  correctly detected. When multiple records share the same `(influencer, uid)` pair the richest
  record is retained, additional metadata is merged into it, and the redundant rows are removed.
- The helper resolves the physical verified-user table name case-insensitively and temporarily
  retargets the Sequelize model when legacy deployments still expose the historical `VerifiedUsers`
  identifier. This ensures duplicate removal always runs before schema migrations regardless of
  database casing drift.
- All deletions and updates are logged through the shared Winston logger (`src/utils/logger.js`) to
  make production cleanups auditable.

## Orphaned foreign key cleanup

- When an exchange or API key row is removed outside of the application, affected `verified_users`
  rows now have their `exchangeId` or `apiKeyId` columns nulled automatically.
- `volume_snapshots` entries that reference missing exchanges are also normalised by setting their
  `exchangeId` to `NULL`. Snapshot metadata (UID and exchange slug) is preserved so historical
  records remain available for analytics.
- Like the deduplication routine, foreign key repair automatically retargets the `VerifiedUser`
  model so legacy table names are handled without manual intervention.
- Each cleanup run emits either debug logs (when no issues are detected) or a summary info log
  containing the number of repaired references. Truncated lists of affected row IDs are provided in
  warning logs to assist with operational audits without flooding log storage.

If the helper reports removals without updates it usually means NULL-key rows were purged. Operators
can re-run the maintenance script without downtime; the routine is idempotent and skips work when the
schema or model is unavailable.

## API key hash index repair

- Production MySQL can accumulate duplicate unique indexes when column-level Sequelize uniqueness is
  applied repeatedly through `sync({ alter: true })`.
- Startup maintenance keeps the preferred `api_key_hash` index and removes duplicate single-column
  unique indexes on the same field before schema sync can hit MySQL's 64-key table limit.
- The repair is idempotent. If the table does not exist yet, the pre-sync pass skips it and the
  post-sync pass creates the unique index for the newly created table.
