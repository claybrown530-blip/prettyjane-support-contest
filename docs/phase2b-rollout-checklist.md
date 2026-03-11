# Phase 2B Rollout Checklist

This checklist assumes:

- Phase 1 is already live.
- The runtime patch in `netlify/functions/vote.js` is ready locally but not deployed yet.
- The migration file `scripts/sql/20260311_votes_status_hardening.sql` has not been applied yet.

## Flags

Add these Netlify environment variables before the first Phase 2 runtime deploy:

- `VOTE_STATUS_READ_ENABLED`
- `VOTE_STATUS_WRITE_ENABLED`
- `VOTE_VERIFICATION_ENABLED`

Recommended values by stage:

- Stage 1 deploy: `0 / 0 / 0`
- Stage 2 read-only cutover: `1 / 0 / 0`
- Stage 3 dual-write cutover: `1 / 1 / 0`
- Verification flow later: `1 / 1 / 1`

If your local Netlify CLI is linked/authenticated for this site, use:

```bash
./node_modules/.bin/netlify env:set VOTE_STATUS_READ_ENABLED 0
./node_modules/.bin/netlify env:set VOTE_STATUS_WRITE_ENABLED 0
./node_modules/.bin/netlify env:set VOTE_VERIFICATION_ENABLED 0
```

If the site is not linked locally, set the same values in the Netlify UI before triggering the deploy.

## Exact Commands

Run these from the repo root.

### 1. Review local Phase 2B changes

```bash
git diff -- netlify/functions/vote.js \
  scripts/sql/20260311_votes_status_hardening.sql \
  scripts/sql/review_suspicious_domains.sql \
  scripts/sql/review_suspicious_exact_emails.sql \
  scripts/sql/review_band_aliases.sql \
  scripts/sql/review_wrong_city_routing.sql \
  scripts/sql/review_pending_votes.sql \
  scripts/sql/export_safe_counted_emails.sql \
  scripts/sql/verify_votes_status_schema.sql \
  scripts/sql/verify_votes_status_backfill.sql \
  scripts/sql/verify_votes_status_count_parity.sql \
  scripts/sql/verify_votes_status_active_email_uniqueness.sql \
  docs/phase2b-rollout-checklist.md
```

### 2. Apply the database migration

```bash
./scripts/dev/run-sql.sh scripts/sql/20260311_votes_status_hardening.sql
```

### 3. Run post-migration verification SQL

```bash
./scripts/dev/run-sql.sh scripts/sql/verify_votes_status_schema.sql
./scripts/dev/run-sql.sh scripts/sql/verify_votes_status_backfill.sql
./scripts/dev/run-sql.sh scripts/sql/verify_votes_status_count_parity.sql
./scripts/dev/run-sql.sh scripts/sql/verify_votes_status_active_email_uniqueness.sql
./scripts/dev/run-sql.sh scripts/sql/review_pending_votes.sql
```

### 4. Prepare the first safe runtime deployment with all flags off

Set flags to `0 / 0 / 0`, then deploy the runtime patch:

```bash
git add netlify/functions/vote.js \
  scripts/sql/20260311_votes_status_hardening.sql \
  scripts/sql/review_suspicious_domains.sql \
  scripts/sql/review_suspicious_exact_emails.sql \
  scripts/sql/review_band_aliases.sql \
  scripts/sql/review_wrong_city_routing.sql \
  scripts/sql/review_pending_votes.sql \
  scripts/sql/export_safe_counted_emails.sql \
  scripts/sql/verify_votes_status_schema.sql \
  scripts/sql/verify_votes_status_backfill.sql \
  scripts/sql/verify_votes_status_count_parity.sql \
  scripts/sql/verify_votes_status_active_email_uniqueness.sql \
  docs/phase2b-rollout-checklist.md
git commit -m "Prepare phase 2 vote status rollout"
git push
```

### 5. Enable status-aware reads only

Set:

- `VOTE_STATUS_READ_ENABLED=1`
- `VOTE_STATUS_WRITE_ENABLED=0`
- `VOTE_VERIFICATION_ENABLED=0`

Then trigger a fresh deploy:

```bash
git commit --allow-empty -m "Trigger deploy with vote status reads enabled"
git push
```

### 6. Enable dual-write

Only after the checks below pass, set:

- `VOTE_STATUS_READ_ENABLED=1`
- `VOTE_STATUS_WRITE_ENABLED=1`
- `VOTE_VERIFICATION_ENABLED=0`

Then trigger a fresh deploy:

```bash
git commit --allow-empty -m "Trigger deploy with vote status dual-write enabled"
git push
```

## Verify Before Enabling `VOTE_STATUS_WRITE_ENABLED=1`

These must all be true:

1. `verify_votes_status_schema.sql`
   - both new check constraints exist and `convalidated = true`
   - all four new indexes exist and are `indisvalid = true` and `indisready = true`

2. `verify_votes_status_backfill.sql`
   - `null_vote_status = 0`
   - `null_verification_state = 0`
   - `null_submitted_from = 0`
   - `null_status_changed_at = 0`
   - `null_status_changed_by = 0`
   - `rejected_missing_reason_code = 0`
   - `rejected_missing_reason_detail = 0`
   - `counted_legacy_mismatch = 0`
   - `rejected_legacy_mismatch = 0`
   - `pending_legacy_mismatch = 0`

3. `verify_votes_status_count_parity.sql`
   - returns zero rows

4. `verify_votes_status_active_email_uniqueness.sql`
   - `duplicate_active_email_keys = 0`

5. `review_pending_votes.sql`
   - returns zero rows before verification is enabled

6. With `READ=1`, `WRITE=0`, `VERIFICATION=0`
   - open-city leaderboard matches Phase 1
   - open-city approved-band vote still succeeds
   - fake-band write-in still fails
   - OKC still rejects votes
   - `export_safe_counted_emails.sql` still returns the expected outreach-safe set

## Stop Conditions

Do not enable `VOTE_STATUS_WRITE_ENABLED=1` if any of the following happen:

- the migration verification queries return mismatches or duplicates
- `review_pending_votes.sql` shows unexpected rows
- the read-only cutover changes leaderboard counts
- duplicate-vote blocking changes unexpectedly
- the outreach-safe export changes in a way you cannot explain
