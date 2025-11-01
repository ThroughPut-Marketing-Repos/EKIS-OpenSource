# Database Maintenance

The `removeDuplicateVerifiedUsers` helper in `src/database/maintenance.js` is executed during service
start-up to tidy the `verified_users` table before schema migrations run.

## Verified user deduplication

- The cleanup now deletes any record that is missing either the `influencer` or `uid` key before
  attempting to merge duplicates. These legacy NULL entries blocked the upcoming NOT NULL + UNIQUE
  constraint and can safely be discarded.
- Duplicate groups are reloaded using `IS NULL` aware predicates so rows with missing keys are
  correctly detected. When multiple records share the same `(influencer, uid)` pair the richest
  record is retained, additional metadata is merged into it, and the redundant rows are removed.
- All deletions and updates are logged through the shared Winston logger (`src/utils/logger.js`) to
  make production cleanups auditable.

If the helper reports removals without updates it usually means NULL-key rows were purged. Operators
can re-run the maintenance script without downtime; the routine is idempotent and skips work when the
schema or model is unavailable.
