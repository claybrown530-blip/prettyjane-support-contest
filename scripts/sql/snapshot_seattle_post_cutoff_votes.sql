drop table if exists tmp_seattle_post_cutoff_vote_targets;

create temporary table tmp_seattle_post_cutoff_vote_targets as
with cutoff as (
  select
    timestamptz '2026-03-21 07:00:00+00' as cutoff_utc,
    timestamptz '2026-03-21 07:00:00+00' at time zone 'America/Los_Angeles' as cutoff_pt
)
select
  v.id,
  v.created_at,
  v.created_at at time zone 'America/Los_Angeles' as created_at_pt,
  v.city,
  coalesce(v.canonical_band_name, v.band_name) as band_name,
  v.voter_name,
  lower(v.normalized_email) as normalized_email,
  coalesce(
    nullif(to_jsonb(v) ->> 'vote_status', ''),
    case
      when v.is_valid_vote = true then 'counted'
      when v.is_valid_vote = false then 'rejected'
      else 'pending'
    end
  ) as vote_status,
  c.cutoff_utc,
  c.cutoff_pt
from public.votes v
cross join cutoff c
where v.city = 'Seattle, WA'
  and v.created_at >= c.cutoff_utc
  and coalesce(
        nullif(to_jsonb(v) ->> 'vote_status', ''),
        case
          when v.is_valid_vote = true then 'counted'
          when v.is_valid_vote = false then 'rejected'
          else 'pending'
        end
      ) in ('counted', 'pending');

select
  count(*) as target_rows,
  count(*) filter (where vote_status = 'counted') as counted_rows,
  count(*) filter (where vote_status = 'pending') as pending_rows,
  min(created_at) as first_seen_utc,
  max(created_at) as last_seen_utc,
  min(created_at_pt) as first_seen_pt,
  max(created_at_pt) as last_seen_pt
from tmp_seattle_post_cutoff_vote_targets;

select
  band_name,
  count(*) as rows_after_cutoff
from tmp_seattle_post_cutoff_vote_targets
group by band_name
order by rows_after_cutoff desc, band_name;

select
  id,
  created_at,
  created_at_pt,
  city,
  band_name,
  voter_name,
  normalized_email,
  vote_status
from tmp_seattle_post_cutoff_vote_targets
order by created_at, normalized_email;
