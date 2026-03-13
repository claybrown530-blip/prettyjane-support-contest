drop view if exists diva_strict_current_targets;

create temp view diva_strict_current_targets as
with counted_votes as (
  select
    v.id::text as vote_id,
    v.created_at,
    v.city,
    coalesce(v.band_name, '') as original_band_name,
    coalesce(v.canonical_band_name, v.band_name, '') as band_name,
    coalesce(v.voter_name, '') as voter_name,
    lower(trim(regexp_replace(replace(coalesce(v.voter_name, ''), '’', ''''), '\s+', ' ', 'g'))) as normalized_voter_name,
    split_part(lower(trim(regexp_replace(replace(coalesce(v.voter_name, ''), '’', ''''), '\s+', ' ', 'g'))), ' ', 1) as first_name_key,
    case
      when strpos(lower(trim(regexp_replace(replace(coalesce(v.voter_name, ''), '’', ''''), '\s+', ' ', 'g'))), ' ') > 0 then true
      else false
    end as full_name_flag,
    lower(coalesce(v.normalized_email, '')) as normalized_email,
    split_part(lower(coalesce(v.normalized_email, '')), '@', 1) as local_part,
    split_part(lower(coalesce(v.normalized_email, '')), '@', 2) as email_domain
  from public.votes v
  where v.city = 'OKC, OK'
    and coalesce(v.canonical_band_name, v.band_name, '') = 'DIVA'
    and coalesce(
      nullif(to_jsonb(v) ->> 'vote_status', ''),
      case
        when v.is_valid_vote = true then 'counted'
        when v.is_valid_vote = false then 'rejected'
        else 'pending'
      end
    ) = 'counted'
    and v.normalized_email is not null
    and v.normalized_email <> ''
),
enriched as (
  select
    c.*,
    regexp_replace(c.local_part, '[0-9._+-]+', '', 'g') as family_key,
    regexp_replace(c.local_part, '[^a-z]+', '', 'g') as compact_local,
    regexp_replace(c.normalized_voter_name, '[^a-z]+', '', 'g') as compact_name,
    length(regexp_replace(c.local_part, '[^0-9]', '', 'g')) as digit_count,
    date_trunc('hour', c.created_at) as hour_bucket,
    case
      when c.normalized_voter_name <> ''
       and regexp_replace(c.normalized_voter_name, '[^a-z]+', '', 'g') <> ''
       and position(regexp_replace(c.normalized_voter_name, '[^a-z]+', '', 'g') in regexp_replace(c.local_part, '[^a-z]+', '', 'g')) > 0 then 'YES'
      when c.first_name_key <> ''
       and position(c.first_name_key in regexp_replace(c.local_part, '[^a-z]+', '', 'g')) > 0 then 'PARTIAL'
      else 'NO'
    end as name_match_flag,
    (
      c.local_part ~* '(bot|diva|fake|spam|troll|lol|lmao|omg|420|69|666|777|999)'
      or c.local_part ~* '^[0-9._+-]+$'
      or c.local_part ~* '([a-z])\1{2,}'
      or c.local_part ~* '(.)\1{4,}'
      or length(c.local_part) <= 3
      or regexp_replace(c.local_part, '[^a-z]', '', 'g') ~ '^[bcdfghjklmnpqrstvwxyz]{6,}$'
      or length(regexp_replace(c.local_part, '[^0-9]', '', 'g')) >= 4
      or (
        length(regexp_replace(c.local_part, '[^0-9]', '', 'g')) >= 3
        and length(regexp_replace(c.local_part, '[^0-9]', '', 'g')) >= greatest(length(regexp_replace(c.local_part, '[^a-z]', '', 'g')), 1)
      )
    ) as suspicious_local_flag
  from counted_votes c
),
clustered as (
  select
    e.*,
    count(*) over (partition by e.email_domain, e.normalized_voter_name) as name_provider_count,
    count(*) filter (where e.suspicious_local_flag)
      over (partition by e.email_domain, e.normalized_voter_name) as name_provider_suspicious_count,
    count(*) over (partition by e.email_domain, e.family_key) as family_provider_count,
    count(*) filter (where e.suspicious_local_flag)
      over (partition by e.email_domain, e.family_key) as family_provider_suspicious_count,
    count(*) over (partition by e.email_domain, e.first_name_key) as first_name_provider_count,
    count(*) filter (where e.suspicious_local_flag)
      over (partition by e.email_domain, e.first_name_key) as first_name_provider_suspicious_count,
    count(*) over (partition by e.email_domain, e.hour_bucket) as provider_hour_count,
    count(*) filter (where e.suspicious_local_flag)
      over (partition by e.email_domain, e.hour_bucket) as provider_hour_suspicious_count
  from enriched e
),
flagged as (
  select
    c.*,
    case
      when c.normalized_voter_name <> ''
       and c.name_provider_count >= 2
       and c.name_provider_suspicious_count >= 1 then 'name_provider:' || c.email_domain || ':' || c.normalized_voter_name
      when c.family_key <> ''
       and c.family_provider_count >= 2
       and c.family_provider_suspicious_count >= 2 then 'family_provider:' || c.email_domain || ':' || c.family_key
      when c.first_name_key <> ''
       and c.first_name_provider_count >= 3
       and c.first_name_provider_suspicious_count >= 2
       and c.name_match_flag <> 'YES' then 'first_name_provider:' || c.email_domain || ':' || c.first_name_key
      when c.provider_hour_count >= 5
       and c.provider_hour_suspicious_count >= 4
       and c.name_match_flag <> 'YES' then 'provider_hour:' || c.email_domain || ':' || to_char(c.hour_bucket, 'YYYY-MM-DD HH24:00')
      when c.suspicious_local_flag
       and c.name_match_flag = 'NO' then 'suspicious_local:' || c.email_domain || ':' || c.local_part
      else null
    end as cluster_id,
    case
      when c.normalized_voter_name <> ''
       and c.name_provider_count >= 2
       and c.name_provider_suspicious_count >= 1 then 'repeated same-name/provider mutation family'
      when c.family_key <> ''
       and c.family_provider_count >= 2
       and c.family_provider_suspicious_count >= 2 then 'tight local-part family with suspicious members'
      when c.first_name_key <> ''
       and c.first_name_provider_count >= 3
       and c.first_name_provider_suspicious_count >= 2
       and c.name_match_flag <> 'YES' then 'repeated first-name/provider wave with suspicious density'
      when c.provider_hour_count >= 5
       and c.provider_hour_suspicious_count >= 4
       and c.name_match_flag <> 'YES' then 'same-hour provider burst with high suspicious density'
      when c.suspicious_local_flag
       and c.name_match_flag = 'NO' then 'troll/gibberish/numeric-heavy local with no name match'
      else null
    end as removal_reason,
    case
      when c.normalized_voter_name <> ''
       and c.name_provider_count >= 2
       and c.name_provider_suspicious_count >= 1 then 'HIGH'
      when c.family_key <> ''
       and c.family_provider_count >= 2
       and c.family_provider_suspicious_count >= 2 then 'HIGH'
      when c.first_name_key <> ''
       and c.first_name_provider_count >= 3
       and c.first_name_provider_suspicious_count >= 2
       and c.name_match_flag <> 'YES' then 'MEDIUM'
      when c.provider_hour_count >= 5
       and c.provider_hour_suspicious_count >= 4
       and c.name_match_flag <> 'YES' then 'MEDIUM'
      when c.suspicious_local_flag
       and c.name_match_flag = 'NO' then 'MEDIUM'
      else null
    end as evidence_strength
  from clustered c
)
select
  vote_id,
  created_at,
  city,
  original_band_name,
  band_name,
  voter_name,
  normalized_voter_name,
  normalized_email,
  local_part,
  email_domain,
  name_match_flag,
  suspicious_local_flag,
  digit_count,
  name_provider_count,
  family_provider_count,
  first_name_provider_count,
  provider_hour_count,
  cluster_id,
  removal_reason,
  evidence_strength
from flagged
where cluster_id is not null;
