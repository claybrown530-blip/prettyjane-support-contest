\i scripts/sql/create_ugly_cowboys_reclassification_view.sql

with restore_targets as (
  select vote_id::uuid as vote_id
  from ugly_cowboys_reclassification
  where current_status_bucket = 'INVALID'
    and proposed_action = 'AUTO_KEEP'
),
invalidate_targets as (
  select vote_id::uuid as vote_id
  from ugly_cowboys_reclassification
  where current_status_bucket = 'VALID'
    and proposed_action = 'AUTO_REMOVE'
),
restored as (
  update public.votes v
  set
    vote_status = 'counted',
    is_valid_vote = true,
    invalid_reason = null,
    status_reason_code = null,
    status_reason_detail = null,
    status_changed_at = now(),
    status_changed_by = 'manual:ugly_cowboys_balanced_correction',
    moderation_note = trim(
      both E'\n'
      from concat_ws(
        E'\n',
        nullif(v.moderation_note, ''),
        '2026-03-12 ugly cowboys balanced correction: restored AUTO_KEEP reclassification'
      )
    )
  from restore_targets t
  where v.id = t.vote_id
  returning v.id
),
invalidated as (
  update public.votes v
  set
    vote_status = 'rejected',
    is_valid_vote = false,
    invalid_reason = 'manual_ugly_cowboys_balanced_correction_2026_03_12',
    status_reason_code = 'manual_review_rejected',
    status_reason_detail = 'AUTO_REMOVE from ugly cowboys balanced reclassification',
    status_changed_at = now(),
    status_changed_by = 'manual:ugly_cowboys_balanced_correction',
    moderation_note = trim(
      both E'\n'
      from concat_ws(
        E'\n',
        nullif(v.moderation_note, ''),
        '2026-03-12 ugly cowboys balanced correction: invalidated AUTO_REMOVE reclassification'
      )
    )
  from invalidate_targets t
  where v.id = t.vote_id
  returning v.id
)
select
  (select count(*) from restored) as restored_rows,
  (select count(*) from invalidated) as invalidated_rows,
  (select count(*) from restored) - (select count(*) from invalidated) as net_vote_change;
