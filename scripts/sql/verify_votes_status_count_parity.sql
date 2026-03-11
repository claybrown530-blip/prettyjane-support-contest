-- Count parity between legacy Phase 1 semantics and vote_status semantics.
-- After the migration and before enabling any Phase 2 flags, this should return zero rows.

with legacy_city_totals as (
  select
    city,
    count(*) as legacy_votes
  from public.votes
  where is_valid_vote = true
  group by city
),
status_city_totals as (
  select
    city,
    count(*) as status_votes
  from public.votes
  where vote_status = 'counted'
  group by city
),
city_mismatches as (
  select
    coalesce(l.city, s.city) as city,
    coalesce(l.legacy_votes, 0) as legacy_votes,
    coalesce(s.status_votes, 0) as status_votes,
    coalesce(s.status_votes, 0) - coalesce(l.legacy_votes, 0) as diff
  from legacy_city_totals l
  full join status_city_totals s
    on s.city = l.city
  where coalesce(l.legacy_votes, 0) <> coalesce(s.status_votes, 0)
),
legacy_band_totals as (
  select
    city,
    coalesce(canonical_band_name, band_name) as band_name,
    count(*) as legacy_votes
  from public.votes
  where is_valid_vote = true
  group by city, coalesce(canonical_band_name, band_name)
),
status_band_totals as (
  select
    city,
    coalesce(canonical_band_name, band_name) as band_name,
    count(*) as status_votes
  from public.votes
  where vote_status = 'counted'
  group by city, coalesce(canonical_band_name, band_name)
)
select
  'city' as mismatch_level,
  city,
  null::text as band_name,
  legacy_votes,
  status_votes,
  diff
from city_mismatches

union all

select
  'band' as mismatch_level,
  coalesce(l.city, s.city) as city,
  coalesce(l.band_name, s.band_name) as band_name,
  coalesce(l.legacy_votes, 0) as legacy_votes,
  coalesce(s.status_votes, 0) as status_votes,
  coalesce(s.status_votes, 0) - coalesce(l.legacy_votes, 0) as diff
from legacy_band_totals l
full join status_band_totals s
  on s.city = l.city
 and s.band_name = l.band_name
where coalesce(l.legacy_votes, 0) <> coalesce(s.status_votes, 0)

order by mismatch_level, abs(diff) desc, city, band_name;
