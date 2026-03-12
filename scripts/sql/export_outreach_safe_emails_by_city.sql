\if :{?city_name}
\else
\echo Missing required psql variable: city_name
\echo Example: psql "$DATABASE_URL" -v city_name='Spokane, WA' -f scripts/sql/export_outreach_safe_emails_by_city.sql
\quit 1
\endif

with votes_with_status as (
  select
    v.normalized_email,
    v.voter_name,
    v.voter_phone,
    v.city,
    v.canonical_band_name,
    v.created_at,
    coalesce(
      nullif(to_jsonb(v) ->> 'vote_status', ''),
      case
        when v.is_valid_vote = true then 'counted'
        when v.is_valid_vote = false then 'rejected'
        else 'pending'
      end
    ) as effective_status
  from public.votes v
  where v.normalized_email is not null
    and v.normalized_email <> ''
),
approved_counted_votes as (
  select
    v.*
  from votes_with_status v
  join public.bands b
    on b.city = v.city
   and b.name = v.canonical_band_name
  where v.effective_status = 'counted'
    and v.city = :'city_name'
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
  max(v.city) as city,
  string_agg(distinct v.canonical_band_name, ' | ' order by v.canonical_band_name) as approved_bands_voted_for,
  min(v.created_at) as first_counted_vote_at,
  max(v.created_at) as last_counted_vote_at
from approved_counted_votes v
join outreach_safe_emails s
  on s.normalized_email = v.normalized_email
group by v.normalized_email
order by email;
