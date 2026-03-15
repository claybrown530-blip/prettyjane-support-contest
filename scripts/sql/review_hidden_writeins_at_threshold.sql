-- Mirrors the current production write-in visibility rule:
-- off-roster counted write-ins in open write-in cities become leaderboard-visible
-- once their spacing-insensitive normalized band-name group reaches 5 counted votes.
with open_writein_cities(city) as (
  values
    ('Seattle, WA'),
    ('San Francisco, CA'),
    ('San Diego, CA')
),
votes_with_status as (
  select
    v.created_at,
    v.city,
    coalesce(v.canonical_band_name, v.band_name) as band_name,
    regexp_replace(
      coalesce(
        nullif(v.normalized_band_name, ''),
        lower(trim(regexp_replace(replace(coalesce(v.canonical_band_name, v.band_name), '’', ''''), '\s+', ' ', 'g')))
      ),
      '\s+',
      '',
      'g'
    ) as normalized_band_name,
    coalesce(
      nullif(to_jsonb(v) ->> 'vote_status', ''),
      case
        when v.is_valid_vote = true then 'counted'
        when v.is_valid_vote = false then 'rejected'
        else 'pending'
      end
    ) as effective_status
  from public.votes v
  join open_writein_cities c
    on c.city = v.city
  where not exists (
    select 1
    from public.bands b
    where b.city = v.city
      and b.name = coalesce(v.canonical_band_name, v.band_name)
  )
),
counted_hidden_writeins as (
  select
    created_at,
    city,
    band_name,
    normalized_band_name
  from votes_with_status
  where effective_status = 'counted'
    and normalized_band_name is not null
    and normalized_band_name <> ''
),
label_counts as (
  select
    city,
    normalized_band_name,
    band_name,
    count(*) as label_vote_count
  from counted_hidden_writeins
  group by city, normalized_band_name, band_name
),
ranked_labels as (
  select
    city,
    normalized_band_name,
    band_name,
    label_vote_count,
    row_number() over (
      partition by city, normalized_band_name
      order by label_vote_count desc, char_length(band_name) asc, band_name asc
    ) as label_rank
  from label_counts
),
threshold_groups as (
  select
    city,
    normalized_band_name,
    count(*) as counted_votes,
    min(created_at) as first_seen_at,
    max(created_at) as latest_seen_at
  from counted_hidden_writeins
  group by city, normalized_band_name
  having count(*) >= 5
)
select
  g.city,
  r.band_name,
  g.counted_votes,
  g.first_seen_at,
  g.latest_seen_at
from threshold_groups g
join ranked_labels r
  on r.city = g.city
 and r.normalized_band_name = g.normalized_band_name
 and r.label_rank = 1
order by g.counted_votes desc, g.city, r.band_name;
