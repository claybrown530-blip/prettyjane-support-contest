\i scripts/sql/create_ugly_cowboys_reclassification_view.sql

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
from ugly_cowboys_reclassification
where (current_status_bucket = 'INVALID' and proposed_action = 'AUTO_KEEP')
   or (current_status_bucket = 'VALID' and proposed_action = 'AUTO_REMOVE')
order by
  proposed_action,
  case when trim(coalesce(voter_name, '')) = '' then 1 else 0 end,
  voter_name,
  normalized_email,
  created_at;
