with votes_with_status as (
  select
    v.normalized_email,
    v.city,
    v.canonical_band_name,
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
    v.city,
    v.normalized_email,
    v.canonical_band_name
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
  v.city,
  count(*) as approved_counted_votes,
  count(distinct v.normalized_email) as outreach_safe_email_count,
  count(distinct v.canonical_band_name) as approved_bands_with_safe_votes
from approved_counted_votes v
join outreach_safe_emails s
  on s.normalized_email = v.normalized_email
group by v.city
order by v.city;
