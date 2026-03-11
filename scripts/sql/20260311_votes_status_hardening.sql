-- Draft migration for a stronger vote status model.
-- Rollout order:
-- 1. Apply this migration.
-- 2. Backfill legacy rows.
-- 3. Deploy the app in dual-write mode (`is_valid_vote` + `vote_status`).
-- 4. After the new active-email index is validated, retire the legacy partial index.

alter table public.votes
  add column if not exists vote_status text,
  add column if not exists status_reason_code text,
  add column if not exists status_reason_detail text,
  add column if not exists status_changed_at timestamp with time zone,
  add column if not exists status_changed_by text,
  add column if not exists moderation_flags text[] not null default '{}'::text[],
  add column if not exists moderation_note text,
  add column if not exists honeypot_value text,
  add column if not exists verification_state text not null default 'not_requested',
  add column if not exists verification_token_hash text,
  add column if not exists verification_sent_at timestamp with time zone,
  add column if not exists verified_at timestamp with time zone,
  add column if not exists submitted_from text not null default 'web_form';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'votes_vote_status_check'
      and conrelid = 'public.votes'::regclass
  ) then
    alter table public.votes
      add constraint votes_vote_status_check
      check (vote_status in ('counted', 'pending', 'rejected')) not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'votes_verification_state_check'
      and conrelid = 'public.votes'::regclass
  ) then
    alter table public.votes
      add constraint votes_verification_state_check
      check (verification_state in ('not_requested', 'pending', 'verified', 'failed')) not valid;
  end if;
end $$;

update public.votes
set
  vote_status = case
    when is_valid_vote = true then 'counted'
    when is_valid_vote = false then 'rejected'
    else 'pending'
  end,
  status_reason_code = case
    when is_valid_vote = false then 'legacy_rejected'
    else null
  end,
  status_reason_detail = case
    when is_valid_vote = false then nullif(invalid_reason, '')
    else null
  end,
  status_changed_at = coalesce(status_changed_at, created_at, now()),
  status_changed_by = coalesce(status_changed_by, 'system:migration_20260311'),
  verification_state = coalesce(verification_state, 'not_requested'),
  submitted_from = coalesce(nullif(submitted_from, ''), 'web_form')
where vote_status is null
   or (is_valid_vote = false and status_reason_code is null)
   or (is_valid_vote = false and invalid_reason is not null and status_reason_detail is null)
   or status_changed_at is null
   or status_changed_by is null
   or verification_state is null
   or submitted_from is null;

create index concurrently if not exists votes_status_city_band_idx
  on public.votes (vote_status, city, canonical_band_name);

create index concurrently if not exists votes_status_reason_idx
  on public.votes (vote_status, status_reason_code);

create index concurrently if not exists votes_email_domain_idx
  on public.votes ((split_part(normalized_email, '@', 2)));

create unique index concurrently if not exists votes_one_active_email_per_city
  on public.votes (city, normalized_email)
  where normalized_email is not null
    and normalized_email <> ''
    and vote_status in ('counted', 'pending');

alter table public.votes validate constraint votes_vote_status_check;

alter table public.votes validate constraint votes_verification_state_check;

-- Keep the legacy partial unique index until the application has fully switched:
--   votes_one_valid_email_per_city on (city, normalized_email) where is_valid_vote = true
