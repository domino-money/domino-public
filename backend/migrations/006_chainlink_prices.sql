-- Source-specific, still-unqualified Chainlink publication evidence.
-- Reapplying the migration retains every observation and its original proof.
ALTER TABLE domino_activity.price_observations
 DROP CONSTRAINT IF EXISTS price_observations_source_check;
-- NOT VALID on purpose: this file is re-applied by the installers, and a later
-- migration widens the same check for the explicit market-reference sources. A
-- validated re-add here would refuse a database that already holds one of those
-- rows before the widening file runs again. New rows are still checked; the
-- wider constraint that follows validates the whole table.
ALTER TABLE domino_activity.price_observations
 ADD CONSTRAINT price_observations_source_check
 CHECK(source IN ('alchemy_historical','chainlink_robinhood_standard_v1')) NOT VALID;

ALTER TABLE domino_activity.price_observations
 DROP CONSTRAINT IF EXISTS price_observations_chainlink_provenance_check;
ALTER TABLE domino_activity.price_observations
 ADD CONSTRAINT price_observations_chainlink_provenance_check CHECK (
 source <> 'chainlink_robinhood_standard_v1' OR COALESCE((
  jsonb_typeof(provenance)='object'
  AND provenance->'adapterVersion'='1'::jsonb
  AND provenance->>'status'='external_observation_unqualified'
  AND provenance->>'provider'='chainlink'
  AND provenance->>'proxyRole'='standard'
  AND provenance->>'proxy' ~ '^0x[0-9a-f]{40}$'
  AND provenance->>'aggregator' ~ '^0x[0-9a-f]{40}$'
  AND provenance->>'manifestSha256' ~ '^[0-9a-f]{64}$'
  AND provenance->>'roundId' ~ '^[1-9][0-9]{0,24}$'
  AND provenance->>'timestampSemantics'='first_proven_publication_block'
  AND provenance->>'freshnessTimestamp'='answerUpdatedAt'
  AND jsonb_typeof(provenance->'answerUpdatedAt')='number'
  AND provenance->'answerUpdatedAt' >= '0'::jsonb
  AND provenance->'answerUpdatedAt' <= to_jsonb(observed_at)
  AND jsonb_typeof(provenance->'publicationBlock')='object'
  AND provenance#>'{publicationBlock,timestamp}'=to_jsonb(observed_at)
  AND jsonb_typeof(provenance#>'{publicationBlock,number}')='number'
  AND provenance#>'{publicationBlock,number}' > '0'::jsonb
  AND provenance#>>'{publicationBlock,hash}' ~ '^0x[0-9a-f]{64}$'
  AND jsonb_typeof(provenance->'precedingBlock')='object'
  AND jsonb_typeof(provenance#>'{precedingBlock,number}')='number'
  AND provenance#>'{precedingBlock,number}' >= '0'::jsonb
  AND provenance#>'{precedingBlock,number}' < provenance#>'{publicationBlock,number}'
  AND jsonb_typeof(provenance#>'{precedingBlock,timestamp}')='number'
  AND provenance#>'{precedingBlock,timestamp}' >= '0'::jsonb
  AND provenance#>'{precedingBlock,timestamp}' <= to_jsonb(observed_at)
  AND provenance#>>'{precedingBlock,hash}' ~ '^0x[0-9a-f]{64}$'
 ),false)
);
