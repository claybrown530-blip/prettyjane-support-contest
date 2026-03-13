drop view if exists ugly_cowboys_reclassification;

create temp view ugly_cowboys_reclassification as
with base as (
  select
    v.id::text as vote_id,
    v.created_at,
    v.city,
    coalesce(v.voter_name, '') as voter_name,
    lower(trim(regexp_replace(replace(coalesce(v.voter_name, ''), '’', ''''), '\s+', ' ', 'g'))) as normalized_voter_name,
    split_part(lower(trim(regexp_replace(replace(coalesce(v.voter_name, ''), '’', ''''), '\s+', ' ', 'g'))), ' ', 1) as first_name_key,
    case
      when strpos(lower(trim(regexp_replace(replace(coalesce(v.voter_name, ''), '’', ''''), '\s+', ' ', 'g'))), ' ') > 0 then true
      else false
    end as full_name_flag,
    lower(coalesce(v.normalized_email, '')) as normalized_email,
    split_part(lower(coalesce(v.normalized_email, '')), '@', 1) as local_part,
    split_part(lower(coalesce(v.normalized_email, '')), '@', 2) as email_domain,
    regexp_replace(split_part(lower(coalesce(v.normalized_email, '')), '@', 1), '[0-9._+-]+', '', 'g') as family_key,
    coalesce(v.band_name, '') as original_band_name,
    coalesce(v.canonical_band_name, '') as canonical_band_name,
    case
      when coalesce(
        nullif(to_jsonb(v) ->> 'vote_status', ''),
        case
          when v.is_valid_vote = true then 'counted'
          when v.is_valid_vote = false then 'rejected'
          else 'pending'
        end
      ) = 'counted' then 'VALID'
      else 'INVALID'
    end as current_status_bucket,
    coalesce(v.invalid_reason, '') as invalid_reason,
    coalesce(nullif(to_jsonb(v) ->> 'status_reason_code', ''), '') as status_reason_code,
    date_trunc('hour', v.created_at) as hour_bucket
  from public.votes v
  where v.city = 'OKC, OK'
    and coalesce(v.canonical_band_name, v.band_name, '') = 'ugly cowboys'
),
enriched as (
  select
    b.*,
    regexp_replace(b.normalized_voter_name, '[^a-z]+', '', 'g') as compact_name,
    regexp_replace(b.local_part, '[^a-z]+', '', 'g') as compact_local,
    length(regexp_replace(b.local_part, '[^0-9]', '', 'g')) as digit_count,
    length(regexp_replace(b.local_part, '[^a-z]', '', 'g')) as alpha_count,
    (
      b.local_part ~* '(bot|cowboy|ugly|diva|fake|spam|lol|lmao|omg|420|666|777|999|cock|bluewaffle|dookie|dummy|meow)'
      or b.local_part ~* '^[0-9._+-]+$'
      or b.local_part ~* '([a-z])\1{2,}'
      or b.local_part ~* '(.)\1{4,}'
      or length(b.local_part) <= 3
      or regexp_replace(b.local_part, '[^a-z]', '', 'g') ~ '^[bcdfghjklmnpqrstvwxyz]{6,}$'
    ) as strong_synthetic_local_flag,
    (
      b.local_part ~* '^[a-z]{0,4}[0-9]{2,}[a-z0-9._+-]*$'
      or length(regexp_replace(b.local_part, '[^0-9]', '', 'g')) >= 3
      or b.local_part ~* '[._+-]'
      or b.local_part ~* '([a-z])\1{1,}'
    ) as weak_synthetic_local_flag
  from base b
),
same_local_provider_counts as (
  select
    e.local_part,
    count(distinct e.email_domain) as same_local_provider_count
  from enriched e
  group by e.local_part
),
cluster_counts as (
  select
    e.*,
    count(*) over (partition by e.email_domain, e.normalized_voter_name) as name_provider_count,
    count(*) filter (where e.strong_synthetic_local_flag or e.weak_synthetic_local_flag)
      over (partition by e.email_domain, e.normalized_voter_name) as name_provider_suspicious_count,
    count(*) over (partition by e.email_domain, e.first_name_key) as first_name_provider_count,
    count(*) over (partition by e.email_domain, e.family_key) as family_provider_count,
    count(*) filter (where e.strong_synthetic_local_flag or e.weak_synthetic_local_flag)
      over (partition by e.email_domain, e.family_key) as family_provider_suspicious_count,
    count(*) over (partition by e.local_part) as same_local_count,
    coalesce(s.same_local_provider_count, 0) as same_local_provider_count,
    count(*) over (partition by e.email_domain, e.hour_bucket) as provider_hour_count,
    count(*) filter (where e.strong_synthetic_local_flag or e.weak_synthetic_local_flag)
      over (partition by e.email_domain, e.hour_bucket) as provider_hour_suspicious_count
  from enriched e
  left join same_local_provider_counts s
    on s.local_part = e.local_part
),
classified as (
  select
    c.vote_id,
    c.created_at,
    c.voter_name,
    c.normalized_email,
    c.original_band_name,
    c.canonical_band_name,
    c.current_status_bucket,
    c.invalid_reason,
    c.status_reason_code,
    c.normalized_voter_name,
    c.family_key,
    case
      when c.normalized_voter_name <> ''
       and c.full_name_flag
       and c.compact_name <> ''
       and position(c.compact_name in c.compact_local) > 0 then 'YES'
      when c.first_name_key <> ''
       and position(c.first_name_key in c.compact_local) > 0 then 'PARTIAL'
      else 'NO'
    end as name_match_flag,
    case
      when c.same_local_provider_count >= 2
        or (c.normalized_voter_name <> '' and c.name_provider_count >= 2 and c.name_provider_suspicious_count >= 1)
        or (c.family_key <> '' and c.family_provider_count >= 2 and c.family_provider_suspicious_count >= 2)
        or c.strong_synthetic_local_flag
        or (c.provider_hour_count >= 5 and c.provider_hour_suspicious_count >= 4 and (c.strong_synthetic_local_flag or c.family_provider_count >= 2))
        then 'HIGH'
      when c.provider_hour_count >= 5
        or c.first_name_provider_count >= 3
        or c.family_provider_count >= 2
        or c.name_provider_count >= 2
        then 'MEDIUM'
      when c.weak_synthetic_local_flag
        or c.first_name_provider_count = 2
        then 'LOW'
      else 'NONE'
    end as cluster_strength,
    case
      when c.same_local_provider_count >= 2 then 'cross_provider_local:' || c.local_part
      when c.normalized_voter_name <> ''
       and c.name_provider_count >= 2
       and c.name_provider_suspicious_count >= 1 then 'name_provider:' || c.email_domain || ':' || c.normalized_voter_name
      when c.family_key <> ''
       and c.family_provider_count >= 2
       and c.family_provider_suspicious_count >= 2 then 'family_provider:' || c.email_domain || ':' || c.family_key
      when c.provider_hour_count >= 5
       and c.provider_hour_suspicious_count >= 4
       and (c.strong_synthetic_local_flag or c.family_provider_count >= 2) then 'provider_hour:' || c.email_domain || ':' || to_char(c.hour_bucket, 'YYYY-MM-DD HH24:00')
      when c.provider_hour_count >= 5 then 'provider_wave:' || c.email_domain || ':' || to_char(c.hour_bucket, 'YYYY-MM-DD HH24:00')
      when c.first_name_provider_count >= 3 and c.first_name_key <> '' then 'first_name_provider:' || c.email_domain || ':' || c.first_name_key
      else 'none'
    end as cluster_id,
    case
      when c.same_local_provider_count >= 2 then 'AUTO_REMOVE'
      when c.normalized_voter_name <> ''
       and c.name_provider_count >= 2
       and c.name_provider_suspicious_count >= 1 then 'AUTO_REMOVE'
      when c.family_key <> ''
       and c.family_provider_count >= 2
       and c.family_provider_suspicious_count >= 2 then 'AUTO_REMOVE'
      when c.strong_synthetic_local_flag then 'AUTO_REMOVE'
      when c.provider_hour_count >= 5
       and c.provider_hour_suspicious_count >= 4
       and (c.strong_synthetic_local_flag or c.family_provider_count >= 2) then 'AUTO_REMOVE'
      when c.full_name_flag
       and c.compact_name <> ''
       and position(c.compact_name in c.compact_local) > 0
       and not c.strong_synthetic_local_flag
       and c.name_provider_count = 1
       and c.family_provider_count = 1
       and c.same_local_provider_count = 1
       and not (c.provider_hour_count >= 5 and c.provider_hour_suspicious_count >= 3) then 'AUTO_KEEP'
      when c.full_name_flag
       and c.first_name_key <> ''
       and position(c.first_name_key in c.compact_local) > 0
       and not c.strong_synthetic_local_flag
       and c.name_provider_count = 1
       and c.family_provider_count = 1
       and c.same_local_provider_count = 1
       and not (c.provider_hour_count >= 5 and c.provider_hour_suspicious_count >= 4) then 'AUTO_KEEP'
      else 'MANUAL_REVIEW'
    end as proposed_action,
    case
      when c.same_local_provider_count >= 2 then 'same local part used across multiple providers'
      when c.normalized_voter_name <> ''
       and c.name_provider_count >= 2
       and c.name_provider_suspicious_count >= 1 then 'repeated same-name mutation family on one provider'
      when c.family_key <> ''
       and c.family_provider_count >= 2
       and c.family_provider_suspicious_count >= 2 then 'tight local-part mutation family on one provider'
      when c.strong_synthetic_local_flag then 'gibberish/troll/numeric-heavy local part'
      when c.provider_hour_count >= 5
       and c.provider_hour_suspicious_count >= 4
       and (c.strong_synthetic_local_flag or c.family_provider_count >= 2) then 'clustered provider burst with synthetic density'
      when c.full_name_flag
       and c.compact_name <> ''
       and position(c.compact_name in c.compact_local) > 0
       and c.name_provider_count = 1
       and c.family_provider_count = 1
       and c.same_local_provider_count = 1 then 'full-name human row with strong name/email match and no tight cluster'
      when c.full_name_flag
       and c.first_name_key <> ''
       and position(c.first_name_key in c.compact_local) > 0
       and c.name_provider_count = 1
       and c.family_provider_count = 1
       and c.same_local_provider_count = 1 then 'full-name row with partial name/email match and no strong cluster'
      when c.first_name_provider_count >= 3 then 'repeated first-name/provider wave without tight synthetic family'
      when c.provider_hour_count >= 5 then 'broad provider-wave signal without tight exact family'
      else 'mismatch or novelty row without strong cluster evidence'
    end as action_reason,
    c.email_domain,
    c.same_local_provider_count,
    c.name_provider_count,
    c.name_provider_suspicious_count,
    c.family_provider_count,
    c.family_provider_suspicious_count,
    c.first_name_provider_count,
    c.provider_hour_count,
    c.provider_hour_suspicious_count,
    c.full_name_flag,
    c.compact_name,
    c.compact_local,
    c.first_name_key,
    c.strong_synthetic_local_flag,
    c.weak_synthetic_local_flag
  from cluster_counts c
),
finalized as (
  select
    c.*,
    case
      when c.same_local_provider_count >= 2
        or (c.normalized_voter_name <> '' and c.name_provider_count >= 2 and c.name_provider_suspicious_count >= 1)
        or (c.family_key <> '' and c.family_provider_count >= 2 and c.family_provider_suspicious_count >= 2)
        or c.strong_synthetic_local_flag
        then 'LOW'
      when c.proposed_action = 'AUTO_KEEP'
        and c.name_match_flag = 'YES' then 'HIGH'
      when c.proposed_action = 'AUTO_KEEP' then 'MEDIUM'
      when c.proposed_action = 'MANUAL_REVIEW' then 'MEDIUM'
      else 'LOW'
    end as restoration_confidence
  from classified c
)
select
  vote_id,
  created_at,
  voter_name,
  normalized_email,
  original_band_name,
  canonical_band_name,
  current_status_bucket,
  invalid_reason,
  status_reason_code,
  proposed_action,
  action_reason,
  cluster_id,
  name_match_flag,
  cluster_strength,
  restoration_confidence,
  email_domain
from finalized;
