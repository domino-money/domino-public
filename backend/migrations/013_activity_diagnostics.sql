-- Operator-only metadata on the existing source row, not qualified activity.
-- No revision or published event/model is changed. Pool deletion/truncation
-- naturally removes the diagnostic; successful indexing/rewind clears it.
ALTER TABLE domino_activity.pools
 ADD COLUMN IF NOT EXISTS activity_diagnostic jsonb;
ALTER TABLE domino_activity.pools
 DROP CONSTRAINT IF EXISTS activity_diagnostic_shape_check;
ALTER TABLE domino_activity.pools
 ADD CONSTRAINT activity_diagnostic_shape_check CHECK (
 activity_diagnostic IS NULL OR COALESCE((
  jsonb_typeof(activity_diagnostic)='object'
  AND octet_length(activity_diagnostic::text)<=8192
  AND activity_diagnostic->>'status'='blocked'
  AND activity_diagnostic->>'reason'='activity_range_budget_exhausted'
 ),false)
);
-- Existing reader SELECT / writer DML grants on pools cover this column.
