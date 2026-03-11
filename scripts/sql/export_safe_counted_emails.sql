with votes_with_status as (
  select
    normalized_email,
    voter_name,
    voter_phone,
    city,
    canonical_band_name,
    created_at,
    case
      when is_valid_vote = true then 'counted'
      when is_valid_vote = false then 'rejected'
      else 'pending'
    end as effective_status
  from public.votes
  where normalized_email is not null
    and normalized_email <> ''
),
approved_counted_votes as (
  select
    v.*
  from votes_with_status v
  join public.bands b
    on b.city = v.city
   and b.name = v.canonical_band_name
  where v.effective_status = 'counted'
),
safe_emails as (
  select normalized_email
  from votes_with_status
  group by normalized_email
  having count(*) filter (where effective_status <> 'counted') = 0
),
outreach_safe_emails as (
  select normalized_email
  from safe_emails
  where split_part(normalized_email, '@', 2) !~* '(^example\.com$|\.con$|^[a-z]\.com$|fake|scam|mailinator|guerrillamail|tempmail|trashmail|10minutemail|yopmail|asdf|blah|q{4,})'
)
select
  v.normalized_email as email,
  max(v.voter_name) as voter_name,
  max(v.voter_phone) as voter_phone,
  string_agg(distinct v.city, ' | ' order by v.city) as cities,
  string_agg(distinct v.canonical_band_name, ' | ' order by v.canonical_band_name) as approved_bands_voted_for,
  min(v.created_at) as first_counted_vote_at,
  max(v.created_at) as last_counted_vote_at
from approved_counted_votes v
join outreach_safe_emails s
  on s.normalized_email = v.normalized_email
group by v.normalized_email
order by email;
