\i scripts/sql/create_ugly_cowboys_reclassification_view.sql

drop view if exists ugly_cowboys_manual_review_clusters;

create temp view ugly_cowboys_manual_review_clusters as
with manual_rows as (
  select
    r.*,
    lower(trim(regexp_replace(replace(coalesce(r.voter_name, ''), '’', ''''), '\s+', ' ', 'g'))) as normalized_voter_name,
    split_part(lower(trim(regexp_replace(replace(coalesce(r.voter_name, ''), '’', ''''), '\s+', ' ', 'g'))), ' ', 1) as first_name_key,
    case
      when strpos(lower(trim(regexp_replace(replace(coalesce(r.voter_name, ''), '’', ''''), '\s+', ' ', 'g'))), ' ') > 0 then true
      else false
    end as full_name_flag,
    split_part(lower(coalesce(r.normalized_email, '')), '@', 1) as local_part,
    regexp_replace(split_part(lower(coalesce(r.normalized_email, '')), '@', 1), '[0-9._+-]+', '', 'g') as local_alpha_key,
    length(regexp_replace(split_part(lower(coalesce(r.normalized_email, '')), '@', 1), '[^0-9]', '', 'g')) as digit_count,
    date_trunc('hour', r.created_at) as hour_bucket
  from ugly_cowboys_reclassification r
  where r.proposed_action = 'MANUAL_REVIEW'
),
enriched as (
  select
    m.*,
    (
      m.local_part ~* '(bot|cow|ugly|diva|fake|spam|lol|lmao|omg|420|666|777|999|cock|bluewaffle|dookie|dummy|meow|burner|trash|horse)'
      or m.local_part ~* '^[0-9._+-]+$'
      or length(m.local_part) <= 3
      or m.local_part ~* '([a-z])\1{2,}'
    ) as troll_or_synthetic_flag,
    count(*) over (partition by m.email_domain, m.first_name_key) as first_name_provider_count,
    count(*) over (partition by m.email_domain, m.local_alpha_key) as local_alpha_provider_count,
    count(*) over (partition by m.email_domain, m.hour_bucket) as provider_hour_count
  from manual_rows m
),
classified as (
  select
    e.*,
    case
      when e.full_name_flag
       and e.name_match_flag = 'YES'
       and not e.troll_or_synthetic_flag
       and e.digit_count <= 2
       and (
         e.cluster_id = 'none'
         or (
           e.cluster_id like 'provider_wave:%'
           and e.email_domain in ('gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'me.com', 'live.com', 'aol.com')
         )
       ) then 'LIKELY_RESTORE'
      when e.full_name_flag
       and e.name_match_flag = 'PARTIAL'
       and not e.troll_or_synthetic_flag
       and e.digit_count <= 2
       and e.cluster_id = 'none' then 'LIKELY_RESTORE'
      when e.troll_or_synthetic_flag
       and (e.name_match_flag = 'NO' or not e.full_name_flag) then 'LIKELY_REMOVE'
      when e.cluster_id like 'first_name_provider:%'
       and e.first_name_provider_count >= 3
       and (e.name_match_flag = 'NO' or not e.full_name_flag) then 'LIKELY_REMOVE'
      when e.cluster_id like 'provider_wave:%'
       and e.provider_hour_count >= 5
       and (e.digit_count >= 3 or e.local_alpha_provider_count >= 2)
       and e.name_match_flag <> 'YES' then 'LIKELY_REMOVE'
      when e.local_alpha_provider_count >= 3
       and (e.name_match_flag = 'NO' or not e.full_name_flag) then 'LIKELY_REMOVE'
      else 'TRUE_GRAY'
    end as review_bucket,
    case
      when e.cluster_id <> 'none' then e.cluster_id
      when e.local_alpha_provider_count >= 2 and e.local_alpha_key <> '' then 'local_family:' || e.email_domain || ':' || e.local_alpha_key
      when e.first_name_provider_count >= 2 and e.first_name_key <> '' then 'first_name_provider:' || e.email_domain || ':' || e.first_name_key
      else 'singleton:' || coalesce(nullif(e.email_domain, ''), 'no-domain')
    end as review_cluster_id
  from enriched e
)
select
  vote_id,
  created_at,
  voter_name,
  normalized_email,
  current_status_bucket,
  invalid_reason,
  status_reason_code,
  action_reason,
  cluster_id,
  name_match_flag,
  cluster_strength,
  restoration_confidence,
  email_domain,
  local_part,
  local_alpha_key,
  digit_count,
  first_name_key,
  full_name_flag,
  troll_or_synthetic_flag,
  first_name_provider_count,
  local_alpha_provider_count,
  provider_hour_count,
  review_bucket,
  review_cluster_id
from classified;
