drop table if exists tmp_seattle_half_life_fake_wave_targets;

create temporary table tmp_seattle_half_life_fake_wave_targets as
with target_rows as (
  select
    v.id,
    v.created_at,
    v.created_at at time zone 'America/Los_Angeles' as created_at_pt,
    v.city,
    coalesce(v.canonical_band_name, v.band_name) as band_name,
    v.voter_name,
    lower(v.normalized_email) as normalized_email,
    split_part(lower(v.normalized_email), '@', 2) as email_domain,
    case
      when split_part(lower(v.normalized_email), '@', 2) in (
        'gmail.ckm',
        'gmail.xom',
        'fmail.xom',
        'mns.com',
        'dobslop.ror',
        'mall.trus',
        'yomny.lov',
        'hub.gov',
        'g.gov',
        'lwss.orgs',
        'jommy.lol',
        're.com',
        'da.rain',
        'ggoh.vok',
        'watch.gam',
        'glomy.rob',
        'potter.mov',
        'res.turaunt',
        'robby.edu',
        'stom.hav',
        'go.go',
        'omg.omg',
        'player.cool',
        'darkrei.gov.tv',
        'potter.msn.com',
        'cuis.ine',
        'tuvaloodo.eu',
        'slop.edu',
        'for.comp',
        'fresh.yum',
        'play.pool',
        'ahhhh.ahhh',
        'ital.ia',
        'lol.slom',
        'plz.plz',
        'zombie.com',
        'gma.com',
        'gamil.com'
      ) then 'fake_domain_wave'
      when lower(trim(coalesce(v.voter_name, ''))) in (
        'zombie',
        'billie eilish',
        'david guetta',
        'usher',
        'lady gaga',
        'taylor swift (the other one)',
        'nicki minaj',
        'katy perry',
        'bella hadid',
        'madonna',
        'elon musk',
        'addison rae',
        'keir starmer',
        'enver hoxha',
        'doctor evan explained',
        'bobby kennedy jr.',
        'bobby kennedy sr.',
        'pink finger',
        'cook cook vook',
        'ahhhh',
        'plz',
        'so',
        'get',
        'laundry',
        '20 mins',
        'omg'
      ) then 'troll_identity_wave'
      else null
    end as target_reason
  from public.votes v
  where v.city = 'Seattle, WA'
    and replace(
          lower(regexp_replace(coalesce(v.normalized_band_name, v.canonical_band_name, v.band_name), '\s+', ' ', 'g')),
          ' ',
          ''
        ) = 'halflife'
    and coalesce(
          nullif(to_jsonb(v) ->> 'vote_status', ''),
          case
            when v.is_valid_vote = true then 'counted'
            when v.is_valid_vote = false then 'rejected'
            else 'pending'
          end
        ) = 'counted'
    and (
      (v.created_at >= timestamptz '2026-03-21 03:34:00+00' and v.created_at < timestamptz '2026-03-21 04:00:00+00')
      or
      (v.created_at >= timestamptz '2026-03-21 06:35:00+00' and v.created_at < timestamptz '2026-03-21 07:00:00+00')
    )
)
select *
from target_rows
where target_reason is not null;

select
  target_reason,
  count(*) as target_rows,
  min(created_at) as first_seen_utc,
  max(created_at) as last_seen_utc,
  min(created_at_pt) as first_seen_pt,
  max(created_at_pt) as last_seen_pt
from tmp_seattle_half_life_fake_wave_targets
group by target_reason
order by target_reason;

select
  email_domain,
  count(*) as target_rows
from tmp_seattle_half_life_fake_wave_targets
group by email_domain
order by target_rows desc, email_domain;

select
  id,
  created_at,
  created_at_pt,
  city,
  band_name,
  voter_name,
  normalized_email,
  email_domain,
  target_reason
from tmp_seattle_half_life_fake_wave_targets
order by created_at, normalized_email;
