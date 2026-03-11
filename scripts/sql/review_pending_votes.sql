with votes_with_status as (
  select
    v.id,
    v.created_at,
    v.city,
    v.voter_name,
    v.normalized_email,
    coalesce(v.canonical_band_name, v.band_name) as submitted_band,
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
)
select
  id,
  created_at,
  city,
  voter_name,
  normalized_email,
  submitted_band,
  invalid_reason
from votes_with_status
where effective_status = 'pending'
order by created_at desc;
