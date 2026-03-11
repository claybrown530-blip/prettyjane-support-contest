with votes_with_status as (
  select
    v.normalized_email,
    v.city,
    v.created_at,
    coalesce(
      nullif(to_jsonb(v) ->> 'vote_status', ''),
      case
        when v.is_valid_vote = true then 'counted'
        when v.is_valid_vote = false then 'rejected'
        else 'pending'
      end
    ) as effective_status,
    v.invalid_reason
  from public.votes v
  where normalized_email is not null
    and normalized_email <> ''
)
select
  normalized_email,
  count(*) as total_attempts,
  count(distinct city) as city_count,
  string_agg(distinct city, ' | ' order by city) as cities,
  count(*) filter (where effective_status = 'counted') as counted_votes,
  count(*) filter (where effective_status = 'pending') as pending_votes,
  count(*) filter (where effective_status = 'rejected') as rejected_votes,
  string_agg(distinct invalid_reason, ', ' order by invalid_reason) filter (where invalid_reason is not null) as rejection_reasons,
  min(created_at) as first_seen_at,
  max(created_at) as last_seen_at
from votes_with_status
group by normalized_email
having count(*) > 1
    or count(distinct city) > 1
    or count(*) filter (where effective_status = 'rejected') > 0
    or count(*) filter (where effective_status = 'pending') > 0
order by rejected_votes desc, pending_votes desc, total_attempts desc, normalized_email;
