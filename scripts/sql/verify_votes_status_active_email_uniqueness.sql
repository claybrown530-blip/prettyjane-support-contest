-- Active vote uniqueness verification for the new partial unique index.
-- After the migration, this should report duplicate_active_email_keys = 0.

with active_duplicates as (
  select
    city,
    normalized_email,
    count(*) as active_vote_count,
    string_agg(vote_status, ', ' order by created_at, id) as active_statuses
  from public.votes
  where normalized_email is not null
    and normalized_email <> ''
    and vote_status in ('counted', 'pending')
  group by city, normalized_email
  having count(*) > 1
)
select
  count(*) as duplicate_active_email_keys,
  coalesce(sum(active_vote_count), 0) as duplicate_active_vote_rows
from active_duplicates;

select
  city,
  normalized_email,
  active_vote_count,
  active_statuses
from active_duplicates
order by active_vote_count desc, city, normalized_email
limit 200;
