-- Post-migration schema verification for scripts/sql/20260311_votes_status_hardening.sql

select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'votes'
  and column_name in (
    'vote_status',
    'status_reason_code',
    'status_reason_detail',
    'status_changed_at',
    'status_changed_by',
    'moderation_flags',
    'moderation_note',
    'honeypot_value',
    'verification_state',
    'verification_token_hash',
    'verification_sent_at',
    'verified_at',
    'submitted_from'
  )
order by column_name;

select
  conname,
  convalidated,
  pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.votes'::regclass
  and conname in (
    'votes_vote_status_check',
    'votes_verification_state_check'
  )
order by conname;

select
  i.relname as index_name,
  ix.indisvalid,
  ix.indisready,
  pg_get_indexdef(ix.indexrelid) as definition
from pg_index ix
join pg_class i
  on i.oid = ix.indexrelid
where ix.indrelid = 'public.votes'::regclass
  and i.relname in (
    'votes_status_city_band_idx',
    'votes_status_reason_idx',
    'votes_email_domain_idx',
    'votes_one_active_email_per_city',
    'votes_one_valid_email_per_city'
  )
order by i.relname;
