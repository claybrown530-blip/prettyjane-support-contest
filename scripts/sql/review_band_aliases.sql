with normalized_roster as (
  select
    city,
    name as canonical_name,
    lower(trim(regexp_replace(replace(name, '’', ''''), '\s+', ' ', 'g'))) as normalized_name
  from public.bands
),
votes_with_status as (
  select
    v.city,
    v.band_name,
    v.canonical_band_name,
    v.normalized_band_name,
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
)
select
  v.city,
  coalesce(v.canonical_band_name, v.band_name) as submitted_band,
  v.normalized_band_name,
  count(*) as total_attempts,
  count(*) filter (where v.effective_status = 'counted') as counted_votes,
  count(*) filter (where v.effective_status = 'pending') as pending_votes,
  count(*) filter (where v.effective_status = 'rejected') as rejected_votes,
  string_agg(distinct v.invalid_reason, ', ' order by v.invalid_reason) filter (where v.invalid_reason is not null) as rejection_reasons,
  max(v.created_at) as last_seen_at,
  max(nr.canonical_name) as approved_city_band,
  max(ba.canonical_name) as local_alias_target,
  max(bag.canonical_name) as global_alias_target,
  bool_or(nr.canonical_name is not null) as on_selected_city_roster
from votes_with_status v
left join normalized_roster nr
  on nr.city = v.city
 and nr.normalized_name = v.normalized_band_name
left join public.band_aliases ba
  on ba.city = v.city
 and ba.alias = v.normalized_band_name
left join public.band_aliases_global bag
  on bag.alias = v.normalized_band_name
group by v.city, coalesce(v.canonical_band_name, v.band_name), v.normalized_band_name
having not bool_or(nr.canonical_name is not null)
    or max(ba.canonical_name) is not null
    or max(bag.canonical_name) is not null
    or count(*) filter (where v.effective_status = 'rejected') > 0
order by rejected_votes desc, pending_votes desc, total_attempts desc, v.city, submitted_band;
