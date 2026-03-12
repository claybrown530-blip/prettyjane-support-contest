# Stable Vote Operations

Current stable mode as of March 11, 2026:

- `VOTE_STATUS_READ_ENABLED=1`
- `VOTE_STATUS_WRITE_ENABLED=1`
- `VOTE_VERIFICATION_ENABLED=0`

This means:

- leaderboard reads are status-aware
- new submissions dual-write both legacy and Phase 2 status fields
- `counted` votes are the only votes that should count
- `pending` is not in active use yet
- email verification is intentionally off

## Daily Monitoring Commands

Run these from the repo root:

```bash
./scripts/dev/run-sql.sh scripts/sql/daily_check_count_parity.sql
./scripts/dev/run-sql.sh scripts/sql/daily_check_active_email_uniqueness.sql
./scripts/dev/run-sql.sh scripts/sql/daily_check_pending_review.sql
./scripts/dev/run-sql.sh scripts/sql/daily_check_safe_counted_email_totals_by_city.sql
./scripts/dev/run-sql.sh scripts/sql/daily_check_suspicious_domains.sql
./scripts/dev/run-sql.sh scripts/sql/daily_check_suspicious_exact_emails.sql
```

Expected steady-state results:

- `daily_check_count_parity.sql`: zero rows
- `daily_check_active_email_uniqueness.sql`: zero duplicate keys and zero detail rows
- `daily_check_pending_review.sql`: zero rows while verification is off
- `daily_check_safe_counted_email_totals_by_city.sql`: non-zero counts only for active cities you expect
- suspicious review scripts: review new junk, typo, or abuse clusters before outreach exports

## Daily Moderation Workflow

1. Run the three integrity checks first.
   If count parity, active email uniqueness, or pending review fails, stop and investigate before exporting or moderating.

2. If count parity fails, reconcile live writes first.

```bash
./scripts/dev/run-sql.sh scripts/sql/reconcile_votes_status_after_live_writes.sql
./scripts/dev/run-sql.sh scripts/sql/verify_votes_status_count_parity.sql
./scripts/dev/run-sql.sh scripts/sql/verify_votes_status_active_email_uniqueness.sql
./scripts/dev/run-sql.sh scripts/sql/review_pending_votes.sql
```

3. Review suspicious domains and suspicious exact emails.
   Look for typo domains, disposable providers, repeated abuse from one inbox, or cross-city anomalies.

4. Review safe counted email totals by city.
   This is the quickest check that outreach-safe inventory still looks plausible before any export.

5. Export outreach-safe emails only after the checks above are clean.

## Export Commands

All-city outreach-safe export:

```bash
./scripts/dev/run-sql.sh scripts/sql/export_outreach_safe_emails_all_cities.sql
```

City-specific outreach-safe export:

```bash
bash -lc 'set -a; source .env.local; set +a; psql "$DATABASE_URL" -v city_name="Spokane, WA" -f scripts/sql/export_outreach_safe_emails_by_city.sql'
```

Approved roster bands by city:

```bash
./scripts/dev/run-sql.sh scripts/sql/export_approved_roster_bands_by_city.sql
```

## Operating Rules

- Keep `VOTE_VERIFICATION_ENABLED=0` until a full verification flow is designed, deployed, and tested.
- Do not change `VOTE_STATUS_READ_ENABLED` or `VOTE_STATUS_WRITE_ENABLED` during routine moderation.
- Never use raw `public.votes` exports for outreach.
- Use only the outreach-safe export scripts for email lists.
- If the suspicious review scripts surface new junk domain patterns, update the anti-abuse allow/block rules in a normal code review cycle.
