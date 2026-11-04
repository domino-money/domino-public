"""The daily featured-pools selection on Base and Arbitrum One, and its list's health, in shadow (launch round P3).

The same selection as Robinhood's (featured_selector), with the same rules module (featured_pools) and the same
store, scoped to the chain (featured_store, 055). What differs is where the facts come from:
- the listing is GeckoTerminal's, per chain and per Uniswap version (v3, then v4), at the selection's provider
  priority and pace, sharing the house's one allowance (featured_selector.PROVIDER_SPACING);
- the chain is read through the chain's V2 endpoints, every pool at one block (featured_chain_evidence), and only
  once the listing is complete: an incomplete listing spends no billed call;
- the APR is the site's estimate (pool_apr's method): the pool's fixed LP fee, less the protocol's share, on the
  provider's 24 h volume over its reported TVL, annualized.

Nothing is published: the list is recorded with phase `shadow` (read-v5 serves Robinhood's alone, and the store
refuses every serving step for another chain). The health check every ten minutes reads the latest shadow list's
pools with one /pools/multi call and one Multicall3 call, and records the conditions featured_live would act on
(featured_health, per chain): what would leave the list and why, never a repair, an override or a served revision.
"""
from collections import Counter
from decimal import Decimal
from fractions import Fraction
import time

from discovery import DataError
import featured_chain_evidence as evidence
from featured_chains import network_of
from featured_contract import rules_of
from featured_live import CONFIRM, PRICE_FALL
import featured_pools as rules
from featured_selector import Selector, _decimal_text, list_entry
from featured_store import utc_date
from gt_listing import MAX_MULTI, PAGE_SIZE, GeckoListing, pool_version
from pool_apr import METHOD, _render
from read_deadline import read_deadline
from selected_pools import CHAIN_SELECTED_POOLS
from v2_rpc import ChainReadRpc

PHASE = 'shadow'
# Billed calls one selection may spend, each of a batch and each read of the failover's proofs counted: the head,
# three or four Multicall3 calls and one eth_getCode per token the candidates name. Not measured (4 Nov 2026): tens,
# up to about 150 on Base, whose v4 lists many hooked memecoin pools. Past this the run is incomplete, never judged
# on part of a read.
SELECTION_CALLS = 512
# The health check: the head, one Multicall3 call and, once an hour, the listed tokens' code.
HEALTH_CALLS = 32
CHAIN_READ_SECONDS = 120
HEALTH_SECONDS = 600
TOKEN_CHECK_SECONDS = 3600
# A failed listing call leaves the provider's figures unknown, never a fault of the pool (#278).
MARKET_CONDITIONS = frozenset(('tvl_collapse', 'volume_collapse', 'apr_or_turnover_above_ceiling',
                               'estimate_unavailable'))


def lp_share(pool):
    """The LP's pips of every input unit: v4's LP fee on what its protocol fee leaves (ProtocolFeeLibrary); v3's fee
    less the protocol's 1/N of it. Called only for a fee the same in both directions (featured_pools)."""
    protocol, fee = pool['protocolFeeRaw'], Fraction(pool['currentLpFeePips'])
    if pool['dex'] == rules.DEX_V3:
        denominator = protocol & 0xf
        return fee if denominator == 0 else fee * (1 - Fraction(1, denominator))
    return fee * Fraction(1_000_000 - (protocol & 0xfff), 1_000_000)


def estimate(pool, market):
    """The site's APR estimate (pool_apr's method) for a chain pool: {status, feeAprEstimate24hPercent, reasons}.

    pool_apr reads read-v1's Robinhood response and dates a cached observation; here the figures come from the
    selection's own listing or the health check's call, minutes or seconds old, and the pool from one block."""
    reasons, key = [], pool['poolKey']
    if key['hooks'] != rules.ZERO:
        reasons.append('hooked_pool_unsupported')
    if key['feeMode'] == 'dynamic':
        reasons.append('dynamic_fee_unsupported')
    elif key['fee_pips'] != pool['currentLpFeePips']:
        reasons.append('fixed_fee_mismatch')
    protocol = rules.protocol_fee_reason(pool)
    if protocol:
        reasons.append(protocol)
    tvl = volume = None
    if market is None:
        reasons.append('market_unavailable')
    else:
        if (market['poolId'] != pool['poolId'] or market['currencies'] != pool['currencies']
                or sorted((market['baseToken'], market['quoteToken'])) != pool['currencies']):
            reasons.append('market_identity_mismatch')
        tvl, volume = market['reportedLiquidityUsd'], market['volume24hUsd']
        if tvl is None:
            reasons.append('missing_reported_tvl')
        elif Fraction(tvl) == 0:
            reasons.append('zero_reported_tvl')
        if volume is None:
            reasons.append('missing_volume24h')
    value = None
    if not reasons:
        value, render = _render(Fraction(volume) * lp_share(pool) / 1_000_000 * 365 * 100 / Fraction(tvl))
        if render:
            reasons.append(render)
    return {'status': 'unavailable' if reasons else 'available', 'feeAprEstimate24hPercent': value,
            'reasons': reasons, 'method': METHOD,
            'inputs': {'currentLpFeePips': pool['currentLpFeePips'], 'protocolFeeRaw': pool['protocolFeeRaw'],
                       'volume24hUsd': volume, 'reportedLiquidityUsd': tvl}}


def chain_entry(entry, item, chain_id):
    """A shadow list's pool: Robinhood's list entry, plus its chain, Uniswap version and, for v3, its address."""
    return {**list_entry(entry, item), 'chainId': chain_id, 'dex': item['dex'], 'address': item['address']}


class ChainSelector:
    # The provider's pace and its rate-limit waits are Robinhood's, to the call (featured_selector).
    _provider = Selector._provider

    def __init__(self, *, store, policy, chain, endpoints=None, public_data=None, listing=None, clock=time.time,
                 max_rpc_calls=SELECTION_CALLS, max_seconds=600, embedded=None, sleep=time.sleep,
                 monotonic=time.monotonic):
        facts = policy.get('chain')
        if facts is None or facts['chainId'] != chain.chainId or store.chain_id != chain.chainId:
            raise DataError('featured_chain_mismatch')
        if listing is None and public_data is None:
            raise DataError('featured_listing_unconfigured')
        self.store, self.policy, self.chain, self.endpoints, self.clock = store, policy, chain, endpoints, clock
        self.max_rpc_calls, self.max_seconds = max_rpc_calls, max_seconds
        self.embedded = list(CHAIN_SELECTED_POOLS.get(chain.chainId, ()) if embedded is None else embedded)
        self.sleep, self.monotonic, self.provider_at = sleep, monotonic, float('-inf')
        self.network = network_of(policy)
        self.listing = listing or GeckoListing(clock=clock, network=self.network, reserve=lambda: (
            public_data.reserve_provider_if_headroom(policy['listingProviderHeadroom'])))

    # ------------------------------------------------------------ reading
    def _configured(self):
        """Nothing is listed for a chain this process cannot read: the provider's calls would be spent for nothing."""
        if self.endpoints is None:
            raise DataError('v2_chain_rpc_not_configured')

    def _rpc(self, max_requests):
        """A current-state client on the chain's endpoints (Chainstack, then Alchemy), bounded in billed calls."""
        self._configured()
        return ChainReadRpc(self.endpoints, batch_reads=True, max_requests=max_requests)

    def _read(self, pool_ids, now):
        rpc = self._rpc(self.max_rpc_calls)
        with read_deadline(CHAIN_READ_SECONDS):
            found = evidence.read(self.chain, rpc, self.policy, pool_ids, now=now)
        return found, rpc.count

    def _check(self, pool_ids, tokens, now):
        """The health check's read: the pools' state in one Multicall3 call and, when asked, these tokens' code."""
        rpc = self._rpc(HEALTH_CALLS)
        with read_deadline(CHAIN_READ_SECONDS):
            found = evidence.pools(self.chain, rpc, pool_ids, now=now)
            codes = evidence.token_codes(rpc, tokens, found.block)
        return found, codes, rpc.count

    def _token(self, token, found, ctx):
        """TA-1 to TA-6 for a token, from the read's evidence, as featured_selector._token judges it."""
        if token in ctx['tokens']:
            return ctx['tokens'][token]
        item = dict(found.tokens.get(token) or {'address': token, 'code': False})
        baseline = ctx['baselines'].get(token)
        if baseline is not None:
            item['baselineCodeHash'] = baseline['listed_code_hash']
        if isinstance(item.get('symbol'), str) and item['symbol']:
            item['symbolReading'] = rules.symbol_reading(item['symbol'])
        item['reasons'] = rules.token_reasons(item, self.policy, published_readings=ctx['readings'],
                                              excluded_tokens=ctx['excludedTokens'])
        ctx['tokens'][token] = item
        return item

    def _depth(self, pool_id, reference, found):
        raw, reason = found.depths.get(pool_id, (None, 'not_read'))
        if raw is None:
            return {'status': 'unmeasurable', 'reason': reason}
        price = None
        if reference != rules.stable_of(self.policy):
            price = found.eth[0]
            if price is None:
                return {'status': 'unmeasurable', 'reason': 'eth_price_unavailable', 'raw': str(raw)}
        return {'status': 'measured', 'raw': str(raw),
                'usd': _decimal_text(rules.depth_usd(raw, reference, self.policy, price))}

    def _evaluate(self, pool_id, item, found, *, relaxed, ctx):
        """Everything the rules read about one pool, from the listing and the read, then the rules themselves."""
        market = item['market'] if item else None
        listing = item['listing'] if item else None
        candidate = {'poolId': pool_id, 'market': market, 'listing': listing,
                     'age': {'createdAt': listing['createdAt'] if listing else None}}
        dex = pool_version(pool_id)
        extra = {'poolKey': None, 'tokens': None, 'identitySource': None, 'sqrtPriceX96': None,
                 'initializeBlock': None, 'dex': dex, 'address': pool_id if dex == rules.DEX_V3 else None,
                 'ageSource': 'provider_pool_created_at' if listing and listing['createdAt'] is not None else None,
                 'block': evidence.snapshot(found.block), 'error': None}
        read = found.pools[pool_id]
        if 'pool' not in read:
            candidate['chain'] = {'error': read['error']}
            extra['error'] = read['error']
        else:
            pool = read['pool']
            candidate['chain'] = {'pool': pool, 'liquidity': read['liquidity']}
            # A v3 pool is its factory's CREATE2 address; a v4 key is the PositionManager's, hashed to the id.
            extra.update(poolKey=pool['poolKey'], sqrtPriceX96=pool['sqrtPriceX96'],
                         identitySource='v3_factory_address' if dex == rules.DEX_V3 else 'position_manager')
            candidate['estimate'] = estimate(pool, market)
            side, _ = rules.reference_side(pool['currencies'], self.policy)
            if side is not None:
                reference, other, major = side
                decimals = {token: entry['decimals'] for token, entry in self.policy['referenceTokens'].items()}
                symbols = {token: entry['symbol'] for token, entry in self.policy['referenceTokens'].items()}
                if not major:
                    token = self._token(other, found, ctx)
                    candidate['token'] = token
                    decimals[other], symbols[other] = token.get('decimals'), token.get('symbol')
                extra['tokens'] = [{'address': currency, 'symbol': symbols.get(currency),
                                    'decimals': decimals.get(currency)} for currency in pool['currencies']]
                candidate['depth'] = self._depth(pool_id, reference, found)
                candidate['providerPriceDeviation'] = rules.provider_price_deviation(listing, market, pool, decimals)
        result = rules.evaluate(candidate, self.policy, now=ctx['now'], previous=ctx['previous'], relaxed=relaxed,
                                excluded_pools=ctx['excludedPools'], excluded_tokens=ctx['excludedTokens'],
                                published_readings=ctx['readings'])
        return {**result, **extra, 'depth': candidate.get('depth'),
                'providerPriceDeviation': candidate.get('providerPriceDeviation')}

    def _context(self, now, overrides, previous):
        baselines = self.store.token_baselines()
        return {'now': now, 'previous': previous['pools'] if previous else {}, 'baselines': baselines, 'tokens': {},
                'readings': {row['symbol_reading']: token for token, row in baselines.items() if row['symbol_reading']},
                'excludedPools': set(overrides['excludedPools']), 'excludedTokens': set(overrides['excludedTokens'])}

    # ------------------------------------------------------------ selecting
    def select(self, *, now=None, final=True):
        """One shadow selection for the UTC date of `now`, as featured_selector.Selector.select makes it.

        A listing, a multi read or a chain read that did not complete makes the run `incomplete`, tried again
        while `final` is false; the final attempt of the day then keeps the previous list (`carried_over`).
        """
        now = int(self.clock()) if now is None else now
        day, started = utc_date(now), int(self.clock())
        if self.store.selection_done(PHASE, day):
            return {'outcome': 'already_done', 'selectionDate': day.isoformat()}
        self._configured()
        overrides = self.store.overrides(now)
        chosen = {name: overrides[name] for name in ('pins', 'excludedPools', 'excludedTokens')}
        version = rules.policy_version(self.policy, chosen)
        previous = self.store.previous_evaluation(PHASE, now, self.policy['persistenceLookbackHours'])
        prior = self.store.previous_list(PHASE)
        incumbents = [entry['poolId'] for entry in prior['pools']] if prior else list(self.embedded)
        pinned = [pin['poolId'] for pin in overrides['pins']]
        # Every pool the list could show today is evaluated, listed by the provider or not.
        shown = set(incumbents) | set(self.embedded) | set(pinned)
        floor = Decimal(self.policy['thresholds']['minVolume24hUsd'])
        coverage = {'source': 'geckoterminal_dex_pools_by_h24_volume', 'pages': 0, 'truncated': False,
                    'lastListedVolume24hUsd': None, 'stoppedBy': None, 'rejectedItems': 0, 'dexes': {}}
        items, screened, seen = {}, [], set()
        deadline = self.monotonic() + self.max_seconds

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
            items[pool_id] = item

        for label, _ in self.network.dexes:
            listed = {'pages': 0, 'truncated': False, 'lastListedVolume24hUsd': None, 'stoppedBy': None,
                      'rejectedItems': 0}
            coverage['dexes'][label] = listed
            for number in range(1, self.policy['maxListingPages'] + 1):
                if self.monotonic() > deadline:
                    listed['stoppedBy'] = 'featured_time_budget_exhausted'
                    break
                try:
                    page = self._provider(lambda: self.listing.page(number, label), deadline)
                except DataError as error:
                    listed['stoppedBy'] = str(error)
                    break
                listed['pages'] = number
                listed['rejectedItems'] += len(page['rejected'])
                for item in page['items']:
                    consider(item)
                volumes = [item['market']['volume24hUsd'] for item in page['items']]
                listed['lastListedVolume24hUsd'] = volumes[-1] if volumes else None
                if page['returned'] < PAGE_SIZE or not volumes or volumes[-1] is None or Decimal(volumes[-1]) < floor:
                    break
            else:
                listed['truncated'] = True
            coverage['pages'] += listed['pages']
            coverage['rejectedItems'] += listed['rejectedItems']
            coverage['truncated'] = coverage['truncated'] or listed['truncated']
            if listed['stoppedBy'] is not None:
                coverage['stoppedBy'] = listed['stoppedBy']
                break
        missing = sorted(shown - seen) if coverage['stoppedBy'] is None else []
        for start in range(0, len(missing), MAX_MULTI):
            chunk = missing[start:start + MAX_MULTI]
            try:
                found = {item['poolId']: item for item in
                         self._provider(lambda: self.listing.multi(chunk), deadline)['items']}
            except DataError as error:
                coverage['multiStoppedBy'] = str(error)
                break
            for pool_id in chunk:
                seen.add(pool_id)
                items[pool_id] = found.get(pool_id)
        # Without fresh figures the pools already shown would fail a safety rule and drop out: that is a failed
        # read, not a result. The chain is read only for a complete listing, so a cut listing bills nothing.
        complete = coverage['stoppedBy'] is None and 'multiStoppedBy' not in coverage
        evaluations, ctx, spent = [], None, 0
        if complete:
            try:
                found, spent = self._read(list(items), now)
            except DataError as error:
                coverage['chainStoppedBy'] = str(error)
                complete = False
            else:
                ctx = self._context(now, overrides, previous)
                evaluations = [self._evaluate(pool_id, items[pool_id], found, relaxed=pool_id in incumbents, ctx=ctx)
                               for pool_id in sorted(items)]
        composed = listing = None
        if not complete:
            outcome = 'carried_over' if final else 'incomplete'
        else:
            composed = rules.compose(evaluations, self.policy, previous_list=[{'poolId': pool_id} for pool_id in incumbents],
                                     pins=overrides['pins'], embedded=self.embedded)
            outcome = 'selected' if composed['status'] == 'current' else 'carried_over'
        by_id = {item['poolId']: item for item in evaluations}
        if outcome == 'selected':
            entries = [chain_entry(entry, by_id[entry['poolId']], self.chain.chainId) for entry in composed['pools']]
            listing = {'schemaVersion': 1, 'chainId': self.chain.chainId, 'phase': PHASE,
                       'selectionDate': day.isoformat(), 'generatedAt': now, 'policyVersion': version,
                       'listId': rules.list_id(entries), 'pools': entries, 'rankedSwaps': composed['rankedSwaps'],
                       'coverage': coverage, 'previousRevision': prior['revision'] if prior else None,
                       'rules': rules_of(self.policy), 'window': {'start': now - 86400, 'end': now}}
        reasons = Counter(reason for item in evaluations for reason in item['reasons'])
        reasons.update(reason for item in screened for reason in item['reasons'])
        if listing is not None:
            listing['evaluation'] = {'candidates': len(seen), 'shortlisted': len(evaluations),
                                     'eligible': sum(1 for item in evaluations if item['eligible']),
                                     'rejectedByReason': dict(sorted(reasons.items()))}
        summary = {'chainId': self.chain.chainId, 'outcome': outcome, 'selectionDate': day.isoformat(),
                   'policyVersion': version, 'candidates': len(seen), 'screened': len(screened),
                   'evaluated': len(evaluations), 'eligible': sum(1 for item in evaluations if item['eligible']),
                   'rejectedByReason': dict(sorted(reasons.items())), 'rpcItems': spent,
                   'providerCalls': self.listing.calls, 'listId': listing['listId'] if listing else None}
        tokens = list(ctx['tokens'].values()) if ctx else []
        listed = {token['address'] for entry in (listing['pools'] if listing else ()) for token in entry['tokens'] or ()}
        record = self.store.record(
            phase=PHASE, day=day, outcome=outcome, policy_version=version, started_at=started,
            finished_at=max(started, int(self.clock())),
            evaluation={'summary': summary, 'coverage': coverage, 'overrides': chosen,
                        'previousRunId': previous['runId'] if previous else None,
                        'evaluations': evaluations, 'screened': screened, 'composition': composed},
            listing=listing, tokens=tokens, listed_tokens=listed)
        return {**summary, **record}

    # ------------------------------------------------------------ health
    def _pool_health(self, entry, read, market, market_known, overrides):
        """(reasons the pool would leave at once for, conditions it shows now, conditions its data cannot judge
        now), from this check's own reads: featured_live._pool_health's conditions, without the collector."""
        pool_id, reasons, seen, unknown = entry['poolId'], [], set(), set()
        tokens = [token['address'] for token in entry.get('tokens') or ()]
        if pool_id in overrides['excludedPools'] or any(token in overrides['excludedTokens'] for token in tokens):
            reasons.append('excluded_by_owner')
        if 'pool' not in read:
            # The listed pool no longer reads as itself: nothing it shows can be trusted.
            reasons.append('pool_integration_unsupported')
            return reasons, seen, unknown
        pool = read['pool']
        if pool['poolKey']['fee_pips'] != pool['currentLpFeePips']:
            reasons.append('fixed_fee_mismatch')
        protocol = rules.protocol_fee_reason(pool)
        if protocol:
            reasons.append(protocol)
        if not market_known:
            unknown |= MARKET_CONDITIONS
        else:
            found = estimate(pool, market)
            if found['status'] != 'available':
                seen.add('estimate_unavailable')
            if market is not None:
                tvl, volume = rules._decimal(market['reportedLiquidityUsd']), rules._decimal(market['volume24hUsd'])
                apr = rules._decimal(found['feeAprEstimate24hPercent'])
                seen |= rules.collapses(volume, tvl, self.policy)
                ceiling, turnover = self.policy['thresholds']['maxAprPercent'], self.policy['thresholds']['maxTurnover24h']
                # A policy with no ceiling (null) watches neither.
                if ((ceiling is not None and apr is not None and apr > Decimal(ceiling)) or
                        (turnover is not None and tvl and volume is not None and volume / tvl > Decimal(turnover))):
                    seen.add('apr_or_turnover_above_ceiling')
        start, reference = entry.get('selectionSqrtPriceX96'), entry.get('reference')
        if start and reference in pool['currencies']:
            ratio = Fraction(int(pool['sqrtPriceX96']) ** 2, int(start) ** 2)   # currency1 per currency0, now / then
            other = ratio if reference == pool['currencies'][1] else 1 / ratio
            if other < PRICE_FALL:
                seen.add('price_fall')
        return reasons, seen, unknown

    def health(self, now, *, tokens=False):
        """The latest shadow list's health now: one /pools/multi call, one Multicall3 call and, with `tokens`, the
        listed tokens' code. Records the conditions it sees (featured_health) and reports the pools the live list
        would withdraw; withdraws, repairs and serves nothing."""
        self._configured()
        listed = self.store.previous_list(PHASE)
        if listed is None or not listed['pools']:
            self.store.observe_health({}, now)
            return {'status': 'idle'}
        entries = {entry['poolId']: entry for entry in listed['pools']}
        overrides = self.store.overrides(now)
        baselines = self.store.token_baselines() if tokens else {}
        listed_tokens = sorted({token['address'] for entry in entries.values() for token in entry.get('tokens') or ()
                                if token['address'] in baselines})
        try:
            # One call at the selection's priority, never waited for: a refused allowance or a 429 leaves the
            # provider's figures unknown for this check (#278), and the next check asks again.
            answer = self.listing.multi(sorted(entries))
            markets, market_reason = {item['poolId']: item['market'] for item in answer['items']}, None
        except DataError as error:
            markets, market_reason = {}, str(error)
        try:
            found, codes, spent = self._check(sorted(entries), listed_tokens, now)
        except DataError as error:
            # A check that read nothing clears nothing and counts nothing.
            return {'status': 'unread', 'reason': str(error), 'revision': listed['revision']}
        immediate, seen, unknown = {}, {}, {}
        for pool_id, entry in entries.items():
            reasons, conditions, unjudged = self._pool_health(entry, found.pools[pool_id], markets.get(pool_id),
                                                              market_reason is None, overrides)
            if reasons:
                immediate[pool_id] = reasons[0]
            seen[pool_id], unknown[pool_id] = conditions, unjudged
        # TA-5, hourly: a listed token whose code differs from when it was first listed.
        changed = {token for token in listed_tokens
                   if codes[token].get('codeHash') != baselines[token]['listed_code_hash']}
        for pool_id, entry in entries.items():
            if any(token['address'] in changed for token in entry.get('tokens') or ()):
                immediate.setdefault(pool_id, 'token_code_changed')
        state = self.store.observe_health(seen, now, unknown)
        confirmed = {}
        for (pool_id, condition), (first_seen, checks) in sorted(state.items()):
            if condition not in seen.get(pool_id, ()):
                continue
            hold, owners_too = CONFIRM[condition]
            if (checks >= 2 and now - first_seen >= hold
                    and (owners_too or entries[pool_id]['source'] not in ('pinned', 'manual'))):
                confirmed.setdefault(pool_id, condition)
        withdrawn = {**confirmed, **immediate}
        return {'status': 'would_withdraw' if withdrawn else 'healthy', 'revision': listed['revision'],
                'wouldWithdraw': dict(sorted(withdrawn.items())),
                'conditions': {pool_id: sorted(conditions) for pool_id, conditions in sorted(seen.items()) if conditions},
                'marketReason': market_reason, 'tokensChanged': sorted(changed),
                'block': evidence.snapshot(found.block), 'rpcItems': spent}
