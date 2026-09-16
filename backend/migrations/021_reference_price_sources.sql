-- Explicitly mapped external market references, still unqualified. These are
-- the sources the 13 September probes actually returned for the canonical
-- assets (Alchemy Prices on Ethereum, CoinGecko chart by listed coin id). They
-- stay separate from the strict production names: a paid provider response is
-- not an independent, causal, event-time price.
ALTER TABLE domino_activity.price_observations
 DROP CONSTRAINT IF EXISTS price_observations_source_check;
ALTER TABLE domino_activity.price_observations
 ADD CONSTRAINT price_observations_source_check
 CHECK(source IN ('alchemy_historical','chainlink_robinhood_standard_v1',
                  'alchemy_canonical_market_reference_v1',
                  'coingecko_market_chart_reference_v1'));

ALTER TABLE domino_activity.price_observations
 DROP CONSTRAINT IF EXISTS price_observations_reference_provenance_check;
ALTER TABLE domino_activity.price_observations
 ADD CONSTRAINT price_observations_reference_provenance_check CHECK (
 source NOT IN ('alchemy_canonical_market_reference_v1','coingecko_market_chart_reference_v1')
 OR COALESCE((
  jsonb_typeof(provenance)='object'
  AND octet_length(provenance::text)<=4096
  AND provenance->>'status'='external_market_reference_unqualified'
  AND provenance->>'mappingVersion'='1'
  AND provenance->>'robinhoodCurrency'=currency
  AND provenance->>'pointTimestampSemanticsQualified'='false'
  AND provenance->>'targetPoolIndependenceVerified'='false'
  AND (
   (source='alchemy_canonical_market_reference_v1'
    AND provenance->>'provider'='alchemy'
    AND provenance#>>'{reference,kind}'='canonical_ethereum_address'
    AND provenance#>>'{reference,network}'='eth-mainnet'
    AND provenance#>>'{reference,address}' ~ '^0x[0-9a-f]{40}$')
   OR
   (source='coingecko_market_chart_reference_v1'
    AND provenance->>'provider'='coingecko'
    AND provenance#>>'{reference,kind}'='coingecko_coin_id'
    AND provenance#>>'{reference,coinId}' ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
  )
 ),false));
