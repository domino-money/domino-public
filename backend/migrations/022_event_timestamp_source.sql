-- How each activity event got its timestamp. A deep backfill costs one provider
-- header per distinct event block, and a dense pool has an event in almost every
-- block: that is what made the bill explode. Events inside the retention window
-- keep an exact timestamp read from their block; older ones are interpolated
-- between the two verified chunk boundaries and say so.
ALTER TABLE domino_activity.events
 ADD COLUMN IF NOT EXISTS timestamp_source text;
-- Rows written before this migration read their own block, so they are exact.
UPDATE domino_activity.events SET timestamp_source='exact' WHERE timestamp_source IS NULL;
ALTER TABLE domino_activity.events ALTER COLUMN timestamp_source SET DEFAULT 'exact';
ALTER TABLE domino_activity.events ALTER COLUMN timestamp_source SET NOT NULL;
ALTER TABLE domino_activity.events
 DROP CONSTRAINT IF EXISTS events_timestamp_source_check;
ALTER TABLE domino_activity.events
 ADD CONSTRAINT events_timestamp_source_check
 CHECK (timestamp_source IN ('exact','block_range_derived'));
