"""The daily featured-pools selection: listing, verification, rules, list.

Reads only: GeckoTerminal listing pages at the selection's provider priority,
one multi read for the pools already shown, and the chain through the
collector's own verified pool read with the provider disabled. Writes only
the featured_* tables. No demand, no catalogue seed and no history job: the
shadow phase must not change anything the collectors do.
"""
from collections import Counter
from decimal import Decimal
import time

from discovery import Block, DataError
import featured_evidence as evidence
import featured_pools as rules
from featured_store import utc_date
from gt_listing import MAX_MULTI, PAGE_SIZE, GeckoListing
from market_cache import MarketCache
from markets_snapshot import MarketsSnapshot
from pool_apr import estimate_pool_apr
from read_deadline import read_deadline
from read_service import ReadService
from selected_pools import SELECTED_POOLS

CANDIDATE_SECONDS = 30


class _NoProvider:
    """The selector's cache is filled from the listing; it never calls a provider."""
    def pool(self, pool_id):
        raise DataError('provider_disabled')

    def hourly_prices(self, pool_id, **kwargs):
        raise DataError('provider_disabled')


def _decimal_text(fraction):
    return str(Decimal(fraction.numerator) / Decimal(fraction.denominator))


class Selector:
    def __init__(self, *, store, catalogue, policy, public_data=None, rpc_urls=None, rpc_factory=None,
                 transport_factory=None, listing=None, clock=time.time, max_rpc_calls=3000, max_seconds=240,
                 embedded=SELECTED_POOLS):
        if listing is None and public_data is None:
            raise DataError('featured_listing_unconfigured')
        self.store, self.catalogue, self.policy, self.clock = store, catalogue, policy, clock
        self.rpc_urls, self.rpc_factory, self.transport_factory = rpc_urls, rpc_factory, transport_factory
        self.max_rpc_calls, self.max_seconds, self.embedded = max_rpc_calls, max_seconds, list(embedded)
        self.listing = listing or GeckoListing(clock=clock, reserve=lambda: public_data.reserve_provider_if_headroom(
            policy['listingProviderHeadroom']))

    # ------------------------------------------------------------ reading
    def _service(self):
        options = dict(catalogue=self.catalogue, clock=self.clock, rpc_urls=self.rpc_urls,
                       rpc_factory=self.rpc_factory, public_data=None, requests=None, snapshot=MarketsSnapshot(),
                       market_cache=MarketCache(_NoProvider(), reserve_provider=lambda: False))
        if self.transport_factory is not None:
            options['transport_factory'] = self.transport_factory
        service = ReadService(**options)
        factory, spent = service.transport_factory, {'items': 0}

        def bounded_factory():
            transport = factory()

            def bounded(url, body=None):
                count = len(body) if isinstance(body, list) else 1 if isinstance(body, dict) else 0
                if spent['items'] + count > self.max_rpc_calls:
                    raise DataError('featured_rpc_budget_exhausted')
                spent['items'] += count
                return transport(url, body) if body is not None else transport(url)
            return bounded
        service.transport_factory = bounded_factory
        return service, spent

    def _catalogue_identity(self, pool_id):
        with self.catalogue.connection() as conn:
            return conn.execute('''SELECT 'catalogue_event' AS source,block_number FROM domino_catalogue.events
              WHERE pool_id=%s UNION ALL SELECT 'catalogue_hint' AS source,NULL AS block_number
              FROM domino_catalogue.hints WHERE pool_id=%s LIMIT 1''', (pool_id, pool_id)).fetchone()

    def _token(self, rpc, token, block, ctx):
        found = evidence.token_evidence(rpc, token, block)
        baseline = ctx['baselines'].get(token)
        if baseline is not None:
            found['baselineCodeHash'] = baseline['listed_code_hash']
        if isinstance(found.get('symbol'), str) and found['symbol']:
            found['symbolReading'] = rules.symbol_reading(found['symbol'])
        found['reasons'] = rules.token_reasons(found, self.policy, published_readings=ctx['readings'],
                                               excluded_tokens=ctx['excludedTokens'])
        ctx['tokens'][token] = found
        return found

    def _depth(self, raw, reference, rpc, block, ctx):
        if raw is None:
            return {'status': 'unmeasurable', 'reason': 'walk_exceeds_max_steps'}
        price = None
        if self.policy['referenceTokens'][reference]['symbol'] != 'USDG':
            if 'ethPrice' not in ctx:
                ctx['ethPrice'] = evidence.eth_price(rpc, self.policy, block)
            price = ctx['ethPrice']
            if price is None:
                return {'status': 'unmeasurable', 'reason': 'eth_price_unavailable', 'raw': str(raw)}
        return {'status': 'measured', 'raw': str(raw),
                'usd': _decimal_text(rules.depth_usd(raw, reference, self.policy, price))}

    def _evaluate(self, pool_id, item, *, relaxed, ctx):
        """Everything the rules read about one pool, then the rules themselves."""
        market = item['market'] if item else None
        listing = item['listing'] if item else None
        candidate = {'poolId': pool_id, 'market': market, 'listing': listing,
                     'age': {'createdAt': listing['createdAt'] if listing else None}}
        extra = {'poolKey': None, 'tokens': None, 'identitySource': None,
                 'ageSource': 'provider_pool_created_at' if listing and listing['createdAt'] is not None else None,
                 'block': None, 'error': None}
        service, rpc = ctx['service'], ctx['rpc']
        try:
            with read_deadline(CANDIDATE_SECONDS):
                if market is not None:
                    age = max(0, int(self.clock()) - market['retrievedAt'])
                    service.market_cache.restore_pool(pool_id, {
                        'status': 'available', 'reason': None, 'data': market,
                        'cache': {'ageSeconds': age, 'freshForSeconds': 60, 'maxStaleSeconds': 300}},
                        elapsed_seconds=0)
                known = self._catalogue_identity(pool_id)
                response = service.pool_market(pool_id, allow_provider=False)
                pool, block = response['pool'], Block(**response['snapshot'])
                extra.update(poolKey=pool['poolKey'], block=response['snapshot'],
                             identitySource=known['source'] if known else 'position_manager')
                candidate['estimate'] = estimate_pool_apr(response, now=int(self.clock()))
                liquidity = evidence.active_liquidity(rpc, pool_id, block)
                candidate['chain'] = {'pool': pool, 'liquidity': liquidity}
                if known and known['block_number'] is not None:
                    candidate['age'] = {'createdAt': evidence.block_timestamp(rpc, known['block_number'])}
                    extra['ageSource'] = 'catalogue_event'
                side, _ = rules.reference_side(pool['currencies'], self.policy)
                if side is not None:
                    reference, other, major = side
                    decimals = {token: entry['decimals'] for token, entry in self.policy['referenceTokens'].items()}
                    symbols = {token: entry['symbol'] for token, entry in self.policy['referenceTokens'].items()}
                    if not major:
                        token = ctx['tokens'].get(other) or self._token(rpc, other, block, ctx)
                        candidate['token'] = token
                        decimals[other], symbols[other] = token.get('decimals'), token.get('symbol')
                    extra['tokens'] = [{'address': currency, 'symbol': symbols.get(currency),
                                        'decimals': decimals.get(currency)} for currency in pool['currencies']]
                    raw, _ = evidence.depth(rpc, pool, block, self.policy, liquidity=liquidity,
                                            reference_is_currency1=reference == pool['currencies'][1])
                    candidate['depth'] = self._depth(raw, reference, rpc, block, ctx)
                    candidate['providerPriceDeviation'] = rules.provider_price_deviation(listing, market, pool, decimals)
        except DataError as error:
            extra['error'] = str(error)
            if 'chain' not in candidate:
                candidate['chain'] = {'error': str(error)}
        result = rules.evaluate(candidate, self.policy, now=ctx['now'], previous=ctx['previous'], relaxed=relaxed,
                                excluded_pools=ctx['excludedPools'], excluded_tokens=ctx['excludedTokens'],
                                published_readings=ctx['readings'])
        return {**result, **extra, 'depth': candidate.get('depth'),
                'providerPriceDeviation': candidate.get('providerPriceDeviation')}

    # ------------------------------------------------------------ selecting
    def select(self, *, now=None, phase='shadow', final=True):
        """One selection for the UTC date of `now`; at most one completed per date.

        A listing the provider cut short is `incomplete` and retried while
        `final` is false; the final attempt of the day then keeps yesterday's
        list (`carried_over`). The first run with no evaluation to persist
        against only records one (`bootstrap`).
        """
        if phase != 'shadow':
            raise DataError('featured_phase_unavailable')
        now = int(self.clock()) if now is None else now
        day, started = utc_date(now), int(self.clock())
        if self.store.selection_done(phase, day):
            return {'outcome': 'already_done', 'selectionDate': day.isoformat()}
        overrides = self.store.overrides(now)
        chosen = {name: overrides[name] for name in ('pins', 'excludedPools', 'excludedTokens')}
        version = rules.policy_version(self.policy, chosen)
        previous = self.store.previous_evaluation(phase, now, self.policy['persistenceLookbackHours'])
        prior = self.store.previous_list(phase)
        incumbents = [entry['poolId'] for entry in prior['pools']] if prior else list(self.embedded)
        pinned = [pin['poolId'] for pin in overrides['pins']]
        shown = set(incumbents) | set(self.embedded) | set(pinned)
        baselines = self.store.token_baselines()
        service, spent = self._service()
        ctx = {'now': now, 'service': service, 'rpc': service._rpc(service.transport_factory()),
               'previous': previous['pools'] if previous else {}, 'baselines': baselines, 'tokens': {},
               'readings': {row['symbol_reading']: token for token, row in baselines.items() if row['symbol_reading']},
               'excludedPools': set(overrides['excludedPools']), 'excludedTokens': set(overrides['excludedTokens'])}
        floor = Decimal(self.policy['thresholds']['minVolume24hUsd'])
        coverage = {'source': 'geckoterminal_dex_pools_by_h24_volume', 'pages': 0, 'truncated': False,
                    'lastListedVolume24hUsd': None, 'stoppedBy': None, 'rejectedItems': 0}
        evaluations, screened, seen = [], [], set()
        deadline = time.monotonic() + self.max_seconds

        def consider(item):
            pool_id = item['poolId']
            if pool_id in seen:
                return
            seen.add(pool_id)
            if pool_id not in shown:
                reasons, _, _ = rules.screen(item['market'], item['listing'], item['listing']['createdAt'],
                                             self.policy, now=now)
                _, problem = rules.reference_side(item['market']['currencies'], self.policy)
                reasons = ([problem] if problem else []) + reasons
                if reasons:
                    screened.append({'poolId': pool_id, 'reasons': reasons})
                    return
            evaluations.append(self._evaluate(pool_id, item, relaxed=pool_id in incumbents, ctx=ctx))

        for number in range(1, self.policy['maxListingPages'] + 1):
            if time.monotonic() > deadline:
                coverage['stoppedBy'] = 'featured_time_budget_exhausted'
                break
            try:
                page = self.listing.page(number)
            except DataError as error:
                coverage['stoppedBy'] = str(error)
                break
            coverage['pages'] = number
            coverage['rejectedItems'] += len(page['rejected'])
            for item in page['items']:
                consider(item)
            volumes = [item['market']['volume24hUsd'] for item in page['items']]
            coverage['lastListedVolume24hUsd'] = volumes[-1] if volumes else None
            if page['returned'] < PAGE_SIZE or not volumes or volumes[-1] is None or Decimal(volumes[-1]) < floor:
                break
        else:
            coverage['truncated'] = True
        missing = sorted(shown - seen)
        for start in range(0, len(missing), MAX_MULTI):
            chunk = missing[start:start + MAX_MULTI]
            try:
                found = {item['poolId']: item for item in self.listing.multi(chunk)['items']}
            except DataError as error:
                coverage['multiStoppedBy'] = str(error)
                found = {}
            for pool_id in chunk:
                seen.add(pool_id)
                evaluations.append(self._evaluate(pool_id, found.get(pool_id), relaxed=pool_id in incumbents, ctx=ctx))
        evaluations.sort(key=lambda item: item['poolId'])
        # Without fresh data the pools already shown (pins, yesterday's list)
        # would fail a safety rule and drop out: that is a failed read, not a result.
        complete = coverage['stoppedBy'] is None and 'multiStoppedBy' not in coverage
        composed = listing = None
        if not complete:
            outcome = 'carried_over' if final else 'incomplete'
        elif previous is None:
            outcome = 'bootstrap'
        else:
            composed = rules.compose(evaluations, self.policy, previous_list=[{'poolId': pool_id} for pool_id in incumbents],
                                     pins=overrides['pins'], embedded=self.embedded)
            outcome = 'selected' if composed['status'] == 'current' else 'carried_over'
        by_id = {item['poolId']: item for item in evaluations}
        if outcome == 'selected':
            entries = []
            for entry in composed['pools']:
                item = by_id[entry['poolId']]
                entries.append({**entry, 'poolKey': item['poolKey'], 'tokens': item['tokens'],
                                'integrationClass': 'hookless_fixed_fee', 'identitySource': item['identitySource'],
                                'ageSource': item['ageSource'],
                                'rankInputs': None if entry['source'] != 'ranked' else {
                                    'rankApr': item['rankApr'], 'freshApr': item['freshApr'], 'prevApr': item['prevApr'],
                                    'volume24hUsd': item['volume24hUsd'],
                                    'reportedLiquidityUsd': item['reportedLiquidityUsd'],
                                    'referenceDepthUsd': item['referenceDepthUsd']}})
            listing = {'schemaVersion': 1, 'phase': phase, 'selectionDate': day.isoformat(), 'generatedAt': now,
                       'policyVersion': version, 'listId': rules.list_id(entries), 'pools': entries,
                       'rankedSwaps': composed['rankedSwaps'], 'coverage': coverage,
                       'previousRevision': prior['revision'] if prior else None}
        reasons = Counter(reason for item in evaluations for reason in item['reasons'])
        reasons.update(reason for item in screened for reason in item['reasons'])
        summary = {'outcome': outcome, 'selectionDate': day.isoformat(), 'policyVersion': version,
                   'candidates': len(seen), 'screened': len(screened), 'evaluated': len(evaluations),
                   'eligible': sum(1 for item in evaluations if item['eligible']),
                   'rejectedByReason': dict(sorted(reasons.items())), 'rpcItems': spent['items'],
                   'providerCalls': self.listing.calls, 'listId': listing['listId'] if listing else None}
        tokens = list(ctx['tokens'].values())
        listed = {token['address'] for entry in (listing['pools'] if listing else ()) for token in entry['tokens'] or ()}
        record = self.store.record(
            phase=phase, day=day, outcome=outcome, policy_version=version, started_at=started,
            finished_at=max(started, int(self.clock())),
            evaluation={'summary': summary, 'coverage': coverage, 'overrides': chosen,
                        'previousRunId': previous['runId'] if previous else None,
                        'evaluations': evaluations, 'screened': screened,
                        'composition': composed},
            listing=listing, tokens=tokens, listed_tokens=listed)
        return {**summary, **record}
