with votes_with_status as (
  select
    v.created_at,
    v.normalized_email,
    split_part(v.normalized_email, '@', 2) as email_domain,
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
  where normalized_email is not null
    and normalized_email <> ''
),
domain_rollup as (
  select
    email_domain,
    count(*) as total_attempts,
    count(distinct normalized_email) as unique_emails,
    count(*) filter (where effective_status = 'counted') as counted_votes,
    count(*) filter (where effective_status = 'pending') as pending_votes,
    count(*) filter (where effective_status = 'rejected') as rejected_votes,
    string_agg(distinct invalid_reason, ', ' order by invalid_reason) filter (where invalid_reason is not null) as rejection_reasons,
    min(created_at) as first_seen_at,
    max(created_at) as last_seen_at,
    (
      email_domain ~* '(^example\.com$|\.con$|^[a-z]\.com$|fake|scam|mailinator|guerrillamail|tempmail|trashmail|10minutemail|yopmail|q{4,}|asdf|blah)'
    ) as obvious_fake_pattern
  from votes_with_status
  group by email_domain
)
select
  email_domain,
  total_attempts,
  unique_emails,
  counted_votes,
  pending_votes,
  rejected_votes,
  rejection_reasons,
  first_seen_at,
  last_seen_at,
  obvious_fake_pattern
from domain_rollup
where obvious_fake_pattern
   or rejected_votes > 0
   or pending_votes > 0
   or unique_emails >= 3
order by obvious_fake_pattern desc, rejected_votes desc, pending_votes desc, unique_emails desc, email_domain;
