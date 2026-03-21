drop table if exists tmp_seattle_post_cutoff_vote_updates;

create temporary table tmp_seattle_post_cutoff_vote_updates as
with cutoff as (
  select timestamptz '2026-03-21 07:00:00+00' as cutoff_utc
),
targets as (
  select
    v.id,
    'seattle_cutoff_after_2026_03_20_235959_pt' as target_reason
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
        ) in ('counted', 'pending')
),
updated as (
  update public.votes v
  set vote_status = 'rejected',
      is_valid_vote = false,
      invalid_reason = 'manual_seattle_cutoff_after_2026_03_20_235959_pt',
      status_reason_code = 'manual_review_rejected',
      status_reason_detail = 'Seattle cutoff cleanup: reject votes submitted at or after 2026-03-21 00:00:00 America/Los_Angeles',
      status_changed_at = now(),
      status_changed_by = 'manual:seattle_cutoff_20260321'
  from targets t
  where v.id = t.id
  returning
    v.id,
    v.created_at,
    v.created_at at time zone 'America/Los_Angeles' as created_at_pt,
    v.city,
    coalesce(v.canonical_band_name, v.band_name) as band_name,
    v.voter_name,
    lower(v.normalized_email) as normalized_email,
    t.target_reason
)
select *
from updated;

select
  target_reason,
  count(*) as votes_removed,
  min(created_at) as first_seen_utc,
  max(created_at) as last_seen_utc,
  min(created_at_pt) as first_seen_pt,
  max(created_at_pt) as last_seen_pt
from tmp_seattle_post_cutoff_vote_updates
group by target_reason;

select
  band_name,
  count(*) as votes_removed
from tmp_seattle_post_cutoff_vote_updates
group by band_name
order by votes_removed desc, band_name;

select
  id,
  created_at,
  created_at_pt,
  city,
  band_name,
  voter_name,
  normalized_email,
  target_reason
from tmp_seattle_post_cutoff_vote_updates
order by created_at, normalized_email;
