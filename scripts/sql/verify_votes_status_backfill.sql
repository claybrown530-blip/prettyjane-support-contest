-- Post-migration backfill verification for vote_status and related metadata.

select
  count(*) as total_votes,
  count(*) filter (where vote_status is null) as null_vote_status,
  count(*) filter (where verification_state is null) as null_verification_state,
  count(*) filter (where submitted_from is null) as null_submitted_from,
  count(*) filter (where status_changed_at is null) as null_status_changed_at,
  count(*) filter (where status_changed_by is null) as null_status_changed_by,
  count(*) filter (where vote_status = 'rejected' and status_reason_code is null) as rejected_missing_reason_code,
  count(*) filter (
    where vote_status = 'rejected'
      and invalid_reason is not null
      and status_reason_detail is null
  ) as rejected_missing_reason_detail,
  count(*) filter (
    where vote_status = 'counted'
      and is_valid_vote is distinct from true
  ) as counted_legacy_mismatch,
  count(*) filter (
    where vote_status = 'rejected'
      and is_valid_vote is distinct from false
  ) as rejected_legacy_mismatch,
  count(*) filter (
    where vote_status = 'pending'
      and is_valid_vote is not null
  ) as pending_legacy_mismatch
from public.votes;

select
  vote_status,
  verification_state,
  count(*) as votes
from public.votes
group by vote_status, verification_state
order by vote_status, verification_state;

select
  coalesce(cast(is_valid_vote as text), 'null') as legacy_is_valid_vote,
  vote_status,
  count(*) as votes
from public.votes
group by legacy_is_valid_vote, vote_status
order by legacy_is_valid_vote, vote_status;
