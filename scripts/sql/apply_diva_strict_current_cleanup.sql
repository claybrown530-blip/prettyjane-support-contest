\i scripts/sql/review_diva_strict_current_targets.sql

with targets as (
  select vote_id::uuid as vote_id
  from diva_strict_current_targets
),
updated as (
  update public.votes v
  set
    vote_status = 'rejected',
    is_valid_vote = false,
    invalid_reason = 'manual_diva_strict_forensic_cleanup_2026_03_12',
    status_reason_code = 'manual_review_rejected',
    status_reason_detail = 'DIVA-only strict forensic cleanup of current counted suspicious clusters',
    status_changed_at = now(),
    status_changed_by = 'manual:diva_strict_forensic_cleanup',
    moderation_note = trim(
      both E'\n'
      from concat_ws(
        E'\n',
        nullif(v.moderation_note, ''),
        '2026-03-12 DIVA strict forensic cleanup: invalidated current counted suspicious clusters'
      )
    )
  from targets t
  where v.id = t.vote_id
  returning v.id
)
select count(*) as invalidated_rows from updated;
