with votes_with_status as (
  select
    v.id,
    v.created_at,
    v.city,
    coalesce(v.canonical_band_name, v.band_name) as submitted_band,
    v.normalized_email,
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
),
band_home_matches as (
  select
    v.id,
    v.created_at,
    v.city as submitted_city,
    v.submitted_band,
    bh.home_city,
    v.normalized_email,
    v.effective_status,
    v.invalid_reason
  from votes_with_status v
  join public.band_home_city bh
    on bh.canonical_name = v.submitted_band
  where bh.home_city <> v.city
)
select
  submitted_city,
  home_city,
  submitted_band,
  normalized_email,
  effective_status,
  invalid_reason,
  created_at
from band_home_matches
order by created_at desc, submitted_city, submitted_band;
